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
  isSessionId,
  lockTerms,
  type Mandate,
  type RailState,
  type ReasonCode,
  type RefusalAmounts,
  type RefusalLayer,
  type RequestKey,
  refusalSentence,
  type SandboxDeployment,
  type SandboxTool,
  type SessionEvent,
  type Signed,
  TESTNET_DEMO_PROFILE,
} from '@avow-finance/spec'
import {
  readAgentKey,
  readBacking,
  tempoChainReader,
  verifyCommitmentReference,
  verifyCommitmentTerms,
} from '@avow-finance/verifier'
import { type Address, type Hex, isAddressEqual } from 'viem'
import { Abis, Account, Addresses } from 'viem/tempo'
import { type AgentKey, BookingError, type Commitment, createAgent } from '../agent.js'
import type { AvowApi } from '../avow-api.js'
import { agentRequestKey, httpAvowApi, relayReason } from '../http.js'
import { readOpenReserves } from '../lock.js'
import { moderatoClient, moderatoUsdToken } from '../moderato.js'
import { landedReverted, sendErrorIn, sendSponsored } from '../send.js'
import { SupplierDeclined } from '../supplier.js'
import type { SandboxClient } from './business.js'
import { loadSandboxDeployment, madeOn, trustedFactory } from './deployment.js'
import { SANDBOX_SCREEN_URL, sessionRelay, verifyUrl } from './session.js'
import {
  addCommitment,
  loadAgentItem,
  loadCommitments,
  type SandboxStore,
  type SandboxSupplier,
} from './store.js'
import { connectSupplier } from './suppliers.js'
import { micros, type SandboxResource, sandboxTerms, toDollars } from './terms.js'

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
   * and the mandate's caps and hash. The lock has to be one the trusted factory made, holding the
   * commitment under the terms hash, enforcing what the terms map to, under the approval checked.
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
  /** The mandate the business's root key signed for the agent. */
  readonly mandate: Signed<Mandate>
  readonly mandateHash: Hex
  /** The authority the agent has left, in dollars, as the lock counts it. */
  left(): Promise<number>
  /** What the agent's key can still move today, in dollars, as the account's keychain counts it. */
  dailyLeft(): Promise<number | null>
  /** Every commitment the business's agents made, each with its state on the lock now. */
  commitments(): Promise<SandboxCommitmentRecord[]>
  /**
   * Books with one of the agent's suppliers. It resolves with the commitment once the reserve is
   * funded, and throws a `Refusal` when the booking is refused before any money moves.
   */
  book(booking: SandboxBooking): Promise<SandboxCommitment>
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
export const dailyLimitOf = (mandate: Mandate, token: Address): bigint | null =>
  mandate.paymentLimits.find((l) => isAddressEqual(l.token, token) && l.period === DAY)?.amount ??
  null

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
 * The agent of a sandbox business, acting with only its own key under the mandate its business
 * signed. It reads the agent's item from the store and never the business's key, and it has no
 * call that signs a mandate, enrolls a key or changes the authority. Run `npm start` first, which
 * sets the business up and asks before it signs the agent's mandate.
 */
export async function sandboxAgent(options: SandboxAgentOptions = {}): Promise<SandboxAgent> {
  const log = options.log ?? ((line: string) => console.log(line))
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
  const client: SandboxClient = moderatoClient(deployment.rpcUrl)
  const agentKey: AgentKey = Account.fromSecp256k1(item.agentKey, {
    access: item.business.account,
  })
  if (!isAddressEqual(agentKey.accessKeyAddress, item.mandate.message.agentKey)) {
    throw new Error("The agent's key isn't the one its mandate names")
  }
  const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: item.business.lock }
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
  return booker({
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

/** The agent's side of booking, under the mandate it holds. */
function booker(m: {
  deployment: SandboxDeployment
  client: SandboxClient
  store: SandboxStore
  agentKey: AgentKey
  mandate: Signed<Mandate>
  mandateHash: Hex
  keyAuthorizedIn: Hex
  business: { account: Address; lock: Address; businessId: string }
  suppliers: SandboxSupplier[]
  screenUrl: string
  run: number
  source: AgentSource
  report: (event: SessionEvent) => void
  send: typeof fetch
}): SandboxAgent {
  const { deployment, client, mandate, run, source, report, send } = m
  const { lock, account } = m.business
  const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: lock }
  const cap = mandate.message.capOpenReserves
  const dailyLimit = dailyLimitOf(mandate.message, deployment.token)
  const token = moderatoUsdToken(deployment.token)

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

  const dailyLeftNow = () =>
    dailyLimit === null
      ? Promise.resolve(null)
      : keyLeftToday(client, account, m.agentKey.accessKeyAddress, deployment.token)

  async function refusal(
    r: { code: ReasonCode; layer: RefusalLayer; needed: bigint; leftBefore: bigint },
    extra: { decisionId?: string | null; cause?: unknown },
  ): Promise<Refusal> {
    const left = await leftNow().catch(() => r.leftBefore)
    const dailyLeft = await dailyLeftNow().catch(() => null)
    const amounts = {
      needed: r.needed,
      left,
      authority: cap,
      capPerCommitment: mandate.message.capPerCommitment,
      dailyLimit,
      dailyLeft,
    }
    report({ type: 'refused', run, source, code: r.code, layer: r.layer, amounts })
    return new Refusal(
      { code: r.code, layer: r.layer, amounts, decisionId: extra.decisionId ?? null },
      extra.cause === undefined ? undefined : { cause: extra.cause },
    )
  }

  return {
    authority: toDollars(cap),
    dailyLimit: dailyLimit === null ? null : toDollars(dailyLimit),
    suppliers: m.suppliers,
    business: m.business,
    mandate,
    mandateHash: m.mandateHash,
    left: async () => toDollars(await leftNow()),
    dailyLeft: async () => {
      const left = await dailyLeftNow()
      return left === null ? null : toDollars(left)
    },

    async commitments() {
      const stored = await loadCommitments(m.store)
      return Promise.all(
        stored.map(async (c): Promise<SandboxCommitmentRecord> => {
          const held = await readBacking(
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
            state: held === undefined ? 'unread' : (held?.state ?? 'none'),
            current: c.mandateHash.toLowerCase() === m.mandateHash.toLowerCase(),
            releaseDate: held ? held.releaseDate : null,
          }
        }),
      )
    },

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
      const connection = await connectSupplier(supplier, send)
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
            { code: 'supplier.declined', layer: 'supplier', needed: reserve, leftBefore },
            { cause: error },
          )
        }
        if (error instanceof BookingError && error.outcome === 'failed') {
          throw await refusal(
            { ...fundingRefusal(error), needed: reserve, leftBefore },
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
      await addCommitment(m.store, {
        reference,
        amount: reserve,
        supplier: supplier.id,
        mandateHash: m.mandateHash,
        madeAt: systemClock(),
      })
      const left = await leftNow().catch(() => (leftBefore > reserve ? leftBefore - reserve : 0n))
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
            mandateHash: m.mandateHash,
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
    },
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
  account: Address
  agentKey: Address
  keyAuthorizedIn: Hex
}): Promise<SandboxCheck[]> {
  const { client, deployment, domain, commitment } = m
  const a = commitment.approval.message
  const factory = trustedFactory(deployment.chainId)
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
  if (!factory) {
    return [...checks, check('The SDK trusts a factory on this chain', 'chain.lock_unknown')]
  }
  const reader = tempoChainReader(client, { factory, chainId: deployment.chainId })
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
        : key?.active && key.witness?.toLowerCase() === m.mandateHash.toLowerCase()
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
