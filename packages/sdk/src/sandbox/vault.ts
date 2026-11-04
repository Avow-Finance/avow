import { type Address, bytesToHex, type Hex, hexToBytes, isHex } from 'viem'

/**
 * The business's root key, sealed under a passphrase the developer sets. A process that reads the
 * sealed file gets the key only by finding the passphrase, which PBKDF2 at 600,000 rounds makes slow
 * to guess. It uses the platform's Web Crypto, PBKDF2 with SHA-256 to stretch the passphrase and
 * AES-256-GCM to seal, so it runs the same in Node and in a browser.
 */
export interface SealedKey {
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt: Hex
  cipher: 'AES-256-GCM'
  iv: Hex
  ciphertext: Hex
}

/** The fewest characters a passphrase can have. */
export const MIN_PASSPHRASE = 10

/** How hard the passphrase is stretched, as OWASP's 2023 guidance sets for PBKDF2 with SHA-256. */
const ITERATIONS = 600_000

/** What the sealed key is bound to, so a sealed key can't be passed off as another account's. */
const context = (account: Address) =>
  new TextEncoder().encode(`avow-sandbox-business-key:${account.toLowerCase()}`)

async function keyFrom(passphrase: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Seals a private key under a passphrase, for the business account at `account`. */
export async function sealKey(
  privateKey: Hex,
  passphrase: string,
  account: Address,
): Promise<SealedKey> {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new RangeError(`The passphrase needs at least ${MIN_PASSPHRASE} characters`)
  }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await keyFrom(passphrase, salt, ITERATIONS)
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: context(account) },
    key,
    hexToBytes(privateKey),
  )
  return {
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: bytesToHex(salt),
    cipher: 'AES-256-GCM',
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(sealed)),
  }
}

/** Opens a sealed key with its passphrase, or throws when the passphrase doesn't open it. */
export async function openKey(
  sealed: SealedKey,
  passphrase: string,
  account: Address,
): Promise<Hex> {
  let opened: ArrayBuffer
  try {
    const key = await keyFrom(passphrase, hexToBytes(sealed.salt), sealed.iterations)
    opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(sealed.iv), additionalData: context(account) },
      key,
      hexToBytes(sealed.ciphertext),
    )
  } catch {
    throw new Error("That passphrase doesn't open the business's key")
  }
  return bytesToHex(new Uint8Array(opened))
}

/** Whether some JSON is a sealed key in the form `sealKey` writes. */
export function isSealedKey(v: unknown): v is SealedKey {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    s.kdf === 'PBKDF2-SHA256' &&
    s.cipher === 'AES-256-GCM' &&
    typeof s.iterations === 'number' &&
    Number.isInteger(s.iterations) &&
    s.iterations >= 100_000 &&
    [s.salt, s.iv, s.ciphertext].every((h) => typeof h === 'string' && isHex(h))
  )
}
