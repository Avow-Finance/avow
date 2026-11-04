import {
  type AvowDomain,
  type CommitmentReference,
  formatUsd,
  isSessionId,
  type Mandate,
  mandateHash,
  mandateJson,
  parseSandboxDeployment,
  parseSigned,
  type ReasonCode,
  type RefusalAmounts,
  type RefusalLayer,
  refusalSentence,
  SANDBOX_DEPLOYMENT_PATH,
  type SandboxDeployment,
  type SessionEvent,
  type Signed,
  TESTNET_DEMO_PROFILE,
  toWire,
} from '@avow-finance/spec'
import { readBacking, tempoChainReader, verifyCommitmentReference } from '@avow-finance/verifier'
import { type Address, type Hex, isAddress, isAddressEqual } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { type AgentKey, BookingError, type Commitment, createAgent } from '../agent.js'
import type { AvowApi } from '../avow-api.js'
import { AvowApiError, agentRequestKey, httpAvowApi } from '../http.js'
import { readOpenReserves } from '../lock.js'
import { moderatoClient, moderatoUsdToken } from '../moderato.js'
import { sendSponsored } from '../send.js'
import { httpSupplier, type SupplierConnection } from '../supplier.js'
import { createSandboxBusiness, type SandboxBusinessStep, type SandboxClient } from './business.js'
import { enrollSandboxAgent, sandboxMandate } from './mandate.js'
import { SANDBOX_SCREEN_URL, sessionRelay, verifyUrl } from './session.js'
import { micros, type SandboxResource, sandboxTerms, toDollars } from './terms.js'

/**
 * A booking refused before any money moved, by the SDK, by Avow or by the lock. Its message is the
 * plain sentence `refusalSentence` writes from the reason code, the layer and the amounts.
 */
export class Refusal extends Error {
  readonly code: ReasonCode
  readonly layer: RefusalLayer
  /** What the booking needed, the authority left and the whole authority, in micros. */
  readonly amounts: RefusalAmounts
  /** Avow's decision id, when Avow decided. */
  readonly decisionId: string | null

  constructor(
    r: {
      code: ReasonCode
      layer: RefusalLayer
      amounts: RefusalAmounts
      decisionId?: string | null
    },
    options?: { cause?: unknown },
  ) {
    super(refusalSentence(r), options)
    this.name = 'Refusal'
    this.code = r.code
    this.layer = r.layer
    this.amounts = r.amounts
    this.decisionId = r.decisionId ?? null
  }
}

/** The two things a sandbox keeps: the business's keys, and what it has set up. */
export type SandboxStoreItem = 'keys' | 'state'

/**
 * Where a sandbox keeps a business's keys and what it has set up, as text. In Node `sandbox.agent`
 * keeps them in the `.avow` folder of the working directory unless it's given a store, and that
 * folder ignores itself in git. Keys never leave the store, and nothing logs them.
 */
export interface SandboxStore {
  read(item: SandboxStoreItem): Promise<string | null>
  write(item: SandboxStoreItem, text: string): Promise<void>
}

/** A store held in memory, for a test or a page that shouldn't keep its keys. */
export function memoryStore(): SandboxStore {
  const items = new Map<SandboxStoreItem, string>()
  return {
    read: async (item) => items.get(item) ?? null,
    write: async (item, text) => {
      items.set(item, text)
    },
  }
}

/** A session a runner opened, and which run of the agent this is. */
export interface SandboxSession {
  id: string
  run: number
}

/**
 * What the platform gives `sandbox.agent` by default. Importing the SDK in Node sets a store in the
 * `.avow` folder, the session its runner passes in the environment, and a `ready` that ends a run
 * the runner started only to set up.
 */
export interface SandboxPlatform {
  store?: () => SandboxStore
  session?: () => SandboxSession | null
  /** Runs once the business and the agent's mandate are ready, before the agent books. */
  ready?: () => Promise<void> | void
}

