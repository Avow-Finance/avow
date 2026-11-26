import {
  type AgentSource,
  type AvowDomain,
  approvalCaps,
  approvalDigest,
  approvalMandateProblem,
  approvalPartiesProblem,
  approvalTermsProblem,
  approvalTokenProblem,
  type CommitmentReference,
  checkEnvelope,
  checkMandate,
  dailyLimitOf,
  type GpuReservationTerms,
  isSessionId,
  lockTerms,
  type Mandate,
  type MandateChain,
  type MandateProof,
  type RailState,
  type RaisableLimit,
  type ReasonCode,
  type RefusalAmounts,
  type RefusalLayer,
  type RequestKey,
  refusalSentence,
  type SandboxDeployment,
  type SandboxTool,
  SERVICE_CATEGORY,
  type ServiceOfferVersion,
  type ServiceTerms,
  type SessionEvent,
  serviceOfferTerms,
  serviceOrderProblem,
  servicePrice,
  TESTNET_DEMO_PROFILE,
  type TopUp,
  tempoKeychainCheck,
  toTokenUnits,
} from '@avow-finance/spec'
import {
  readAgentKey,
  readBacking,
  verifyCommitmentReference,
  verifyCommitmentTerms,
} from '@avow-finance/verifier'
import { type Address, type Hex, isAddressEqual, zeroAddress, zeroHash } from 'viem'
import { Abis, Account, Addresses } from 'viem/tempo'
import { type AgentKey, BookingError, type Commitment, createAgent } from '../agent.js'
import type { AvowApi } from '../avow-api.js'
import { agentRequestKey, httpAvowApi, relayReason } from '../http.js'
import { readOpenReserves } from '../lock.js'
import { moderatoClient, moderatoUsdToken } from '../moderato.js'
import { landedReverted, sendErrorIn, sendSponsored } from '../send.js'
import { SupplierDeclined } from '../supplier.js'
import { loadSandboxDeployment, madeOn, trustedFactory } from './deployment.js'
import type { SandboxClient } from './fees.js'
import { heldMandates } from './mandates.js'
import { type AskedChange, askForChange, raiseAsk, readOwnRequest } from './requests.js'
import { SANDBOX_SCREEN_URL, sessionRelay, verifyUrl } from './session.js'
import {
  addCommitment,
  loadAgentItem,
  loadCommitments,
  type SandboxStore,
  type SandboxSupplier,
} from './store.js'
import { sandboxSupplierProfile } from './supplier-profile.js'
import { connectSupplier } from './suppliers.js'
import { micros, type SandboxResource, sandboxTerms, toDollars } from './terms.js'
import { sandboxTopUp } from './top-up.js'
import { trustedChainReader } from './trusted-readers.js'

/**
 * A booking refused before any money moved, by the SDK, Avow, Avow's relay, the lock or the
 * account's keychain, or a reserve that never landed for no reason anyone gave. Its message is the sentence `refusalSentence` writes from the reason code,
 * the layer and the amounts.
 */
