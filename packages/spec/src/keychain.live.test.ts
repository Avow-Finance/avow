import { P256 } from 'ox'
import { type Address, createPublicClient, http, keccak256, stringToHex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { keychainSignatureCheck, signForAccount, tempoKeychainCheck } from './keychain.js'

/**
 * Asks Tempo's own `verifyKeychainAdmin` on Moderato, the check the lock will make, and confirms
 * the offline rule gives the same answer every time. It reads only, needs no funds and no saved
 * key, and runs when AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const RPC = 'https://rpc.moderato.tempo.xyz'
const WEBAUTHN = { rpId: 'avow.finance', origin: 'https://avow.finance' }

describe.skipIf(!live)("Tempo's verifyKeychainAdmin on Moderato", () => {
  const client = createPublicClient({
    chain: tempoModerato,
    transport: http(RPC, { retryCount: 5, retryDelay: 500 }),
  })
  const onChain = tempoKeychainCheck(client)
  const offline = keychainSignatureCheck(() => false)
  const digest = keccak256(stringToHex(`avow keychain live check ${Date.now()}`))
  const otherDigest = keccak256(stringToHex(`avow keychain live check, another lock ${Date.now()}`))

  const roots = {
    secp256k1: () => Account.fromSecp256k1(generatePrivateKey()),
    passkey: () => Account.fromHeadlessWebAuthn(P256.randomPrivateKey(), WEBAUTHN),
  }

  for (const [name, make] of Object.entries(roots)) {
    it(`${name} root: wrapped passes, bare, other-account and other-digest signatures fail`, async () => {
      const root = make()
      const account = root.address as Address
      const other = Account.fromSecp256k1(generatePrivateKey()).address as Address
      const cases = [
        {
          label: 'wrapped',
          signer: account,
          d: digest,
          sig: await signForAccount(account, digest, root),
          want: true,
        },
        {
          label: 'bare',
          signer: account,
          d: digest,
          sig: await root.sign({ hash: digest }),
          want: false,
        },
        {
          label: 'other account',
          signer: other,
          d: digest,
          sig: await signForAccount(account, digest, root),
          want: false,
        },
        {
          label: 'envelope for another account',
          signer: account,
          d: digest,
          sig: await signForAccount(other, digest, root),
          want: false,
        },
        {
          label: 'other digest',
          signer: account,
          d: otherDigest,
          sig: await signForAccount(account, digest, root),
          want: false,
        },
      ]
      for (const c of cases) {
        const args = { signer: c.signer, digest: c.d, signature: c.sig }
        expect(await onChain(args), `${name} ${c.label} on chain`).toBe(c.want)
        expect(await offline(args), `${name} ${c.label} offline`).toBe(c.want)
      }
    }, 120_000)
  }
})