let platform: SandboxPlatform = {}

/** Sets what `sandbox.agent` uses when it isn't told otherwise. */
export function setSandboxPlatform(next: SandboxPlatform): void {
  platform = next
}

/** A supplier the agent may book: its business id, and the URL of its adapter. */
export interface SandboxSupplier {
  id: string
  url: string
}

export interface SandboxAgentOptions {
  /** The most the agent can hold in bookings at once, in dollars. */
  authority: number
  /** The suppliers the agent may book with. Its mandate names their ids and no others. */
  suppliers: readonly SandboxSupplier[]
  /** Where the keys and the setup are kept. The `.avow` folder in Node, by default. */
  store?: SandboxStore
  /** The sandbox's screen, which publishes the deployment's facts and checks shared links. */
  screenUrl?: string
  /** The deployment's facts, read from the screen when left out. */
  deployment?: SandboxDeployment
  /** The session to report to, or null for none. In Node, the one the runner opened. */
  session?: SandboxSession | null
  /** The name and country the business registers with. */
  business?: { legalName?: string; country?: string }
  /** Where progress goes, a line at a time. `console.log` by default. */
  log?: (line: string) => void
  fetch?: typeof fetch
}

/** One booking: the supplier's id, what it's for, and the reserve backing it, in dollars. */
export interface SandboxBooking {
  supplier: string
  resource: SandboxResource
  reserve: number
}

/** A commitment the agent made, with its reserve funded in the business's lock. */
export interface SandboxCommitment {
  /** Where the backing sits and the terms hash, which anyone can check against the lock. */
  readonly reference: CommitmentReference
  /** A link anyone can open to check the commitment, which carries the reference. */
  readonly link: string
  /** The reserve, in dollars. */
  readonly amount: number
  /** The authority the agent has left after this booking, in dollars. */
  readonly left: number
  /** Everything the SDK knows about the commitment, its salt included. Keep the salt private. */
  readonly commitment: Commitment
  /**
   * Runs the open verifier on this machine, as the supplier does before it accepts. The first check
   * is the SDK's own, of Avow's approval against the terms and the mandate, which passed before the
   * agent funded the reserve. The second reads the lock and checks Avow's factory made it and it
   * holds this commitment under the reference's terms hash.
   */
  verify(): Promise<SandboxCheck[]>
  /**
   * Waits for the supplier to check the commitment and accept it on the lock. It resolves true once
   * the acceptance lands, and false once the acceptance deadline passes without one, after which
   * the reserve goes back to the business.
   */
  accepted(): Promise<boolean>
}

/** One check the open verifier made on this machine. */
export interface SandboxCheck {
  name: string
  passed: boolean
  /** Why it failed, or null when it passed. */
  reason: ReasonCode | null
}

/** An agent with authority to commit a sandbox business, within its mandate. */
export interface SandboxAgent {
  /** The most the agent can hold in bookings at once, in dollars. */
  readonly authority: number
  readonly suppliers: readonly SandboxSupplier[]
  readonly business: { account: Address; lock: Address; businessId: string }
  /** The mandate the business's root key signed for the agent. */
  readonly mandate: Signed<Mandate>
  readonly mandateHash: Hex
  /** The authority the agent has left, in dollars, as the lock counts it. */
  left(): Promise<number>
  /**
   * Books with one of the agent's suppliers. It resolves with the commitment once the reserve is
   * funded, and throws a `Refusal` when the SDK, Avow or the lock refuses the booking.
   */
  book(booking: SandboxBooking): Promise<SandboxCommitment>
}

export interface StoredBusiness {
  chainId: number
  apiUrl: string
  factory: Address
  token: Address
  account: Address
  lock: Address
  businessId: string
}

export interface StoredAgent {
  key: Address
  mandate: Signed<Mandate>
  keyAuthorizedIn: Hex
}

export interface SandboxState {
  business: StoredBusiness | null
  agent: StoredAgent | null
}

