import {
  type Parsed,
  parseSupplierProfile,
  registrationDigest,
  registrationDomain,
  SANDBOX_PATHS,
  type SandboxDeployment,
  type SupplierProfile,
  signSupplierRegistration,
  supplierRegistrationBody,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual } from 'viem'
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import type { Account as TempoAccount } from 'viem/tempo'
import { AvowApiError, avowRequests, rootRequestKey, signingRequestKey } from '../http.js'
import { fundFees, type SandboxClient } from './fees.js'
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
 * Completes a supplier registration the business's administrator started in the console. The
 * console signs the registration of this agent's signing key with the account's root key, and the
 * agent signs it with the signing key, proving it holds the key, and sends it to Avow signed with
 * that key. The supplier item it keeps is the one quoting and accepting jobs read. The signing key
 * pays its own fees, so Moderato's faucet funds them first.
 */
export async function completeSupplierRegistration(m: {
  store: SandboxStore
  deployment: Pick<SandboxDeployment, 'chainId' | 'apiUrl' | 'factory'>
  business: StoredBusiness
  client: SandboxClient
  signingKey: Hex
  /** The registration and the account's signature on it, as the approval carried them. */
  partial: { registration: Record<string, unknown>; accountSignature: Hex }
  fetch?: typeof fetch
}): Promise<SupplierItem> {
  const signer = privateKeyToAccount(m.signingKey)
  const parsed = supplierRegistrationBody.safeParse({
    registration: m.partial.registration,
    accountSignature: m.partial.accountSignature,
    signingKeySignature: '0x00',
  })
  if (!parsed.success) throw new Error("The supplier registration in the approval doesn't read")
  const r = parsed.data.registration
  if (
    !isAddressEqual(r.signingKey, signer.address) ||
    !isAddressEqual(r.account, m.business.account)
  ) {
    throw new Error(
      "The supplier registration names another key or business, so this agent won't sign it.",
    )
  }
  const hash = registrationDigest(registrationDomain(m.deployment.chainId, m.deployment.factory), {
    kind: 'supplier',
    registration: r,
  })
  const body = {
    registration: r,
    accountSignature: m.partial.accountSignature,
    signingKeySignature: await signer.sign({ hash }),
  }
  const profile = await avowRequests({
    baseUrl: m.deployment.apiUrl,
    key: signingRequestKey(signer),
    retryFor: 60n,
    ...(m.fetch ? { fetch: m.fetch } : {}),
  })({
    domain: { chainId: m.deployment.chainId, verifyingContract: m.deployment.factory },
    path: SANDBOX_PATHS.suppliers,
    body,
    read: (json): Parsed<SupplierProfile> => {
      const read = parseSupplierProfile(json)
      if (!read.ok) return read
      const p = read.value
      return isAddressEqual(p.account, m.business.account) &&
        isAddressEqual(p.signingKey, signer.address)
        ? read
        : { ok: false, reason: 'message.invalid' }
    },
  })
  const item: SupplierItem = { signingKey: m.signingKey, profile, business: m.business }
  await saveSupplierItem(m.store, item)
  await fundFees(m.client, signer.address)
  return item
}

/**
 * The business's supplier item, registering the business as a supplier first when this folder has
 * none for it. A key already made for the same account is registered again, since Avow answers a
 * repeat with the supplier it holds, and anything else gets a new key. Registering takes the root
 * key, which `openRoot` opens. The signing key sends the business's acceptances itself, so whenever
 * it holds too little for its fees Moderato's faucet funds them, which costs one balance read once
 * it's funded. A registration Avow refuses says plainly why.
 */
export async function ensureSandboxSupplier(m: {
  store: SandboxStore
  business: StoredBusiness
  deployment: Pick<SandboxDeployment, 'chainId' | 'apiUrl' | 'factory'>
  client: SandboxClient
  openRoot: () => Promise<TempoAccount.RootAccount>
  log: (line: string, kind?: 'wait' | 'done' | 'detail') => void
  fetch?: typeof fetch
}): Promise<SupplierItem> {
  const held = await loadSupplierItem(m.store)
  if (held && madeFor(held, m.business)) {
    await fundFees(m.client, held.profile.signingKey)
    return held
  }
  m.log('Giving your business a signing key to quote jobs', 'wait')
  m.log(
    "Your business's signing key is made on this machine and stays here. It quotes and accepts jobs and reports charges for your business, and it can't move your business's own money or change its authority.",
    'detail',
  )
  const sameAccount = held !== null && isAddressEqual(held.business.account, m.business.account)
  const signingKey = sameAccount ? held.signingKey : generatePrivateKey()
  let profile: SupplierProfile
  try {
    profile = await registerSandboxSupplier({
      deployment: m.deployment,
      root: await m.openRoot(),
      signingKey: privateKeyToAccount(signingKey),
      payee: m.business.account,
      ...(m.fetch ? { fetch: m.fetch } : {}),
    })
  } catch (error) {
    const taken =
      error instanceof Error &&
      error.cause instanceof AvowApiError &&
      error.cause.reason === 'sandbox.taken'
    if (!taken) throw error
    throw new Error(
      "Avow already holds another signing key for your business as a supplier, and .avow/supplier.json doesn't hold that key, so your business can't take jobs. Put back the supplier.json that holds it, or set up a fresh business with npm run fresh, which registers a key of its own.",
      { cause: error },
    )
  }
  const item: SupplierItem = { signingKey, profile, business: m.business }
  await saveSupplierItem(m.store, item)
  m.log('Your business can quote jobs, with a signing key of its own', 'done')
  m.log(`Its signing key is ${profile.signingKey}.`, 'detail')
  // The signing key sends the business's acceptances and pays their fees itself, so Moderato's
  // faucet funds its fees as it funds the account's, and tops them up whenever they run low.
  await fundFees(m.client, profile.signingKey)
  return item
}
