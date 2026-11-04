import { type AvowDomain, formatUsd, type SandboxDeployment } from '@avow-finance/spec'
import { readBacking } from '@avow-finance/verifier'
import { type Address, type Hex, isAddressEqual } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { rootRequestKey } from '../http.js'
import { removeSupplierCall } from '../lock.js'
import { moderatoClient } from '../moderato.js'
import { sendOwn } from '../send.js'
import {
  checkSession,
  platformSession,
  platformStore,
  type SandboxSession,
  sessionReporter,
} from './agent.js'
import { createSandboxBusiness, type SandboxBusinessStep, type SandboxClient } from './business.js'
import { type BusinessItem, loadBusinessItem, saveBusinessItem } from './business-store.js'
import { loadSandboxDeployment, madeOn } from './deployment.js'
import { approvedSuppliers, revokeOtherAgentKeys } from './keys.js'
import { enrollSandboxAgent, sandboxMandate } from './mandate.js'
import { SANDBOX_SCREEN_URL } from './session.js'
import {
  type AgentItem,
  loadAgentItem,
  loadCommitments,
  type SandboxStore,
  type SandboxSupplier,
  saveAgentItem,
  saveCommitments,
} from './store.js'
import { checkSuppliers, connectSupplier } from './suppliers.js'
import { micros, toDollars } from './terms.js'
import { type OpenVault, openVault, sealKey } from './vault.js'

/** What a business gives its agent, as `business.ts` in the starter says it. */
export interface SandboxBusinessConfig {
  /** The name the business registers under. */
  name: string
  /** Two capital letters, `US` when left out. */
  country?: string
  /** The most the agent can hold in bookings at once, in dollars. Avow refuses a booking past it. */
  authority: number
  /** The suppliers the agent may book with, and no others. */
  suppliers: readonly SandboxSupplier[]
}

/** How the business's side asks the person running it. */
export interface SandboxPrompts {
  /** Asks for a new passphrase the first time, which seals the business's key. */
  newPassphrase(): Promise<string>
  /** Asks for the passphrase that opens the business's key. */
  passphrase(): Promise<string>
  /** Asks a yes or no question, before the business signs anything new. */
  confirm(question: string): Promise<boolean>
}

export interface PrepareSandboxBusinessOptions {
  config: SandboxBusinessConfig
  prompts: SandboxPrompts
  /** Where the business keeps its sealed key and its agent's item. The `.avow` folder in Node. */
  store?: SandboxStore
  screenUrl?: string
  deployment?: SandboxDeployment
  /** The session an authority change is reported to, signed by the business's root key. */
  session?: SandboxSession | null
  log?: (line: string) => void
  fetch?: typeof fetch
}

/** Where the business stands once it's prepared. */
export interface PreparedSandboxBusiness {
  businessId: string
  account: Address
  lock: Address
  /** The authority the agent holds now, in dollars. */
  authority: number
  suppliers: string[]
  mandateHash: Hex
  /** Whether this call signed a new mandate. */
  signed: boolean
}

const DAY = 86_400n
/** A mandate expiring sooner than this is replaced, once the person agrees. */
const MANDATE_MARGIN = 3600n
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

const stepLine = (s: SandboxBusinessStep): string => {
  switch (s.step) {
    case 'fees':
      return s.hashes.length > 0
        ? "Funded the account's fees from Moderato's faucet."
        : 'The account holds enough for its fees.'
    case 'lock':
      return s.createdIn
        ? `Created the business's lock at ${s.lock}.`
        : `The business's lock is at ${s.lock}.`
    case 'registered':
      return `Registered sandbox business ${s.businessId}. Avow is sending ${formatUsd(s.amount)} of test dollars.`
    case 'funded':
      return `The test dollars arrived. The business holds ${formatUsd(s.balance)}.`
  }
}

const authorityText = (cap: bigint, suppliers: readonly string[]) =>
  `${formatUsd(cap)} at once, ${suppliers.join(', ')} only`

/**
 * The business's side of the sandbox, which only the runner calls. The first time, it asks for a
 * passphrase and seals a new root key under it, registers the business with Avow's sandbox, waits
 * for its test dollars and creates its lock. Whenever the authority or the suppliers in the config
 * differ from the agent's mandate, or the mandate is about to expire, it asks before signing a new
 * mandate, then asks for the passphrase. A transaction of its own revokes every other agent key the
 * account's keychain still authorizes, read from the chain, so nothing the agent can write keeps a
 * key live. Then a new agent key goes on the account, and each supplier the lock approves that the
 * new mandate doesn't name comes off, each in its own transaction. The root key is opened only for
 * those signatures, and never stored or passed on in the clear.
 */