export interface SandboxKeys {
  root: Hex
  /** Every agent key the business has made, by its address, so none is ever lost. */
  agents: Record<string, Hex>
}

const DAY = 86_400n
/** A mandate expiring sooner than this is replaced before the agent books. */
const MANDATE_MARGIN = 3600n
const isPrivateKey = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v)
const isHash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v)
const isAddressText = (v: unknown): v is Address => typeof v === 'string' && isAddress(v)
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

function readJson(text: string, what: string): Record<string, unknown> {
  try {
    const json: unknown = JSON.parse(text)
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
      return json as Record<string, unknown>
    }
  } catch {
    // Reported below, without the text, which may hold keys.
  }
  throw new Error(`The sandbox's ${what} isn't readable. Move the store aside to start over.`)
}

/** The business's keys, made and kept the first time. Not part of the SDK's interface. */
export async function loadKeys(store: SandboxStore): Promise<SandboxKeys> {
  const text = await store.read('keys')
  if (text === null) {
    const keys: SandboxKeys = { root: generatePrivateKey(), agents: {} }
    await store.write('keys', `${JSON.stringify(keys, null, 2)}\n`)
    return keys
  }
  const json = readJson(text, 'keys')
  const agents = json.agents
  if (
    !isPrivateKey(json.root) ||
    typeof agents !== 'object' ||
    agents === null ||
    !Object.entries(agents).every(([a, k]) => isAddressText(a) && isPrivateKey(k))
  ) {
    throw new Error(
      "The sandbox's keys aren't in the form it writes. Move the store aside to start over.",
    )
  }
  return { root: json.root, agents: agents as Record<string, Hex> }
}

const saveKeys = (store: SandboxStore, keys: SandboxKeys) =>
  store.write('keys', `${JSON.stringify(keys, null, 2)}\n`)

function readBusiness(json: unknown): StoredBusiness | null {
  if (typeof json !== 'object' || json === null) return null
  const b = json as Record<string, unknown>
  const ok =
    typeof b.chainId === 'number' &&
    typeof b.apiUrl === 'string' &&
    typeof b.businessId === 'string' &&
    isAddressText(b.factory) &&
    isAddressText(b.token) &&
    isAddressText(b.account) &&
    isAddressText(b.lock)
  return ok ? (b as unknown as StoredBusiness) : null
}

function readAgent(json: unknown, business: StoredBusiness): StoredAgent | null {
  if (typeof json !== 'object' || json === null) return null
  const a = json as Record<string, unknown>
  if (!isAddressText(a.key) || !isHash(a.keyAuthorizedIn)) return null
  const mandate = parseSigned(a.mandate, 'Mandate', mandateJson, {
    chainId: business.chainId,
    lock: business.lock,
  })
  if (!mandate.ok) return null
  return {
    key: a.key,
    keyAuthorizedIn: a.keyAuthorizedIn,
    mandate: mandate.value as Signed<Mandate>,
  }
}

/** What the sandbox set up, as far as it still parses. Not part of the SDK's interface. */
export async function loadState(store: SandboxStore): Promise<SandboxState> {
  const text = await store.read('state')
  if (text === null) return { business: null, agent: null }
  const json = readJson(text, 'state')
  const business = readBusiness(json.business)
  return { business, agent: business ? readAgent(json.agent, business) : null }
}

/** Keeps what the sandbox set up. Not part of the SDK's interface. */
export const saveState = (store: SandboxStore, state: SandboxState) =>
  store.write('state', `${JSON.stringify(toWire({ version: 1, ...state }), null, 2)}\n`)

/** Whether a business was made on this deployment, so its lock and registration still hold. */
const madeOn = (b: StoredBusiness, d: SandboxDeployment) =>
  b.chainId === d.chainId &&
  b.apiUrl === d.apiUrl &&
  isAddressEqual(b.factory, d.factory) &&
  isAddressEqual(b.token, d.token)