export class Refusal extends Error {
  readonly code: ReasonCode
  readonly layer: RefusalLayer
  /** What the booking needed, the authority left and the key's daily limit, in micros. */
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

/** A session a runner opened, and which run of the agent this is. */
export interface SandboxSession {
  id: string
  run: number
}

/**
 * What the platform gives the sandbox by default. Importing the SDK in Node sets a store in the
 * `.avow` folder, and the session its runner passes to the agent's process.
 */
export interface SandboxPlatform {
  store?: () => SandboxStore
  session?: () => SandboxSession | null
}

let platform: SandboxPlatform = {}

/** Sets what the sandbox uses when it isn't told otherwise. */
export function setSandboxPlatform(next: SandboxPlatform): void {
  platform = next
}

/** The platform's store, when it has one. */
export const platformStore = (): SandboxStore | undefined => platform.store?.()

/** The session the platform passes, when there is one. */
export const platformSession = (): SandboxSession | null => platform.session?.() ?? null

export interface SandboxAgentOptions {
  /** Where the business keeps the agent's key and mandate. The `.avow` folder in Node, by default. */
  store?: SandboxStore
  /** The sandbox's screen, which publishes the deployment's facts and checks shared links. */
  screenUrl?: string
  /** The deployment's facts, read from the screen when left out. */
  deployment?: SandboxDeployment
  /** The session to report to, or null for none. In Node, the one the runner opened. */
  session?: SandboxSession | null
  /** Who drives the agent, the developer's file by default, or a model through the MCP server. */
  source?: 'script' | 'mcp'
  /** The MCP tool this run answers, when a model called one. */
  tool?: SandboxTool | null
  /** Where warnings go, a line at a time. `console.log` by default. */
  log?: (line: string) => void
  fetch?: typeof fetch
}

/** One booking: the supplier's id, what it's for, and the reserve backing it, in dollars. */
export interface SandboxBooking {
  supplier: string
  resource: SandboxResource
  reserve: number
}

/**
 * Whether a booking would pass the checks the agent can make before anyone signs, with the amounts
 * behind the answer. A booking that fails names the code and the layer that would refuse it, as a
 * `Refusal` does. Avow's relay budget and the supplier's own answer aren't checked, since only
 * sending the booking asks them.
 */
export type SandboxPreflight =
  | { passes: true; amounts: RefusalAmounts }
  | { passes: false; code: ReasonCode; layer: RefusalLayer; amounts: RefusalAmounts }

/** What a check can't know without sending the booking. */
export const PREFLIGHT_UNCHECKED = ["Avow's relay budget", "the supplier's own answer"] as const

/**
 * Whether ordering units of a service from an offer would pass the checks the buyer's agent can
 * make before it sends anything, with the price and the amounts behind the answer. An order whose
 * offer can't be priced in that quantity has no price or amounts to give.
 *
 * The mandate's limits count the reserve, which is the larger of the offer's two charges. The
 * price is paid outside the lock, and no limit a person signed counts it yet, so the answer
 * carries it for the agent to weigh itself.
 */
export type ServicePreflight =
  | { passes: true; price: bigint; amounts: RefusalAmounts }
  | {
      passes: false
      code: ReasonCode
      layer: RefusalLayer
      price: bigint | null
      amounts: RefusalAmounts | null
    }

/**
 * What a check of a service order can't know without sending it. The offer in an order is the
 * buyer's copy, so only the seller can say it still publishes that version and has capacity left.
 */
export const SERVICE_PREFLIGHT_UNCHECKED = [
  "Avow's relay budget",
  'whether the seller still publishes this version of the offer',
  "how much of the seller's capacity is left",
  'how many orders your business already has waiting',
] as const

/** One check the agent's machine made, and why it failed if it did. */
export interface SandboxCheck {
  name: string
  passed: boolean
  reason: ReasonCode | null
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
   * Checks the commitment on this machine with the open verifier, every check the buyer's side can
   * make. Avow's approval has to name this commitment, the supplier, the lock's token, the terms
   * and the mandate's caps and hash. The lock has to be one its business's trusted factory made,
   * holding the commitment under the terms hash, enforcing what the terms map to, under the
   * approval checked.
   * The agent's key has to be on the account, bound to the mandate's hash.
   */
  verify(): Promise<SandboxCheck[]>
  /**
   * Waits for the supplier to accept on the lock. It resolves true once the acceptance lands, and
   * false once the acceptance deadline passes without one, after which the reserve goes back.
   */
  accepted(): Promise<boolean>
}

/** A commitment the business's agent made, as the lock holds it now. */
export interface SandboxCommitmentRecord {
  reference: CommitmentReference
  link: string
  /** The reserve, in dollars. */
  amount: number
  supplier: string
  /** Unix seconds. */
  madeAt: bigint
  /** The lock's state for it now, or `unread` when the chain didn't answer. */
  state: RailState | 'unread'
  /** Whether it was made under the agent's current mandate, or under an earlier authority. */
  current: boolean
  /** When the lock gives back what it still holds, in unix seconds, once it's read. */
  releaseDate: bigint | null
}

/** An agent with authority to commit a sandbox business, within the mandate it holds. */
export interface SandboxAgent {
  /** The most the agent can hold in bookings at once, in dollars. */
  readonly authority: number
  /** The most the agent's key can move in a day, in dollars, or null when it has no daily limit. */
  readonly dailyLimit: number | null
  readonly suppliers: readonly SandboxSupplier[]
  readonly business: { account: Address; lock: Address; businessId: string }
  /** The mandate the business's root key authorized for the agent. */
  readonly mandate: MandateProof
  readonly mandateHash: Hex
  /** The authority the agent has left, in dollars, as the lock counts it. */
  left(): Promise<number>
  /** What the agent's key can still move today, in dollars, as the account's keychain counts it. */
  dailyLeft(): Promise<number | null>
  /** Every commitment the business's agents made, each with its state on the lock now. */
  commitments(): Promise<SandboxCommitmentRecord[]>
  /**
   * Whether a booking would pass now, without moving money or signing anything: the mandate check
   * Avow runs, against what the lock holds under the mandate and every one it replaced, and what
   * the keychain lets the key move today. It reads the chain, sends nothing to the supplier, and
   * asks Avow only for the agent's mandates, at most every half minute.
   */
  check(booking: SandboxBooking): Promise<SandboxPreflight>
  /**
   * Whether ordering `quantity` units from a service offer would pass now, without sending the
   * order, signing or moving money. It prices the offer, asks Avow whether it knows the seller,
   * then runs the mandate check Avow runs on the terms the offer builds, under the mandate the
   * agent holds now: the seller and the service category, the reserve against each cap, what the
   * lock already holds, the mandate's end against the commitment's window, and what the keychain
   * lets the key move today. Nothing is sent to the seller.
   */
  checkOrder(order: { offer: ServiceOfferVersion; quantity: number }): Promise<ServicePreflight>
  /**
   * Books with one of the agent's suppliers. It resolves with the commitment once the reserve is
   * funded, and throws a `Refusal` when the booking is refused before any money moves.
   */
  book(booking: SandboxBooking): Promise<SandboxCommitment>
  /**
   * Books with one of the agent's suppliers on terms already written, such as an offer's, with the
   * reserve those terms set. It checks, refuses and funds as `book` does.
   */
  bookTerms(booking: { supplier: string; terms: GpuReservationTerms }): Promise<SandboxCommitment>
  /**
   * Asks the business's administrator to raise one of the agent's limits, to `to` dollars, from
   * what its current mandate holds. It only asks: the administrator decides with their passkey on
   * the page the link opens, and the agent can use the new limit once the request is active.
   */
  askToRaise(raise: { limit: RaisableLimit; to: number }): Promise<AskedChange>
}

const DAY = 86_400n
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)

