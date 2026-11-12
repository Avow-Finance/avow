import {
  type AvowDomain,
  formatUsd,
  mandateHash,
  REFUSED_BY,
  type SandboxDeployment,
} from '@avow-finance/spec'
import { readAgentKey, readBacking } from '@avow-finance/verifier'
import { type Address, type Hex, isAddressEqual } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { rootRequestKey } from '../http.js'
import { cancelFreeCall, FACTORY_ABI, removeSupplierCall } from '../lock.js'
import { moderatoClient } from '../moderato.js'
import { sendOwn } from '../send.js'
import {
  checkSession,
  dailyLimitOf,
  platformSession,
  platformStore,
  Refusal,
  type SandboxSession,
  sandboxAgent,
} from './agent.js'
import { createSandboxBusiness, type SandboxBusinessStep } from './business.js'
import { type BusinessItem, loadBusinessItem, saveBusinessItem } from './business-store.js'
import { loadSandboxDeployment, madeOn } from './deployment.js'
import type { SandboxClient } from './fees.js'
import { approvedSuppliers, lockCreatedIn, revokeOtherKeys } from './keys.js'
import { enrollSandboxAgent, SANDBOX_DAILY_LIMIT, sandboxMandate } from './mandate.js'
import { SANDBOX_SCREEN_URL, sessionRelay } from './session.js'
import {
  type AgentItem,
  loadAgentItem,
  loadCommitments,
  type SandboxStore,
  type SandboxSupplier,
  saveAgentItem,
  saveCommitments,
} from './store.js'
import { ensureSandboxSupplier } from './supplier-key.js'
import { checkSuppliers, connectSupplier } from './suppliers.js'
import { micros, toDollars } from './terms.js'
import { openKey, sealKey } from './vault.js'

/** What a business gives its agent, as `business.ts` in the starter says it. */
export interface SandboxBusinessConfig {
  /** The name the business registers under. */
  name: string
  /** Two capital letters, `US` when left out. */
  country?: string
  /**
   * The most the agent can hold in bookings at once, in dollars. Avow refuses a booking past it, and
   * the lock checks each reserve against the caps in Avow's approval.
   */
  authority: number
  /**
   * The most the agent's key can move in a day, in dollars, which the business sets on chain and the
   * account's keychain holds whatever Avow approves. $1,000 when left out.
   */
  dailyLimit?: number
  /** The suppliers the agent may book with, and no others. */
  suppliers: readonly SandboxSupplier[]
}

/** How the business's side asks the person running it. */
export interface SandboxPrompts {
  /** Asks for a new passphrase the first time, which seals the business's key. */
  newPassphrase(): Promise<string>
  /** Asks for the passphrase that opens the business's key. */
  passphrase(): Promise<string>
  /**
   * Asks a yes or no question, before the business signs anything new. The details say what a yes
   * does, a sentence each.
   */
  confirm(question: string, details?: readonly string[]): Promise<boolean>
}

/**
 * What a line setup reports is: a stage starting, a step done, something under way until the next
 * line, or a sentence to read. A log that ignores it still reads in order.
 */
/**
 * How a setup line draws. A first setup runs as numbered steps: `step` starts one, its title and a
 * sentence on why it matters on two lines, and `step_done` ends it with what it left. A `detail`
 * line, such as an address, shows only when the developer asks for details.
 */
export type SetupLineKind = 'stage' | 'done' | 'wait' | 'note' | 'step' | 'step_done' | 'detail'