/** The facts of the deployment the sandbox's screen runs against, as it publishes them. */
export async function loadSandboxDeployment(
  screenUrl: string = SANDBOX_SCREEN_URL,
  send: typeof fetch = (input, init) => fetch(input, init),
): Promise<SandboxDeployment> {
  const url = `${new URL(screenUrl).origin}${SANDBOX_DEPLOYMENT_PATH}`
  let response: Response
  try {
    response = await send(url, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    throw new Error(`The sandbox at ${url} didn't answer: ${describe(error)}`)
  }
  const parsed = parseSandboxDeployment(await response.json().catch(() => null))
  if (!response.ok || !parsed.ok) throw new Error(`${url} doesn't describe a testnet deployment`)
  return parsed.value
}

/** The agent's suppliers, checked. Not part of the SDK's interface. */
export function checkSuppliers(suppliers: readonly SandboxSupplier[]): SandboxSupplier[] {
  if (suppliers.length === 0) throw new RangeError('The agent needs at least one supplier')
  const ids = new Set<string>()
  for (const s of suppliers) {
    if (typeof s.id !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(s.id)) {
      throw new RangeError(`${String(s.id)} isn't a supplier's business id`)
    }
    if (ids.has(s.id)) throw new RangeError(`${s.id} is listed twice`)
    ids.add(s.id)
    const url = new URL(s.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new RangeError(`${s.url} isn't an http or https URL`)
    }
  }
  return suppliers.map((s) => ({ id: s.id, url: s.url }))
}

/** Connects to a supplier's adapter and checks its profile names the supplier the agent expects. */
async function connect(s: SandboxSupplier, send: typeof fetch): Promise<SupplierConnection> {
  const connection = await httpSupplier(s.url, send)
  if (connection.profile.businessId !== s.id) {
    throw new Error(
      `The supplier at ${s.url} says it's ${connection.profile.businessId}, not ${s.id}, so the agent won't commit to it.`,
    )
  }
  return connection
}

/** A sandbox business's events, posted to its session in order, never holding up the agent. */
function sessionReporter(m: {
  session: SandboxSession
  root: Account.RootAccount
  domain: AvowDomain
  apiUrl: string
  fetch: typeof fetch
  log: (line: string) => void
}) {
  const relay = sessionRelay({
    baseUrl: m.apiUrl,
    sessionId: m.session.id,
    root: m.root,
    domain: m.domain,
    fetch: m.fetch,
    retryFor: 15n,
    attemptTimeout: 10_000,
  })
  let queue: Promise<void> = Promise.resolve()
  let warned = false
  return (event: SessionEvent) => {
    queue = queue.then(
      () =>
        relay.post(event).then(
          () => {},
          (error) => {
            if (warned) return
            warned = true
            m.log(`The screen didn't get this run's events: ${describe(error)}`)
          },
        ),
      () => {},
    )
  }
}

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
  `${formatUsd(cap)} with ${suppliers.join(', ')}`

/**
 * An agent with authority to commit a sandbox business on Tempo's Moderato testnet. The first
 * time, it makes the business's root key, registers the business with Avow's sandbox, waits for
 * its test dollars, and creates its lock. Whenever the authority or the suppliers differ from the
 * mandate the agent holds, or that mandate is about to expire, the business signs a new mandate
 * for a new agent key, puts the key on its account and enrolls it with Avow, and says so. Each
 * step picks up where the last run stopped.
 */
export async function sandboxAgent(options: SandboxAgentOptions): Promise<SandboxAgent> {
  const log = options.log ?? ((line: string) => console.log(line))
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const authority = micros(options.authority, 'authority')
  const suppliers = checkSuppliers(options.suppliers)
  const store = options.store ?? platform.store?.()
  if (!store) {
    throw new Error(
      "sandbox.agent needs somewhere to keep the business's keys. In Node it uses the .avow folder, and anywhere else pass a store.",
    )
  }
  const screenUrl = options.screenUrl ?? SANDBOX_SCREEN_URL
  const deployment = options.deployment ?? (await loadSandboxDeployment(screenUrl, send))
  const client: SandboxClient = moderatoClient(deployment.rpcUrl)
  const keys = await loadKeys(store)
  const root = Account.fromSecp256k1(keys.root)
  const state = await loadState(store)

  let business = state.business
  if (
    !business ||
    !madeOn(business, deployment) ||
    !isAddressEqual(business.account, root.address)
  ) {
    log('Setting up your sandbox business on Tempo testnet. The first time takes a minute or two.')
    const made = await createSandboxBusiness({
      deployment,
      client,
      root,
      legalName: options.business?.legalName ?? 'Starter Test Co',
      country: options.business?.country ?? 'US',
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
    state.business = business
    state.agent = null
    await saveState(store, state)
  }
  const { lock } = business
  const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: lock }

  const session = options.session !== undefined ? options.session : (platform.session?.() ?? null)
  if (session && (!isSessionId(session.id) || !Number.isInteger(session.run) || session.run < 1)) {
    throw new RangeError('The session needs a session id and a run number from 1 up')
  }
  const report = session
    ? sessionReporter({ session, root, domain, apiUrl: deployment.apiUrl, fetch: send, log })
    : () => {}
  const run = session?.run ?? 0
  report({ type: 'run_started', run })

  const ids = suppliers.map((s) => s.id)
  const now = systemClock()
  let held = state.agent
  const current = held?.mandate.message
  const changed =
    !current ||
    current.capOpenReserves !== authority ||
    current.capPerCommitment !== authority ||
    [...current.suppliers].sort().join() !== [...ids].sort().join()
  if (changed || (current && current.expiry <= now + MANDATE_MARGIN)) {
    const profiles = await Promise.all(suppliers.map(async (s) => (await connect(s, send)).profile))
    // The key is kept before it goes on the account, so a run that stops halfway never loses it.
    const agentPrivateKey = generatePrivateKey()
    const agentKey = Account.fromSecp256k1(agentPrivateKey, { access: root.address })
    keys.agents[agentKey.accessKeyAddress] = agentPrivateKey
    await saveKeys(store, keys)
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
    log(
      current
        ? changed
          ? `Your agent's authority changed from ${authorityText(current.capOpenReserves, current.suppliers)} to ${authorityText(authority, ids)}. Signing a new mandate for a new agent key.`
          : "Your agent's mandate expires within the hour. Signing a new one for a new agent key."
        : `Signing your agent's mandate: ${authorityText(authority, ids)}.`,
    )
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
    held = {
      key: agentKey.accessKeyAddress,
      mandate: enrolled.mandate,
      keyAuthorizedIn: enrolled.keyAuthorizedIn,
    }
    state.agent = held
    await saveState(store, state)
    log(
      current
        ? 'Enrolled the new mandate with Avow. Bookings made under the old one keep their reserves until release, and count only against it.'
        : 'Enrolled your agent with Avow.',
    )
    if (current && changed) {
      report({
        type: 'authority_changed',
        run,
        authority,
        previous: current.capOpenReserves,
        suppliers: ids,
        mandateHash: enrolled.mandateHash,
      })
    }
  }
  if (!held) throw new Error('The agent has no mandate')
  const agentPrivateKey = keys.agents[held.key]
  if (!agentPrivateKey) throw new Error("The agent's key is missing from the sandbox's keys")
  const agentKey: AgentKey = Account.fromSecp256k1(agentPrivateKey, { access: root.address })
  const mandate = held.mandate
  const mHash = mandateHash(mandate.message, domain)

  await platform.ready?.()
  return sandboxBooker({
    deployment,
    client,
    agentKey,
    mandate,
    mandateHash: mHash,
    business: { account: business.account, lock, businessId: business.businessId },
    suppliers,
    screenUrl,
    run,
    report,
    send,
  })
}

/** The agent's side of booking, under the mandate it holds. */
function sandboxBooker(m: {
  deployment: SandboxDeployment
  client: SandboxClient
  agentKey: AgentKey
  mandate: Signed<Mandate>
  mandateHash: Hex
  business: { account: Address; lock: Address; businessId: string }
  suppliers: SandboxSupplier[]
  screenUrl: string
  run: number
  report: (event: SessionEvent) => void
  send: typeof fetch
}): SandboxAgent {
  const { deployment, client, mandate, run, report, send } = m
  const { lock } = m.business
  const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: lock }
  const cap = mandate.message.capOpenReserves

  /** The authority left, read from the lock, which Avow's reserve check reads too. */
  async function leftNow(): Promise<bigint> {
    for (let i = 1; ; i++) {
      try {
        const open = await readOpenReserves(client, lock, m.mandateHash)
        return open >= cap ? 0n : cap - open
      } catch (error) {
        if (i >= 3) throw error
        await pause(1000)
      }
    }
  }

  async function refusal(
    r: { code: ReasonCode; layer: RefusalLayer; needed: bigint; leftBefore: bigint },
    extra: { decisionId?: string | null; cause?: unknown },
  ): Promise<Refusal> {
    const left = await leftNow().catch(() => r.leftBefore)
    const amounts = { needed: r.needed, left, authority: cap }
    report({ type: 'refused', run, code: r.code, layer: r.layer, amounts })
    return new Refusal(
      { code: r.code, layer: r.layer, amounts, decisionId: extra.decisionId ?? null },
      extra.cause === undefined ? undefined : { cause: extra.cause },
    )
  }

  return {
    authority: toDollars(cap),
    suppliers: m.suppliers,
    business: m.business,
    mandate,
    mandateHash: m.mandateHash,
    left: async () => toDollars(await leftNow()),

    async book(b: SandboxBooking): Promise<SandboxCommitment> {
      const reserve = micros(b.reserve, 'reserve')
      const leftBefore = await leftNow()
      const supplier = m.suppliers.find((s) => s.id === b.supplier)
      // The mandate names its suppliers, so the SDK refuses any other before anyone signs.
      if (!supplier || !mandate.message.suppliers.includes(b.supplier)) {
        throw await refusal(
          { code: 'mandate.supplier_not_allowed', layer: 'sdk', needed: reserve, leftBefore },
          {},
        )
      }
      const connection = await connect(supplier, send)
      const terms = sandboxTerms({ deployment, resource: b.resource, reserve, now: systemClock() })
      const avow = httpAvowApi({
        baseUrl: deployment.apiUrl,
        key: agentRequestKey(m.agentKey),
        domain,
        retryFor: 120n,
        fetch: send,
      })
      // Avow's own refusal, kept so the refusal says which layer made it.
      let avowRefused: ReasonCode | null = null
      let approvalChecked = false
      const watched = {
        ...avow,
        approveReserve: async (request) => {
          const answer = await avow.approveReserve(request)
          if (!answer.ok) avowRefused = answer.reason
          return answer
        },
      } satisfies AvowApi
      const agent = createAgent({
        client,
        key: m.agentKey,
        mandate,
        token: moderatoUsdToken(deployment.token),
        profile: TESTNET_DEMO_PROFILE,
        avow: watched,
        // The agent sends the funding only once it has checked Avow's approval against the terms
        // and the mandate, so reaching this send means that check passed on this machine.
        send: async (calls) => {
          approvalChecked = true
          const receipt = await sendSponsored({
            client,
            account: m.agentKey,
            calls,
            sponsor: (transaction) => avow.sponsor(transaction),
          })
          return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber }
        },
      })
      let booked: Awaited<ReturnType<typeof agent.book>>
      try {
        booked = await agent.book({ supplier: connection, terms, category: 'compute' })
      } catch (error) {
        // Avow approved, but the reserve never landed. The relay refuses to pay for a transaction
        // the lock would revert, and says so with its reason.
        if (error instanceof BookingError && error.outcome === 'failed') {
          throw await refusal(
            {
              code: relayReason(error) ?? 'chain.reserve_missing',
              layer: 'lock',
              needed: reserve,
              leftBefore,
            },
            { cause: error },
          )
        }
        throw error
      }
      if (!booked.ok) {
        const layer: RefusalLayer = avowRefused === booked.reason ? 'avow' : 'sdk'
        throw await refusal(
          { code: booked.reason, layer, needed: reserve, leftBefore },
          { decisionId: booked.decisionId ?? null },
        )
      }
      const commitment = booked.commitment
      const reference: CommitmentReference = {
        kind: 'commitment',
        chainId: deployment.chainId,
        lock,
        commitmentId: commitment.commitmentId,
        side: 'buyer',
        termsHash: commitment.termsHash,
      }
      const left = await leftNow().catch(() => (leftBefore > reserve ? leftBefore - reserve : 0n))
      report({ type: 'committed', run, reference, amount: reserve })
      let acceptance: Promise<boolean> | null = null
      return {
        reference,
        link: verifyUrl(reference, m.screenUrl),
        amount: toDollars(reserve),
        left: toDollars(left),
        commitment,
        async verify() {
          const reader = tempoChainReader(client, {
            factory: deployment.factory,
            chainId: deployment.chainId,
          })
          const read = () =>
            verifyCommitmentReference(reference, reader).catch(
              (): { ok: false; reason: ReasonCode } => ({
                ok: false,
                reason: 'service.unavailable',
              }),
            )
          // A node a block behind the one the reserve landed in doesn't show it yet.
          let onLock = await read()
          for (let i = 1; i < 4 && !onLock.ok; i++) {
            await pause(1500)
            onLock = await read()
          }
          return [
            {
              name: "Avow's approval matches the terms and your mandate, checked before any money moved",
              passed: approvalChecked,
              reason: approvalChecked ? null : 'approval.terms_mismatch',
            },
            {
              name: "Your lock, made by Avow's factory, holds the commitment under its terms hash",
              passed: onLock.ok,
              reason: onLock.ok ? null : onLock.reason,
            },
          ]
        },
        accepted() {
          acceptance ??= waitForAcceptance(client, lock, commitment).then((accepted) => {
            if (accepted) report({ type: 'accepted', run, reference })
            return accepted
          })
          return acceptance
        },
      }
    },
  }
}