export async function prepareSandboxBusiness(
  options: PrepareSandboxBusinessOptions,
): Promise<PreparedSandboxBusiness> {
  const { config, prompts } = options
  const log = options.log ?? ((line: string) => console.log(line))
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  if (typeof config.name !== 'string' || config.name.trim() === '' || config.name.length > 200) {
    throw new RangeError("The business's name has to be 1 to 200 characters")
  }
  const country = config.country ?? 'US'
  if (!/^[A-Z]{2}$/.test(country)) throw new RangeError('The country has to be two capital letters')
  const authority = micros(config.authority, 'authority')
  const suppliers = checkSuppliers(config.suppliers)
  const ids = suppliers.map((s) => s.id)
  const store = options.store ?? platformStore()
  if (!store) throw new Error('The business needs a store. In Node it uses the .avow folder.')
  const screenUrl = options.screenUrl ?? SANDBOX_SCREEN_URL
  const deployment = options.deployment ?? (await loadSandboxDeployment(screenUrl, send))
  const client: SandboxClient = moderatoClient(deployment.rpcUrl)

  // The vault is open only inside this call, once the person typed the passphrase.
  let vault: OpenVault | null = null
  let item: BusinessItem | null = await loadBusinessItem(store)
  if (!item) {
    if ((await store.read('agent')) !== null) {
      throw new Error(
        "The business's file is gone from .avow but its agent's file is there, so the business's key is missing. Restore .avow/business.json, or start over with npm run fresh.",
      )
    }
    log(
      "Your business needs a key of its own. It's sealed on this machine under a passphrase you choose.",
    )
    const passphrase = await prompts.newPassphrase()
    const privateKey = generatePrivateKey()
    const account = Account.fromSecp256k1(privateKey).address
    const key = await sealKey(privateKey, passphrase, account)
    item = { account, key, record: null, business: null }
    await saveBusinessItem(store, item)
    vault = await openVault(key, passphrase, account)
  }
  const sealed = item
  const open = async (): Promise<OpenVault> => {
    vault ??= await openVault(sealed.key, await prompts.passphrase(), sealed.account)
    return vault
  }
  const rootOf = (v: OpenVault) => {
    const root = Account.fromSecp256k1(v.privateKey)
    if (!isAddressEqual(root.address, sealed.account)) {
      throw new Error("The business's key doesn't match its account")
    }
    return root
  }

  let business = item.business
  if (!business || !madeOn(business, deployment)) {
    log('Setting up your sandbox business on Tempo testnet. The first time takes a minute or two.')
    const v = await open()
    // Every agent key goes on the account after this block, so the runner reads them from here on.
    const fromBlock = await client.getBlockNumber()
    const made = await createSandboxBusiness({
      deployment,
      client,
      root: rootOf(v),
      legalName: config.name,
      country,
      onStep: (s) => log(stepLine(s)),
      fetch: send,
    })
    business = {
      chainId: deployment.chainId,
      apiUrl: deployment.apiUrl,
      factory: deployment.factory,
      token: deployment.token,
      account: made.account,
      lock: made.lock,
      businessId: made.businessId,
    }
    const record = await v.seal(
      'record',
      new TextEncoder().encode(JSON.stringify({ fromBlock: fromBlock.toString() })),
    )
    item = { ...item, record, business }
    await saveBusinessItem(store, item)
    // Commitments and an agent from another deployment belong to another lock.
    await saveCommitments(store, [])
  }
  const lock = business.lock
  const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: lock }
  let agent: AgentItem | null = await loadAgentItem(store)
  if (agent && !isAddressEqual(agent.business.lock, lock)) agent = null

  const current = agent?.mandate.message
  const changed =
    !current ||
    current.capOpenReserves !== authority ||
    current.capPerCommitment !== authority ||
    [...current.suppliers].sort().join() !== [...ids].sort().join()
  const expiring = current !== undefined && current.expiry <= systemClock() + MANDATE_MARGIN
  const prepared = (a: AgentItem, signed: boolean): PreparedSandboxBusiness => ({
    businessId: a.business.businessId,
    account: a.business.account,
    lock,
    authority: toDollars(a.mandate.message.capOpenReserves),
    suppliers: [...a.mandate.message.suppliers],
    mandateHash: a.mandateHash,
    signed,
  })
  if (agent && !changed && !expiring) {
    // Supplier URLs aren't in the mandate, so a changed URL needs no new signature.
    if (JSON.stringify(agent.suppliers) !== JSON.stringify(suppliers)) {
      agent = { ...agent, suppliers }
      await saveAgentItem(store, agent)
    }
    return prepared(agent, false)
  }

  const question = `${
    changed ? 'Sign a new mandate' : "Your agent's mandate expires within the hour. Sign a new one"
  } as ${config.name}: ${authorityText(authority, ids)}? It revokes every other agent key on the account. y/N`
  if (!(await prompts.confirm(question))) {
    if (agent && current) {
      log(`Kept the current mandate: ${authorityText(current.capOpenReserves, current.suppliers)}.`)
      return prepared(agent, false)
    }
    throw new Error(
      "No mandate was signed, so your agent can't book yet. Run npm start again to sign one.",
    )
  }
  const v = await open()
  const root = rootOf(v)
  if (!item.record) {
    throw new Error(
      "The business's sealed record is missing from .avow/business.json, so the runner can't tell which agent keys to revoke. Restore the file, or start over with npm run fresh.",
    )
  }
  const { fromBlock } = JSON.parse(
    new TextDecoder().decode(await v.open('record', item.record)),
  ) as {
    fromBlock: string
  }
  const since = BigInt(fromBlock)

  // The revocation goes first, in a transaction of its own, so nothing after it can stop it.
  const live = await revokeOtherAgentKeys({ client, root, fromBlock: since })
  if (live.length > 0) {
    log(
      `Revoked ${live.length} agent key${live.length === 1 ? '' : 's'} the account's keychain still authorized.`,
    )
  }
  const profiles = await Promise.all(
    suppliers.map(async (s) => (await connectSupplier(s, send)).profile),
  )
  const agentPrivateKey = generatePrivateKey()
  const agentKey = Account.fromSecp256k1(agentPrivateKey, { access: root.address })
  const now = systemClock()
  const mandate = sandboxMandate({
    businessId: business.businessId,
    agentId: `agt_${agentKey.accessKeyAddress.slice(2, 12).toLowerCase()}`,
    account: root.address,
    agentKey: agentKey.accessKeyAddress,
    suppliers: ids,
    token: deployment.token,
    capPerCommitment: authority,
    capOpenReserves: authority,
    expiry: now + 7n * DAY,
  })
  const enrolled = await enrollSandboxAgent({
    deployment,
    client,
    root,
    agent: agentKey,
    lock,
    mandate,
    suppliers: profiles,
    fetch: send,
  })
  const next: AgentItem = {
    agentKey: agentPrivateKey,
    business,
    mandate: enrolled.mandate,
    mandateHash: enrolled.mandateHash,
    keyAuthorizedIn: enrolled.keyAuthorizedIn,
    suppliers,
  }
  await saveAgentItem(store, next)
  log(`Signed and enrolled your agent's mandate: ${authorityText(authority, ids)}.`)

  // Each supplier the lock approves that the new mandate doesn't name comes off on its own, so one
  // that fails leaves the others done, and the person hears which.
  const keep = profiles.map((p) => p.account)
  const dropped = (await approvedSuppliers(client, lock, since)).filter(
    (a) => !keep.some((k) => isAddressEqual(k, a)),
  )
  for (const supplier of dropped) {
    try {
      await sendOwn({ client, account: root, calls: [removeSupplierCall(lock, supplier)] })
      log(`Took supplier ${supplier} off the lock, since the new mandate doesn't name it.`)
    } catch (error) {
      log(
        `Supplier ${supplier} is still approved on the lock: ${error instanceof Error ? error.message : String(error)}. The new mandate doesn't name it, so Avow won't approve a reserve for it.`,
      )
    }
  }
  await showHeldBookings({ store, client, current: enrolled.mandateHash, log })
  if (current) {
    const session = checkSession(
      options.session !== undefined ? options.session : platformSession(),
    )
    if (session) {
      sessionReporter({
        session,
        key: rootRequestKey(root),
        domain,
        apiUrl: deployment.apiUrl,
        fetch: send,
        log,
      })({
        type: 'authority_changed',
        run: session.run,
        authority,
        previous: current.capOpenReserves,
        suppliers: ids,
        mandateHash: enrolled.mandateHash,
      })
    }
  }
  vault = null
  return prepared(next, true)
}

/** Lists what the lock still holds under an earlier authority, which stays until its release. */
async function showHeldBookings(m: {
  store: SandboxStore
  client: SandboxClient
  current: Hex
  log: (line: string) => void
}): Promise<void> {
  const earlier = (await loadCommitments(m.store)).filter(
    (c) => c.mandateHash.toLowerCase() !== m.current.toLowerCase(),
  )
  const held = (
    await Promise.all(
      earlier.map(async (c) => ({
        c,
        backing: await readBacking(
          m.client,
          c.reference.lock,
          c.reference.commitmentId,
          'buyer',
        ).catch(() => null),
      })),
    )
  ).filter(
    ({ backing }) =>
      backing && ['reserved', 'accepted', 'charge_pending', 'paused'].includes(backing.state),
  )
  if (held.length === 0) return
  m.log('Bookings made under an earlier authority stay held in the lock until their release:')
  for (const { c, backing } of held) {
    const release = backing ? new Date(Number(backing.releaseDate) * 1000).toISOString() : 'unknown'
    m.log(`  ${formatUsd(c.amount)} with ${c.supplier}, ${backing?.state}, released at ${release}`)
  }
}
