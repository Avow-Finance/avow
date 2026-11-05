import {
  type Parsed,
  parseSupplierProfile,
  SANDBOX_PATHS,
  type SandboxDeployment,
  type SupplierProfile,
  signSupplierRegistration,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual } from 'viem'
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import type { Account as TempoAccount } from 'viem/tempo'
import { AvowApiError, avowRequests, rootRequestKey } from '../http.js'
import { fundFees, type SandboxClient } from './business.js'
import { readBusiness, readJson, type SandboxStore, type StoredBusiness, write } from './store.js'

/**
 * The business as a supplier of jobs. Its signing key is made on this machine and kept beside the
 * agent's key, outside the passphrase, since the job process signs with it: the business's quotes,
 * its acceptances of a customer's reserve and its requests to the test customer. It can't move the
 * business's money or change its authority, which only the root key does.
 */
export interface SupplierItem {
  signingKey: Hex
  /** The supplier as Avow registered it, under the business's account. */
  profile: SupplierProfile
  /** The business it was registered for, on the deployment it was registered on. */
  business: StoredBusiness
}

/** How long a registration the two keys sign stays valid, well inside the API's five minutes. */
const REGISTRATION_VALIDITY = 120n
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))
const isKey = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v)

/** The supplier's item, or null when the business has no signing key yet or the file doesn't read. */
export async function loadSupplierItem(store: SandboxStore): Promise<SupplierItem | null> {
  const text = await store.read('supplier')
  if (text === null) return null
  const json = readJson(text, 'supplier')
  const business = readBusiness(json.business)
  const profile = parseSupplierProfile(json.profile)
  if (!business || !profile.ok || !isKey(json.signingKey)) return null
  // The file names the key's address too, so a key that isn't the registered one never signs.
  const signingKey = json.signingKey
  if (!isAddressEqual(privateKeyToAccount(signingKey).address, profile.value.signingKey)) {
    return null
  }
  return { signingKey, profile: profile.value, business }
}

const saveSupplierItem = (store: SandboxStore, item: SupplierItem) => write(store, 'supplier', item)

/** Whether a supplier item was made for this business, on the deployment it runs on now. */
const madeFor = (item: SupplierItem, business: StoredBusiness) =>
  item.business.chainId === business.chainId &&
  item.business.apiUrl === business.apiUrl &&
  isAddressEqual(item.business.account, business.account) &&
  item.business.businessId === business.businessId &&
  isAddressEqual(item.profile.account, business.account)

/**
 * Registers the business with Avow's sandbox as a supplier, under its own account, with the given
 * signing key and its account as the payout address. The root key and the signing key both sign
 * the registration, and the root key signs the request around it, naming the factory. Avow answers
 * a repeat of the same three addresses with the supplier it holds, and the answer has to name them.
 */
export async function registerSandboxSupplier(deps: {
  deployment: Pick<SandboxDeployment, 'chainId' | 'apiUrl' | 'factory'>
  root: TempoAccount.RootAccount
  signingKey: PrivateKeyAccount
  payee: Address
  now?: () => bigint
  fetch?: typeof fetch
}): Promise<SupplierProfile> {
  const { deployment, root, signingKey, payee } = deps
  const body = await signSupplierRegistration({
    chainId: deployment.chainId,
    factory: deployment.factory,
    audience: deployment.apiUrl,
    account: root.address,
    payee,
    rootKey: root,
    signingKey,
    now: (deps.now ?? systemClock)(),
    validity: REGISTRATION_VALIDITY,
  })
  const read = (json: unknown): Parsed<SupplierProfile> => {
    const profile = parseSupplierProfile(json)
    if (!profile.ok) return profile
    const p = profile.value
    const named =
      isAddressEqual(p.account, root.address) &&
      isAddressEqual(p.payee, payee) &&
      isAddressEqual(p.signingKey, signingKey.address)
    return named ? profile : { ok: false, reason: 'message.invalid' }
  }
  return avowRequests({
    baseUrl: deployment.apiUrl,
    key: rootRequestKey(root),
    retryFor: 120n,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  })({
    domain: { chainId: deployment.chainId, verifyingContract: deployment.factory },
    path: SANDBOX_PATHS.suppliers,
    body,
    read,
  }).catch((error: unknown) => {
    if (!(error instanceof AvowApiError)) throw error
    throw new Error(
      `Avow's sandbox didn't register your business as a supplier (${error.reason ?? 'no answer'}): ${error.message}`,
      { cause: error },
    )
  })
}

/**
 * The business's supplier item, registering the business as a supplier first when this folder has
 * none for it. A key already made for the same account is registered again, since Avow answers a
 * repeat with the supplier it holds, and anything else gets a new key. Registering takes the root
 * key, which `openRoot` opens. A newly registered signing key gets its fees from Moderato's faucet,
 * since it sends the business's acceptances itself.
 */
export async function ensureSandboxSupplier(m: {
  store: SandboxStore
  business: StoredBusiness
  deployment: Pick<SandboxDeployment, 'chainId' | 'apiUrl' | 'factory'>
  client: SandboxClient
  openRoot: () => Promise<TempoAccount.RootAccount>
  log: (line: string) => void
  fetch?: typeof fetch
}): Promise<SupplierItem> {
  const held = await loadSupplierItem(m.store)
  if (held && madeFor(held, m.business)) return held
  m.log(
    'Your business needs a signing key of its own to quote and accept jobs. It stays on this machine and can move no money.',
  )
  const sameAccount = held !== null && isAddressEqual(held.business.account, m.business.account)
  const signingKey = sameAccount ? held.signingKey : generatePrivateKey()
  const profile = await registerSandboxSupplier({
    deployment: m.deployment,
    root: await m.openRoot(),
    signingKey: privateKeyToAccount(signingKey),
    payee: m.business.account,
    ...(m.fetch ? { fetch: m.fetch } : {}),
  })
  const item: SupplierItem = { signingKey, profile, business: m.business }
  await saveSupplierItem(m.store, item)
  m.log(`Registered your business as a sandbox supplier, signing with ${profile.signingKey}.`)
  // The signing key sends the business's acceptances and pays their fees itself, so Moderato's
  // faucet funds its fees as it funds the account's.
  await fundFees(m.client, profile.signingKey)
  return item
}