/** Posts a business's events to its session in order, never holding up the caller. */
export function sessionReporter(m: {
  session: SandboxSession
  key: RequestKey
  domain: AvowDomain
  apiUrl: string
  fetch: typeof fetch
  log: (line: string) => void
}): (event: SessionEvent) => void {
  const relay = sessionRelay({
    baseUrl: m.apiUrl,
    sessionId: m.session.id,
    key: m.key,
    domain: m.domain,
    fetch: m.fetch,
    retryFor: 15n,
    attemptTimeout: 10_000,
  })
  let queue: Promise<void> = Promise.resolve()
  let warned = false
  return (event) => {
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

/** Checks a session a caller passed. */
export function checkSession(session: SandboxSession | null): SandboxSession | null {
  if (session && (!isSessionId(session.id) || !Number.isInteger(session.run) || session.run < 1)) {
    throw new RangeError('The session needs a session id and a run number from 1 up')
  }
  return session
}

/** The daily limit the root key set on the agent's key for the lock's token, in micros. */
export { dailyLimitOf }

/** What the agent's key can still move today, in micros, as the account's keychain counts it. */
export async function keyLeftToday(
  client: SandboxClient,
  account: Address,
  key: Address,
  token: Address,
): Promise<bigint> {
  const [remaining] = await client.readContract({
    address: Addresses.accountKeychain,
    abi: Abis.accountKeychain,
    functionName: 'getRemainingLimitWithPeriod',
    args: [account, key, token],
  })
  return remaining
}

/**
 * What any call the agent makes stands on: its item from the store, the deployment its business
 * was set up on, its own key with the business's account, and the business's lock as the domain
 * its requests are signed under. It never reads the business's key.
 */
async function agentContext(
  options: Pick<SandboxAgentOptions, 'fetch' | 'store' | 'screenUrl' | 'deployment'>,
) {
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const store = options.store ?? platform.store?.()
  if (!store) {
    throw new Error(
      'The agent needs the folder its business set up. In Node that is the .avow folder, and anywhere else pass a store.',
    )
  }
  const item = await loadAgentItem(store)
  if (!item) {
    throw new Error(
      "This folder has no agent yet. Run npm start, which sets up your business and asks you before it signs your agent's mandate.",
    )
  }
  const screenUrl = options.screenUrl ?? SANDBOX_SCREEN_URL
  const deployment = options.deployment ?? (await loadSandboxDeployment(screenUrl, send))
  if (!madeOn(item.business, deployment)) {
    throw new Error(
      'The sandbox runs a new deployment now. Run npm start to set your business up on it.',
    )
  }
  const agentKey: AgentKey = Account.fromSecp256k1(item.agentKey, {
    access: item.business.account,
  })
  if (!isAddressEqual(agentKey.accessKeyAddress, item.mandate.message.agentKey)) {
    throw new Error("The agent's key isn't the one its mandate names")
  }
  const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: item.business.lock }
  return { send, store, item, screenUrl, deployment, agentKey, domain }
}

/**
 * The agent of a sandbox business, acting with only its own key under the mandate its business
 * signed. It reads the agent's item from the store and never the business's key, and it has no
 * call that signs a mandate, enrolls a key or changes the authority. Run `npm start` first, which
 * sets the business up and asks before it signs the agent's mandate.
 */
export async function sandboxAgent(options: SandboxAgentOptions = {}): Promise<SandboxAgent> {
  const log = options.log ?? ((line: string) => console.log(line))
  const { send, store, item, screenUrl, deployment, agentKey, domain } = await agentContext(options)
  const client: SandboxClient = moderatoClient(deployment.rpcUrl)
  const session = checkSession(
    options.session !== undefined ? options.session : (platform.session?.() ?? null),
  )
  const report = session
    ? sessionReporter({
        session,
        key: agentRequestKey(agentKey),
        domain,
        apiUrl: deployment.apiUrl,
        fetch: send,
        log,
      })
    : () => {}
  const run = session?.run ?? 0
  const source = options.source ?? 'script'
  report({ type: 'run_started', run, source, tool: options.tool ?? null })
  const mandates = () =>
    heldMandates({
      apiUrl: deployment.apiUrl,
      client,
      agentKey,
      account: item.business.account,
      keyAuthorizedIn: item.keyAuthorizedIn,
      domain,
      send,
      isAccountSignature: tempoKeychainCheck(client),
    })
  // The administrator may have replaced the mandate since this folder was set up, so the agent
  // starts under the one Avow holds now. With no such route on Avow it keeps the one it enrolled
  // with, and when the read fails it checks and books nothing until a later read succeeds.
  const started = await mandates().then(
    (chain) => ({ chain, problem: null }),
    (error: unknown) => ({
      chain: null,
      problem: error instanceof Error ? error.message : String(error),
    }),
  )
  if (started.problem) log(`Couldn't read this agent's mandates: ${started.problem}`)
  return booker({
    mandates,
    started,
    log,
    deployment,
    client,
    store,
    agentKey,
    mandate: item.mandate,
    mandateHash: item.mandateHash,
    keyAuthorizedIn: item.keyAuthorizedIn,
    business: {
      account: item.business.account,
      lock: item.business.lock,
      businessId: item.business.businessId,
    },
    suppliers: item.suppliers,
    screenUrl,
    run,
    source,
    report,
    send,
  })
}

/** The mandate an agent acts under, and the hashes of those it replaced, newest first. */
interface Held {
  mandate: MandateProof
  hash: Hex
  earlier: Hex[]
}

/** What the booker holds from a chain of mandates, or null when there's none to hold. */
function heldFrom(chain: MandateChain | null): Held | null {
  return chain && { mandate: chain.current.proof, hash: chain.current.hash, earlier: chain.earlier }
}

const sameHash = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase()

/** The agent's side of booking, under the mandate it holds. */
function booker(m: {
  deployment: SandboxDeployment
  client: SandboxClient
  store: SandboxStore
  agentKey: AgentKey
  mandate: MandateProof
  mandateHash: Hex
  keyAuthorizedIn: Hex
  business: { account: Address; lock: Address; businessId: string }
  suppliers: SandboxSupplier[]
  screenUrl: string
  run: number
  source: AgentSource
  report: (event: SessionEvent) => void
  send: typeof fetch
  /** Every mandate the agent has held, from Avow, or null when Avow has no such route. */
  mandates: () => Promise<MandateChain | null>
  /** What reading the chain gave when the agent started. */
  started: { chain: MandateChain | null; problem: string | null }
  log: (line: string) => void
}): SandboxAgent {
  const { deployment, client, run, source, report, send } = m
  const { lock, account } = m.business
  const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: lock }
  const token = moderatoUsdToken(deployment.token)
  const asking = { apiUrl: deployment.apiUrl, agentKey: m.agentKey, domain, send }

  // The mandate the agent acts under, which the administrator can replace without touching its
  // key, and the hashes of those it replaced, whose open reserves count against its limit too.
  // Avow is asked again at most every half minute. While the last read failed, or served a chain
  // the agent can't take, the agent keeps what it held and checks and books nothing, since the
  // administrator may have lowered its limits. An API with no such route isn't a failure.
  let held: Held = heldFrom(m.started.chain) ?? {
    mandate: m.mandate,
    hash: m.mandateHash,
    earlier: [],
  }
  let problem = m.started.problem
  let readAt = Date.now()
  async function current(fresh = false): Promise<Held> {
    if (!fresh && Date.now() - readAt < 30_000) return held
    readAt = Date.now()
    const before = problem
    try {
      const next = heldFrom(await m.mandates())
      problem = null
      // A chain without the mandate the agent holds would take it back to limits the
      // administrator replaced. This holds within one process, and a new process starts from
      // whatever Avow serves, checked against the key.
      const keeps = next && [next.hash, ...next.earlier].some((h) => sameHash(h, held.hash))
      if (next && keeps) held = next
      else if (next) problem = 'Avow served mandates that leave out the one this agent holds'
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    if (problem && problem !== before) m.log(`Couldn't read this agent's mandates: ${problem}`)
    return held
  }
  const capOf = (h: Held) => h.mandate.message.capOpenReserves
  const dailyLimitOf_ = (h: Held) => dailyLimitOf(h.mandate.message, deployment.token)

  /** What the lock holds open under the current mandate and every one it replaced. */
  async function openAcross(h: Held): Promise<bigint> {
    const each = await Promise.all(
      [h.hash, ...h.earlier].map((hash) => readOpenReserves(client, lock, hash)),
    )
    return each.reduce((a, b) => a + b, 0n)
  }

  /** The authority left, read from the lock, which Avow's reserve check reads too. */
  async function leftNow(): Promise<bigint> {
    const h = await current()
    const cap = capOf(h)
    for (let i = 1; ; i++) {
      try {
        const open = await openAcross(h)
        return open >= cap ? 0n : cap - open
      } catch (error) {
        if (i >= 3) throw error
        await pause(1000)
      }
    }
  }

  const dailyLeftUnder = (h: Held) =>
    dailyLimitOf_(h) === null
      ? Promise.resolve(null)
      : keyLeftToday(client, account, m.agentKey.accessKeyAddress, deployment.token)

  /**
   * Whether a booking passes every check the agent can make before anyone signs, under one
   * mandate, with the amounts behind the answer. It's the same check Avow runs, with the open
   * reserves the lock holds under that mandate and every one it replaced, then the keychain's
   * daily limit. `check` answers with it, and `book` runs it first.
   */
  async function limits(
    h: Held,
    ask: {
      supplier: string
      category: string
      terms: GpuReservationTerms | ServiceTerms
      /** Whether the SDK refuses the supplier itself, before the mandate is read. */
      unreachable: boolean
    },
  ): Promise<{
    refused: { code: ReasonCode; layer: RefusalLayer } | null
    amounts: RefusalAmounts
  }> {
    const { terms } = ask
    const reserve = terms.backing.amount
    const { mandate } = h
    const cap = capOf(h)
    const [open, dailyLeft] = await Promise.all([openAcross(h), dailyLeftUnder(h)])
    const amounts: RefusalAmounts = {
      needed: reserve,
      left: open >= cap ? 0n : cap - open,
      authority: cap,
      capPerCommitment: mandate.message.capPerCommitment,
      dailyLimit: dailyLimitOf_(h),
      dailyLeft,
    }
    const no = (code: ReasonCode, layer: RefusalLayer) => ({ refused: { code, layer }, amounts })
    if (problem) return no('service.unavailable', 'avow')
    if (ask.unreachable) return no('mandate.supplier_not_allowed', 'sdk')
    const allowed = checkMandate({
      mandate: mandate.message,
      request: {
        commitmentId: zeroHash,
        agentKey: m.agentKey.accessKeyAddress,
        supplier: ask.supplier,
        payee: zeroAddress,
        category: ask.category,
        terms,
      },
      token,
      openReserves: open,
      revoked: false,
      now: systemClock(),
      profile: TESTNET_DEMO_PROFILE,
    })
    if (allowed.result !== 'approved') {
      // Only the open reserves come from the lock, which Avow's check reads too.
      return no(
        allowed.reason,
        allowed.reason === 'mandate.over_open_reserves_cap' ? 'avow' : 'sdk',
      )
    }
    if (dailyLeft !== null && toTokenUnits(reserve, token.decimals) > dailyLeft) {
      return no('keychain.over_daily_limit', 'keychain')
    }
    return { refused: null, amounts }
  }

  /**
   * A GPU booking as `limits` takes it. The SDK refuses a supplier the mandate doesn't name, or
   * one this deployment can't reach, before anything else.
   */
  const gpuAsk = (h: Held, supplierId: string, terms: GpuReservationTerms) => ({
    supplier: supplierId,
    category: 'compute',
    terms,
    unreachable:
      !m.suppliers.some((s) => s.id === supplierId) ||
      !h.mandate.message.suppliers.includes(supplierId),
  })

  /** A refusal under the mandate the booking ran under, with what's left now. */
  async function refusal(
    h: Held,
    r: { code: ReasonCode; layer: RefusalLayer; needed: bigint; leftBefore: bigint },
    extra: { decisionId?: string | null; cause?: unknown },
  ): Promise<Refusal> {
    const open = await openAcross(h).catch(() => null)
    const cap = capOf(h)
    const left = open === null ? r.leftBefore : open >= cap ? 0n : cap - open
    const dailyLeft = await dailyLeftUnder(h).catch(() => null)
    const amounts = {
      needed: r.needed,
      left,
      authority: cap,
      capPerCommitment: h.mandate.message.capPerCommitment,
      dailyLimit: dailyLimitOf_(h),
      dailyLeft,
    }
    report({ type: 'refused', run, source, code: r.code, layer: r.layer, amounts })
    return new Refusal(
      { code: r.code, layer: r.layer, amounts, decisionId: extra.decisionId ?? null },
      extra.cause === undefined ? undefined : { cause: extra.cause },
    )
  }

  return {
    get authority() {
      return toDollars(capOf(held))
    },
    get dailyLimit() {
      const limit = dailyLimitOf_(held)
      return limit === null ? null : toDollars(limit)
    },
    suppliers: m.suppliers,
    business: m.business,
    get mandate() {
      return held.mandate
    },
    get mandateHash() {
      return held.hash
    },
    left: async () => toDollars(await leftNow()),
    async askToRaise(raise) {
      // Read afresh, since Avow takes an ask only from the limit the agent holds now.
      const now = await current(true)
      const ask = raiseAsk(now.mandate.message, raise.limit, micros(raise.to, 'limit'))
      return askForChange(asking, ask)
    },
    dailyLeft: async () => {
      const left = await dailyLeftUnder(await current())
      return left === null ? null : toDollars(left)
    },

    async commitments() {
      const stored = await loadCommitments(m.store)
      const { hash } = await current()
      return Promise.all(
        stored.map(async (c): Promise<SandboxCommitmentRecord> => {
          const backing = await readBacking(
            client,
            c.reference.lock,
            c.reference.commitmentId,
            c.reference.side,
          ).catch(() => undefined)
          return {
            reference: c.reference,
            link: verifyUrl(c.reference, m.screenUrl),
            amount: toDollars(c.amount),
            supplier: c.supplier,
            madeAt: c.madeAt,
            state: backing === undefined ? 'unread' : (backing?.state ?? 'none'),
            current: c.mandateHash.toLowerCase() === hash.toLowerCase(),
            releaseDate: backing ? backing.releaseDate : null,
          }
        }),
      )
    },

    async check(b: SandboxBooking): Promise<SandboxPreflight> {
      const reserve = micros(b.reserve, 'reserve')
      const terms = sandboxTerms({ deployment, resource: b.resource, reserve, now: systemClock() })
      const h = await current()
      const { refused, amounts } = await limits(h, gpuAsk(h, b.supplier, terms))
      return refused ? { passes: false, ...refused, amounts } : { passes: true, amounts }
    },

    async checkOrder(o): Promise<ServicePreflight> {
      const now = systemClock()
      const early = (code: ReasonCode, layer: RefusalLayer): ServicePreflight => ({
        passes: false,
        code,
        layer,
        price: null,
        amounts: null,
      })
      // The order's own times are set when it's sent, so the check gives it ones that pass and
      // reads only whether the offer can be priced in this quantity.
      const unpriced = serviceOrderProblem(
        {
          orderId: '0'.repeat(32),
          commitmentId: zeroHash,
          offer: o.offer,
          quantity: o.quantity,
          builtAt: now,
          expiry: now + 1n,
        },
        now,
      )
      if (unpriced) return early(unpriced, 'sdk')
      const terms = serviceOfferTerms(o.offer, o.quantity, now, {
        arbiter: deployment.arbiter,
        day90SupplierShareBps: deployment.day90SupplierShareBps,
      })
      const price = servicePrice(terms)
      const { supplier } = o.offer
      const h = await current()
      const { refused, amounts } = await limits(h, {
        supplier,
        category: SERVICE_CATEGORY,
        terms,
        unreachable: false,
      })
      // Avow refuses an order a business sends itself, or one for a seller it doesn't know.
      const outright: ReasonCode | null =
        supplier === m.business.businessId
          ? 'order.supplier_mismatch'
          : (await sandboxSupplierProfile(deployment.apiUrl, supplier, send))
            ? null
            : 'supplier.unknown'
      if (outright) return { passes: false, code: outright, layer: 'avow', price, amounts }
      return refused
        ? { passes: false, ...refused, price, amounts }
        : { passes: true, price, amounts }
    },

    book(b: SandboxBooking): Promise<SandboxCommitment> {
      const reserve = micros(b.reserve, 'reserve')
      const terms = sandboxTerms({ deployment, resource: b.resource, reserve, now: systemClock() })
      return bookOn(b.supplier, terms, reserve)
    },

    bookTerms(b: { supplier: string; terms: GpuReservationTerms }): Promise<SandboxCommitment> {
      return bookOn(b.supplier, b.terms, b.terms.backing.amount)
    },
  }

  async function bookOn(
    supplierId: string,
    terms: GpuReservationTerms,
    reserve: bigint,
  ): Promise<SandboxCommitment> {
    {
      // One mandate for the whole booking, so a refusal reports the limits it ran under.
      const h = await current()
      const { mandate, hash: mandateHash } = h
      const before = await limits(h, gpuAsk(h, supplierId, terms))
      const leftBefore = before.amounts.left
      // The lock caps each mandate hash on its own, so the agent checks the total itself before
      // it signs anything, whatever cap Avow's approval carries.
      if (before.refused)
        throw await refusal(h, { ...before.refused, needed: reserve, leftBefore }, {})
      const supplier = m.suppliers.find((s) => s.id === supplierId) as SandboxSupplier
      const connection = await connectSupplier(supplier, send)
      const avow = httpAvowApi({
        baseUrl: deployment.apiUrl,
        key: agentRequestKey(m.agentKey),
        domain,
        retryFor: 120n,
        fetch: send,
      })
      // Avow's own refusal, kept so the refusal says which layer made it.
      let avowRefused: ReasonCode | null = null
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
        token,
        profile: TESTNET_DEMO_PROFILE,
        avow: watched,
        send: async (calls) => {
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
        if (error instanceof SupplierDeclined) {
          throw await refusal(
            h,
            { code: 'supplier.declined', layer: 'supplier', needed: reserve, leftBefore },
            { cause: error },
          )
        }
        if (error instanceof BookingError && error.outcome === 'failed') {
          throw await refusal(
            h,
            { ...fundingRefusal(error), needed: reserve, leftBefore },
            { cause: error },
          )
        }
        throw error
      }
      if (!booked.ok) {
        const layer: RefusalLayer = avowRefused === booked.reason ? 'avow' : 'sdk'
        throw await refusal(
          h,
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
      await addCommitment(m.store, {
        reference,
        amount: reserve,
        supplier: supplier.id,
        mandateHash,
        madeAt: systemClock(),
      })
      const open = await openAcross(h).catch(() => null)
      const left =
        open === null
          ? leftBefore > reserve
            ? leftBefore - reserve
            : 0n
          : open >= capOf(h)
            ? 0n
            : capOf(h) - open
      report({ type: 'committed', run, source, reference, amount: reserve })
      let acceptance: Promise<boolean> | null = null
      return {
        reference,
        link: verifyUrl(reference, m.screenUrl),
        amount: toDollars(reserve),
        left: toDollars(left),
        commitment,
        verify: () =>
          verifyCommitment({
            client,
            deployment,
            domain,
            commitment,
            reference,
            mandate: mandate.message,
            mandateHash,
            // The key carries the first mandate of the chain.
            witness: h.earlier.at(-1) ?? h.hash,
            account,
            agentKey: m.agentKey.accessKeyAddress,
            keyAuthorizedIn: m.keyAuthorizedIn,
          }),
        accepted() {
          acceptance ??= waitForAcceptance(client, lock, commitment).then((accepted) => {
            if (accepted) report({ type: 'accepted', run, source, reference })
            return accepted
          })
          return acceptance
        },
      }
    }
  }
}

/** Whether the account's keychain refused somewhere in an error's causes, over the daily limit. */
function keychainRefused(error: unknown): boolean {
  let e: unknown = error
  for (let i = 0; i < 6 && e instanceof Error; i++) {
    if (/SpendingLimitExceeded/.test(e.message)) return true
    e = e.cause
  }
  return false
}

/**
 * Who refused a reserve Avow had approved. The account's keychain refuses a key past its daily
 * limit when the transaction is prepared, and Avow's relay refuses with its own reason, or with
 * none when it can't be reached or hands back other bytes, which is the relay being unavailable. A
 * transaction that landed and reverted, or that reverted while the node prepared it, is the lock's
 * refusal. Anything else, such as one that expired in no block or that the node never took, is
 * unknown.
 */
export function fundingRefusal(error: unknown): { code: ReasonCode; layer: RefusalLayer } {
  if (keychainRefused(error)) return { code: 'keychain.over_daily_limit', layer: 'keychain' }
  const reason = relayReason(error)
  if (reason) return { code: reason, layer: 'relay' }
  const stopped = sendErrorIn(error)
  if (stopped?.stage === 'relay') return { code: 'service.unavailable', layer: 'relay' }
  if (stopped?.stage === 'altered') return { code: 'sponsorship.altered', layer: 'relay' }
  if (landedReverted(error) || (stopped?.stage === 'prepare' && /revert/i.test(stopped.message))) {
    return { code: 'chain.reserve_missing', layer: 'lock' }
  }
  return { code: 'chain.reserve_missing', layer: 'unknown' }
}

/** Every check the buyer's side can make of a commitment it funded, in order. */
async function verifyCommitment(m: {
  client: SandboxClient
  deployment: SandboxDeployment
  domain: AvowDomain
  commitment: Commitment
  reference: CommitmentReference
  mandate: Mandate
  mandateHash: Hex
  /** The mandate hash the key carries, the first of the agent's chain of mandates. */
  witness: Hex
  account: Address
  agentKey: Address
  keyAuthorizedIn: Hex
}): Promise<SandboxCheck[]> {
  const { client, deployment, domain, commitment } = m
  const a = commitment.approval.message
  const check = (name: string, reason: ReasonCode | null): SandboxCheck => ({
    name,
    passed: reason === null,
    reason,
  })
  const approvalReason =
    checkEnvelope(commitment.approval, {
      type: 'Approval',
      chainId: domain.chainId,
      lock: domain.verifyingContract,
    }) ??
    (a.commitmentId.toLowerCase() === commitment.commitmentId.toLowerCase()
      ? null
      : 'approval.commitment_mismatch') ??
    approvalPartiesProblem(a, commitment.supplier) ??
    approvalTokenProblem(a, deployment.token) ??
    approvalTermsProblem(a, {
      lock: lockTerms(commitment.terms, 6),
      termsHash: commitment.termsHash,
    }) ??
    approvalMandateProblem(a, {
      mandateHash: m.mandateHash,
      caps: approvalCaps(m.mandate, 6),
      fundingKeys: [m.agentKey],
    })
  const checks = [
    check(
      "Avow's approval names this commitment, the supplier, the token, your terms and your mandate",
      approvalReason,
    ),
  ]
  // A lock from any factory the SDK trusts counts, so a business set up under an earlier one
  // still checks its own bookings.
  const reader = trustedFactory(deployment.chainId, deployment.factory)
    ? trustedChainReader(client, deployment.chainId)
    : null
  if (!reader) {
    return [...checks, check('The SDK trusts a factory on this chain', 'chain.lock_unknown')]
  }
  // A node a block behind the one the reserve landed in doesn't show it yet, so each read waits.
  const settled = async <T extends { ok: boolean }>(read: () => Promise<T>): Promise<T> => {
    let result = await read()
    for (let i = 1; i < 4 && !result.ok; i++) {
      await pause(1500)
      result = await read()
    }
    return result
  }
  const unavailable = { ok: false as const, reason: 'service.unavailable' as ReasonCode }
  const onLock = await settled(() =>
    verifyCommitmentReference(m.reference, reader).catch(() => unavailable),
  )
  checks.push(
    check(
      "A lock Avow's factory made holds the commitment under your terms hash",
      onLock.ok ? null : onLock.reason,
    ),
  )
  const enforced = await settled(() =>
    verifyCommitmentTerms(
      {
        reference: m.reference,
        terms: commitment.terms,
        salt: commitment.salt,
        acceptedTokens: [moderatoUsdToken(deployment.token)],
      },
      reader,
    ).catch(() => unavailable),
  )
  checks.push(
    check('The lock enforces exactly what your terms map to', enforced.ok ? null : enforced.reason),
  )
  const held = await readBacking(client, domain.verifyingContract, commitment.commitmentId, 'buyer')
    .then((b) => b ?? null)
    .catch(() => undefined)
  checks.push(
    check(
      'The lock holds the reserve under the approval you checked',
      held === undefined
        ? 'service.unavailable'
        : held && held.approvalHash.toLowerCase() === approvalDigest(a, domain).toLowerCase()
          ? null
          : 'chain.approval_mismatch',
    ),
  )
  const key = await readAgentKey(client, m.account, m.agentKey, m.keyAuthorizedIn).catch(
    () => undefined,
  )
  checks.push(
    check(
      "Your agent's key is on the account, bound to your mandate",
      key === undefined
        ? 'service.unavailable'
        : key?.active && key.witness?.toLowerCase() === m.witness.toLowerCase()
          ? null
          : 'chain.agent_key_inactive',
    ),
  )
  return checks
}

/**
 * Follows the lock until the supplier accepts the reserve, or until the acceptance deadline has
 * passed on the chain's clock with a minute to spare. A read that fails is read again.
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
 * Asks the sandbox faucet for more test dollars for the agent's business, signed with the agent's
 * own key. Avow takes a top-up only from the root key or an agent the business approved and
 * hasn't revoked, so the agent needs its approval first. The dollars go to the business's account, never
 * its lock, so they change nothing the agent may commit. A business gets one top-up a day.
 */
export async function agentTopUp(
  options: Pick<SandboxAgentOptions, 'fetch' | 'store' | 'screenUrl' | 'deployment'> = {},
): Promise<TopUp> {
  const { send, deployment, agentKey, domain } = await agentContext(options)
  return sandboxTopUp({
    baseUrl: deployment.apiUrl,
    key: agentRequestKey(agentKey),
    domain,
    fetch: send,
  })
}

/**
 * Where one of the agent's own requests stands, by its id, signed with the agent's own key. It
 * reads and changes nothing, so it needs only the agent's folder.
 */
export async function agentRequest(
  id: string,
  options: Pick<SandboxAgentOptions, 'fetch' | 'store' | 'screenUrl' | 'deployment'> = {},
): Promise<AskedChange> {
  const { send, deployment, agentKey, domain } = await agentContext(options)
  return readOwnRequest({ apiUrl: deployment.apiUrl, agentKey, domain, send }, id)
}