export interface PrepareSandboxBusinessOptions {
  config: SandboxBusinessConfig
  prompts: SandboxPrompts
  /** Where the business keeps its sealed key and its agent's item. The `.avow` folder in Node. */
  store?: SandboxStore
  screenUrl?: string
  deployment?: SandboxDeployment
  /** The chain, through the deployment's node when left out. */
  client?: SandboxClient
  /** The session an authority change is reported to, signed by the business's root key. */
  session?: SandboxSession | null
  /**
   * Whether the job chapter needs the business registered as a supplier with a signing key of its
   * own. A registration that fails doesn't stop setup, and the result says why.
   */
  supplier?: boolean
  /**
   * Whether the session hasn't had the agent's authority yet, as on a first run, after `npm run
   * fresh` or once a session has ended. Then the business's key signs the current authority into
   * it even when nothing changed, which takes the passphrase once.
   */
  announce?: boolean
  /** Where setup says what it's doing, each line with what kind of line it is. */
  log?: (line: string, kind?: SetupLineKind) => void
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
  /**
   * Whether this call gave the session the agent's authority, as it does whenever it signs a
   * mandate, and with `announce` when nothing changed.
   */
  announced: boolean
  /**
   * The business as a supplier of jobs when `supplier` asked for it: registered with its signing
   * key, or why it couldn't be. Null when nothing asked.
   */
  supplier: { ok: true; signingKey: Address } | { ok: false; why: string } | null
}

const DAY = 86_400n
/** A mandate expiring sooner than this is replaced, once the person agrees. */
const MANDATE_MARGIN = 3600n
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

/** What setting up a business does after each step, which shows as under way until it's done. */
const NEXT_STEP: Record<SandboxBusinessStep['step'], string | null> = {
  fees: "Creating the business's lock",
  lock: "Registering the business with Avow's sandbox",
  registered: 'Waiting for the test dollars',
  funded: null,
}

const stepLine = (s: SandboxBusinessStep): string => {
  switch (s.step) {
    case 'fees':
      return s.hashes.length > 0 ? "Fees funded from Moderato's faucet" : 'Fees already covered'
    case 'lock':
      return s.createdIn ? 'Lock created on chain' : 'Lock found on chain'
    case 'registered':
      return "Registered with Avow's sandbox"
    case 'funded':
      return `${formatUsd(s.balance)} of test dollars in your account`
  }
}

/** What a step on chain leaves that the developer can look up, shown when they ask for details. */
const stepDetail = (s: SandboxBusinessStep): string | null =>
  s.step === 'lock'
    ? `Your business's lock is ${s.lock}.`
    : s.step === 'registered'
      ? `Avow's sandbox knows your business as ${s.businessId}.`
      : null

const authorityText = (cap: bigint, daily: bigint | null, suppliers: readonly string[]) =>
  `${formatUsd(cap)} held at once, ${daily === null ? 'no daily limit' : `${formatUsd(daily)} a day moved by the key`}, ${suppliers.join(', ')} only`

/**
 * Whether the chain shows the agent's key live on the account and authorized for the mandate in
 * the agent's file, with that mandate's hash as its witness. Only the root key authorizes a key,
 * so a file the agent rewrote, or an older mandate put back, fails this.
 */
async function keyHoldsMandate(
  client: SandboxClient,
  account: Address,
  agent: AgentItem,
  domain: AvowDomain,
): Promise<boolean> {
  const m = agent.mandate.message
  if (!isAddressEqual(m.account, account)) return false
  const key = await readAgentKey(client, account, m.agentKey, agent.keyAuthorizedIn).catch(
    () => null,
  )
  return (
    key !== null &&
    key.active &&
    (key.expiry === null || key.expiry > systemClock()) &&
    key.witness?.toLowerCase() === mandateHash(m, domain).toLowerCase()
  )
}