/** The reason Avow gave somewhere in an error's causes, such as its relay's refusal. */
export function relayReason(error: unknown): ReasonCode | null {
  let e: unknown = error
  for (let i = 0; i < 6 && e instanceof Error; i++) {
    if (e instanceof AvowApiError && e.reason) return e.reason
    e = e.cause
  }
  return null
}

/**
 * Follows the lock until the supplier accepts the reserve, or until the acceptance deadline has
 * passed on the chain's clock with a minute to spare, after which the reserve goes back to the
 * business. A read that fails is read again.
 */
async function waitForAcceptance(
  client: SandboxClient,
  lock: Address,
  commitment: Commitment,
): Promise<boolean> {
  const acceptBy = commitment.approval.message.acceptBy
  for (;;) {
    const held = await readBacking(client, lock, commitment.commitmentId, 'buyer').catch(
      () => undefined,
    )
    if (held && held.state !== 'reserved') return held.state === 'accepted'
    const now = await client
      .getBlock({ blockTag: 'latest' })
      .then((block) => block.timestamp)
      .catch(() => null)
    if (now !== null && now > acceptBy + 60n) return false
    await pause(3000)
  }
}

/**
 * Avow's sandbox on Tempo's Moderato testnet. `sandbox.agent` gives an agent the authority to make
 * commitments for a sandbox business it sets up the first time, with keys made where it runs.
 */
export const sandbox = {
  agent: sandboxAgent,
  deployment: loadSandboxDeployment,
  memoryStore,
} as const