/**
 * The business's side of the sandbox, which only the runner calls. The first time, it asks for a
 * passphrase and seals a new root key under it, registers the business with Avow's sandbox, waits
 * for its test dollars and creates its lock. It takes whether the business is set up, and which
 * mandate the agent holds, from the chain, since anything running as the developer can write the
 * .avow folder, and it sets a business up again only after a yes to a question that says what that
 * replaces. Whenever the authority or the suppliers in the config differ from the mandate the chain
 * holds, or the mandate is about to expire, it asks before signing a new mandate, then asks for the
 * passphrase. A transaction of its own revokes every other key the account's keychain still
 * authorizes, access or admin, read from the chain from the lock's creation, so nothing the agent
 * can write keeps a key live. Then a new agent key goes on the account, and each supplier the lock
 * approves that the new mandate doesn't name comes off, each in its own transaction. The root key
 * is opened only for those signatures, and never stored or passed on in the clear.
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
  const dailyLimit =
    config.dailyLimit === undefined ? SANDBOX_DAILY_LIMIT : micros(config.dailyLimit, 'daily limit')
  const suppliers = checkSuppliers(config.suppliers)
  const ids = suppliers.map((s) => s.id)
  const store = options.store ?? platformStore()
  if (!store) throw new Error('The business needs a store. In Node it uses the .avow folder.')
  const screenUrl = options.screenUrl ?? SANDBOX_SCREEN_URL
  const deployment = options.deployment ?? (await loadSandboxDeployment(screenUrl, send))
  const client: SandboxClient = options.client ?? moderatoClient(deployment.rpcUrl)

  // The root key is open only inside this call, once the person typed the passphrase.
  let opened: Hex | null = null
  let item: BusinessItem | null = await loadBusinessItem(store)
  const fresh = !item
  if (!item) {
    if ((await store.read('agent')) !== null) {
      throw new Error(
        "The business's file is gone from .avow but its agent's file is there, so the business's key is missing. Restore .avow/business.json, or start over with npm run fresh.",
      )
    }
    log(
      'Your business\nYour business holds the money, in a lock of its own on chain. Its key is made on this machine, sealed under a passphrase you choose, and never leaves it.',
      'step',
    )
    const passphrase = await prompts.newPassphrase()
    const privateKey = generatePrivateKey()
    const account = Account.fromSecp256k1(privateKey).address
    const key = await sealKey(privateKey, passphrase, account)
    item = { account, key, business: null }
    await saveBusinessItem(store, item)
    opened = privateKey
  }
  const sealed = item
  const openRoot = async () => {
    opened ??= await openKey(sealed.key, await prompts.passphrase(), sealed.account)
    const root = Account.fromSecp256k1(opened)
    if (!isAddressEqual(root.address, sealed.account)) {
      throw new Error("The business's key doesn't match its account")
    }
    return root
  }

  // Whether the business is set up comes from the chain, never from the file alone, since anything
  // running as the developer can write the file. The lock is the factory's for the sealed key's
  // account, and the file's record counts only when it names that lock and the lock is on chain.
  const lock = await client.readContract({
    address: deployment.factory,
    abi: FACTORY_ABI,
    functionName: 'lockAddress',
    args: [sealed.account],
  })
  const lockMade = (await client.getCode({ address: lock })) !== undefined
  const recorded = item.business
  let business =
    recorded &&
    madeOn(recorded, deployment) &&
    isAddressEqual(recorded.account, sealed.account) &&
    isAddressEqual(recorded.lock, lock) &&
    lockMade
      ? recorded
      : null
  let setUpAgain = false
  let fundedNow: bigint | null = null
  if (!business) {
    if (!fresh) {
      const [question, ...details] = lockMade
        ? [
            'Set the business up again on the same key and lock?',
            `Your business's lock is on chain at ${lock}, but .avow/business.json doesn't record it, so its setup stopped part way or something changed the file.`,
            "A yes registers the business with Avow's sandbox again, replaces the record in .avow/business.json, and then signs your agent a new mandate, which revokes every other key on the account.",
          ]
        : [
            'Set your business up under this deployment?',
            "Your business's key is in .avow, but no lock for it is on chain under this deployment, so its setup stopped part way or it was set up on another one.",
            "A yes creates the lock, registers the business with Avow's sandbox and replaces the record in .avow/business.json.",
          ]
      if (!(await prompts.confirm(question as string, details))) {
        throw new Error(
          'Nothing changed, and your business stays as it was. Run npm start again to set it up.',
        )
      }
    }
    if (!fresh) log('Your business on Tempo testnet', 'stage')
    const root = await openRoot()
    log("Funding the account's fees", 'wait')
    let funded: bigint | null = null
    const made = await createSandboxBusiness({
      deployment,
      client,
      root,
      legalName: config.name,
      country,
      onStep: (s) => {
        log(stepLine(s), 'done')
        const detail = stepDetail(s)
        if (detail) log(detail, 'detail')
        const next = NEXT_STEP[s.step]
        if (next) log(next, 'wait')
        if (s.step === 'funded') funded = s.balance
      },
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
    item = { ...item, business }
    await saveBusinessItem(store, item)
    fundedNow = funded
    // Commitments from another deployment belong to another lock.
    if (recorded && !madeOn(recorded, deployment)) await saveCommitments(store, [])
    setUpAgain = !fresh
  }
  const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: lock }
  // The job chapter quotes and accepts jobs as a supplier, with a signing key of its own. A failure
  // here leaves the business set up, and the result says why it can't take jobs.
  let supplier: PreparedSandboxBusiness['supplier'] = null
  if (options.supplier) {
    try {
      const registered = await ensureSandboxSupplier({
        store,
        business,
        deployment,
        client,
        openRoot,
        log,
        fetch: send,
      })
      supplier = { ok: true, signingKey: registered.profile.signingKey }
    } catch (error) {
      supplier = { ok: false, why: error instanceof Error ? error.message : String(error) }
    }
  }
  if (fresh) {
    log(
      fundedNow === null
        ? 'Your business is set up, with its own lock on chain'
        : `Your business has ${formatUsd(fundedNow)} in test dollars, held in its own lock`,
      'step_done',
    )
  }
  let agent: AgentItem | null = await loadAgentItem(store)
  if (agent && !isAddressEqual(agent.business.lock, lock)) agent = null
  // The agent's file names the mandate it holds, and the agent can write that file. So the mandate
  // counts only while the chain shows its key live on the account and authorized for that mandate,
  // which only the root key can do. Anything else, or a business set up again, gets a new mandate.
  if (agent && (setUpAgain || !(await keyHoldsMandate(client, business.account, agent, domain)))) {
    log(
      "Your agent's file doesn't name a key the chain shows live under its mandate, so your agent needs a new mandate.",
      'note',
    )
    agent = null
  }

  const current = agent?.mandate.message
  const changed =
    !current ||
    current.capOpenReserves !== authority ||
    current.capPerCommitment !== authority ||
    dailyLimitOf(current, deployment.token) !== dailyLimit ||
    [...current.suppliers].sort().join() !== [...ids].sort().join()
  const expiring = current !== undefined && current.expiry <= systemClock() + MANDATE_MARGIN
  const prepared = (
    a: AgentItem,
    signed: boolean,
    announced: boolean,
  ): PreparedSandboxBusiness => ({
    businessId: a.business.businessId,
    account: a.business.account,
    lock,
    authority: toDollars(a.mandate.message.capOpenReserves),
    suppliers: [...a.mandate.message.suppliers],
    mandateHash: mandateHash(a.mandate.message, domain),
    signed,
    announced,
    supplier,
  })

  // An authority change goes to the session signed by the root key, and the runner waits for it,
  // so it can tell whether the screen has the agent's authority.
  const session = checkSession(options.session !== undefined ? options.session : platformSession())
  const postAuthority = async (
    root: Awaited<ReturnType<typeof openRoot>>,
    a: AgentItem,
    previous: bigint | null,
  ): Promise<boolean> => {
    if (!session) return false
    log("Giving your screen your agent's authority", 'wait')
    try {
      await sessionRelay({
        baseUrl: deployment.apiUrl,
        sessionId: session.id,
        key: rootRequestKey(root),
        domain,
        fetch: send,
        retryFor: 15n,
        attemptTimeout: 10_000,
      }).post({
        type: 'authority_changed',
        run: session.run,
        source: 'business',
        authority: a.mandate.message.capOpenReserves,
        previous,
        suppliers: [...a.mandate.message.suppliers],
        // The hash comes from the mandate the chain bound the agent's key to, and never from the
        // agent's file, which the agent can write.
        mandateHash: mandateHash(a.mandate.message, domain),
      })
      log("Your screen has your agent's authority.", 'done')
      return true
    } catch (error) {
      log(
        `The screen didn't get your agent's authority: ${error instanceof Error ? error.message : String(error)}`,
        'note',
      )
      return false
    }
  }
  // A session new to the authority gets the mandate the agent holds now, which takes the key.
  const announceCurrent = async (a: AgentItem): Promise<boolean> => {
    if (!options.announce || !session) return false
    log('Your screen', 'stage')
    log(
      "Your screen has a new session, so your business's key signs your agent's current authority for it. The passphrase opens the key for that one signature.",
      'note',
    )
    const done = await postAuthority(await openRoot(), a, null)
    opened = null
    return done
  }

  if (agent && !changed && !expiring) {
    // Supplier URLs aren't in the mandate, so a changed URL needs no new signature.
    if (JSON.stringify(agent.suppliers) !== JSON.stringify(suppliers)) {
      agent = { ...agent, suppliers }
      await saveAgentItem(store, agent)
    }
    return prepared(agent, false, await announceCurrent(agent))
  }

  // A first setup shows the limits as the step that teaches them, one to a line with who holds it.
  if (fresh) {
    log(
      "Your agent's limits\nYour agent gets a key of its own, and Avow and the chain refuse anything it tries past these limits.",
      'step',
    )
  }
  const question = fresh
    ? 'Sign these limits for your agent?'
    : changed
      ? `Sign a new mandate as ${config.name}?`
      : `Your agent's mandate expires within the hour. Sign a new one as ${config.name}?`
  const details = fresh
    ? [
        `${formatUsd(authority)} held at once, which Avow holds it to`,
        `${formatUsd(dailyLimit)} a day moved by its key, which the chain holds it to`,
        `Books only with ${ids.join(', ')}`,
      ]
    : [
        `${authorityText(authority, dailyLimit, ids)}.`,
        'It revokes every other key on the account.',
      ]
  if (!(await prompts.confirm(question, details))) {
    if (agent && current) {
      log(
        `Kept the current mandate: ${authorityText(current.capOpenReserves, dailyLimitOf(current, deployment.token), current.suppliers)}.`,
        'note',
      )
      return prepared(agent, false, await announceCurrent(agent))
    }
    throw new Error(
      "No mandate was signed, so your agent can't book yet. Run npm start again to sign one.",
    )
  }
  const root = await openRoot()
  log("Signing and enrolling your agent's mandate", 'wait')
  // The scan starts where the factory created the lock, read from the chain, so nothing on this
  // machine can move it past a key.
  const since = await lockCreatedIn({
    client,
    factory: deployment.factory,
    account: root.address,
    lock,
  })

  // The revocation goes first, in a transaction of its own, so nothing after it can stop it.
  const revoked = await revokeOtherKeys({ client, root, since })
  if (revoked.length > 0) {
    log(
      `Revoked ${revoked.length} key${revoked.length === 1 ? '' : 's'} the account's keychain still authorized.`,
      'done',
    )
    log("Signing and enrolling your agent's mandate", 'wait')
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
    dailyLimit,
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
  log("Mandate signed, and your agent's key enrolled on your account", 'done')

  // Each supplier the lock approves that the new mandate doesn't name comes off on its own, so one
  // that fails leaves the others done, and the person hears which.
  const keep = profiles.map((p) => p.account)
  const dropped = (await approvedSuppliers(client, lock, since)).filter(
    (a) => !keep.some((k) => isAddressEqual(k, a)),
  )
  for (const supplier of dropped) {
    try {
      await sendOwn({ client, account: root, calls: [removeSupplierCall(lock, supplier)] })
      log(`Took supplier ${supplier} off the lock, since the new mandate doesn't name it.`, 'done')
    } catch (error) {
      log(
        `Supplier ${supplier} is still approved on the lock: ${error instanceof Error ? error.message : String(error)}. The new mandate doesn't name it, so Avow won't approve a reserve for it.`,
        'note',
      )
    }
  }
  await showHeldBookings({ store, client, current: enrolled.mandateHash, log })
  const announced = await postAuthority(root, next, current?.capOpenReserves ?? null)
  opened = null
  if (fresh) {
    // The new key's first act is a booking a dollar past its limit, so the step ends on proof.
    log('Trying a booking past the limit', 'wait')
    const tried = await limitTry(authority, async (reserve) => {
      const agent = await sandboxAgent({
        store,
        deployment,
        session: null,
        log: () => {},
        fetch: send,
      })
      await agent.book({
        supplier: ids[0] as string,
        resource: { gpu: 'H100', count: 1, hours: 1 },
        reserve,
      })
    })
    log(
      `Your agent can hold ${formatUsd(authority)} at once and move ${formatUsd(dailyLimit)} a day.${tried ? ` ${tried}` : ''}`,
      'step_done',
    )
  }
  return prepared(next, true, announced)
}

/**
 * Has the agent try to hold a dollar more than its business just allowed, and says who refused
 * it. A first setup doesn't stop for a try that couldn't run, such as one whose supplier didn't
 * answer, so that gives null and the step ends without it.
 */
export async function limitTry(
  authority: bigint,
  book: (reserve: number) => Promise<unknown>,
): Promise<string | null> {
  const over = authority + 1_000_000n
  try {
    await book(toDollars(over))
  } catch (error) {
    if (!(error instanceof Refusal)) return null
    return `It asked to hold ${formatUsd(over)}, and ${REFUSED_BY[error.layer]} refused, so no money moved.`
  }
  return `It asked to hold ${formatUsd(over)} and nothing refused it, which should never happen, so tell Avow.`
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

/**
 * Cancels one of the agent's commitments on the lock before free cancellation ends, which gives
 * the whole reserve back. It's the business's call, signed by its root key once the person types
 * the passphrase, since the agent's key can't cancel on the lock.
 */
export async function cancelSandboxCommitment(options: {
  commitmentId: Hex
  prompts: Pick<SandboxPrompts, 'passphrase'>
  store?: SandboxStore
  screenUrl?: string
  deployment?: SandboxDeployment
  client?: SandboxClient
  fetch?: typeof fetch
}): Promise<Hex> {
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const store = options.store ?? platformStore()
  if (!store) throw new Error('The business needs a store. In Node it uses the .avow folder.')
  const item = await loadBusinessItem(store)
  if (!item?.business) throw new Error('This folder has no business yet. Run npm start first.')
  const deployment =
    options.deployment ??
    (await loadSandboxDeployment(options.screenUrl ?? SANDBOX_SCREEN_URL, send))
  const client = options.client ?? moderatoClient(deployment.rpcUrl)
  // The lock is the factory's for the account, read from the chain, whatever the file names.
  const lock = await client.readContract({
    address: deployment.factory,
    abi: FACTORY_ABI,
    functionName: 'lockAddress',
    args: [item.account],
  })
  const root = Account.fromSecp256k1(
    await openKey(item.key, await options.prompts.passphrase(), item.account),
  )
  const receipt = await sendOwn({
    client,
    account: root,
    calls: [cancelFreeCall(lock, options.commitmentId)],
  })
  return receipt.transactionHash
}
