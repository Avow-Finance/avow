import {
  type Approval,
  approvalDigest,
  type BuyerSideReference,
  type ChainedJobTerms,
  type CheckedDependency,
  type ComputeOffer,
  type CustomerFact,
  type CustomerRefusal,
  type CustomerSaid,
  checkMandate,
  computeOfferCost,
  computeOfferTerms,
  DEMO_GPU_SUPPLIER,
  DEMO_JOB_TIMING,
  type DeliveryResult,
  demoComputeOffers,
  dollars,
  GPU_RESERVATION,
  isChainedTerms,
  type JobOffer,
  lockTerms,
  type Mandate,
  mandateHash,
  newSalt,
  type OrderScenario,
  type OrderState,
  type PaymentReference,
  type PinnedBlock,
  type QuoteRequest,
  type RailToken,
  type RequestKey,
  type Side,
  TEST_CUSTOMER_LABEL,
  TESTNET_DEMO_PROFILE,
  type TestCustomerProfile,
  termsHash,
  testnetDemoJobTerms,
} from '@avow-finance/spec'
import {
  type DependencyRecord,
  type LockedBacking,
  type PinnedLockReader,
  verifyDependencies,
} from '@avow-finance/verifier'
import { type Address, type Hex, isAddressEqual, keccak256, stringToHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { JobAcceptance } from '../job/accept.js'
import { quoteJob } from '../job/quote.js'
import { sandboxMandate } from '../sandbox/mandate.js'
import { SendError } from '../send.js'
import { chargeStanding } from './charge.js'
import type { ChainSnapshot } from './service-check.js'
import type {
  AuthorityNow,
  BookOutcome,
  CancelOutcome,
  ChargeReport,
  ChargeStanding,
  ChildChain,
  JobWorld,
  LockRead,
  QuoteOutcome,
  WorldBooking,
} from './world.js'

/**
 * The fixture world: the sandbox in memory, for tests and the eval. Its customer verifies a quote
 * with the real `verifyDependencies`, its Avow approves a booking with the real `checkMandate`, and
 * its chain keeps every lock's records with blocks that advance with its clock, which only runs when
 * the session waits. Its keys are made for each run. It never stands for testnet, and whatever
 * draws it says it's the fixture world.
 */

const CHAIN_ID = 42431
const FACTORY: Address = '0x00000000000000000000000000000000000fac01'
const ARBITER: Address = '0x000000000000000000000000000000000000a4b1'
const TOKEN: RailToken = {
  rail: 'tempo',
  chainId: CHAIN_ID,
  token: '0x20c0000000000000000000000000000000000001',
  currency: 'USD',
  decimals: 6,
}
/** Where the fixture's clock starts, in unix seconds, so every run reads the same. */
export const FIXTURE_START = 1_800_000_000n

/**
 * When Avow records a job's cancellation: from its start, when free cancellation ends, until its
 * no-show charge can be reported.
 */
function cancellationWindow(offer: JobOffer): { opens: bigint; closes: bigint } {
  const r = offer.terms.remedies
  const noShow = r.charges.find((c) => c.kind === 'noShow')
  return { opens: r.freeCancelBy, closes: noShow?.earliest ?? r.chargeDeadline }
}

const key = (lock: Address, commitmentId: Hex, side: Side) =>
  `${lock.toLowerCase()}:${commitmentId.toLowerCase()}:${side}`
const bytes32 = (label: string) => keccak256(stringToHex(label))
const orderIdOf = (n: number) => keccak256(stringToHex(`order ${n}`)).slice(2, 34)

interface Order {
  offer: JobOffer
  quote: QuoteRequest | null
  status: OrderState['status']
  said: CustomerSaid[]
  facts: CustomerFact[]
  refusal: CustomerRefusal | null
  checks: CheckedDependency[]
  reserve: { reference: BuyerSideReference; amount: bigint; fundedIn: Hex } | null
  payment: PaymentReference | null
  scenario: OrderScenario | null
  /** When the customer cancelled, and whether Avow recorded its signed cancellation. */
  cancelled: { at: bigint; recorded: boolean } | null
  /** How many reads the customer takes before it moves the order on, as a real one takes time. */
  reads: number
}

export interface FixtureOptions {
  /** The agent's authority in dollars, $500 by default. */
  authority?: number
  /**
   * What becomes of a charge reported on a job the customer cancelled. `pays` is Avow confirming it
   * and the lock paying it once its contest window closes, the default. `contested` is the customer
   * contesting the confirmed charge. `referred` is a customer that says it cancelled without Avow
   * holding its signed cancellation, so Avow refers the report. `unanswered` is Avow never
   * answering, so the report times out at its deadline.
   */
  charge?: 'pays' | 'contested' | 'referred' | 'unanswered'
}

/** How long Avow has to answer a report in the fixture world, in seconds. */
export const FIXTURE_CONFIRM_WINDOW = 600n
/** How long after a report the fixture world's Avow answers it, in seconds. */
const AVOW_ANSWERS_AFTER = 6n
/**
 * How far a cancellation has to sit from the report and from each end of the time Avow records
 * one in, in seconds, before the fixture world's Avow confirms a charge from it. Closer than that,
 * Avow's clock and the chain's could disagree about the order, so the report is referred.
 */
const AVOW_CLOCK_MARGIN = 30n

export interface FixtureWorld extends JobWorld {
  readonly kind: 'fixture'
  /** The private keys the fixture made, so the eval can check none reaches the model. */
  readonly secrets: readonly Hex[]
  /** Every transaction hash an acceptance sent, for tests that check which landed. */
  readonly acceptances: Hex[]
  /** Makes the next `count` acceptances throw as a send whose outcome is unknown, after landing. */
  failAcceptances(count: number): void
}

export function fixtureWorld(options: FixtureOptions = {}): FixtureWorld {
  let now = FIXTURE_START
  let block = 1_000n
  const head = (): PinnedBlock => ({
    number: block,
    hash: bytes32(`block ${block}`),
    timestamp: now,
  })
  const records = new Map<string, LockedBacking>()
  const locks = new Map<string, { account: Address }>()

  const rootKey = generatePrivateKey()
  const root = privateKeyToAccount(rootKey)
  const agentKey = generatePrivateKey()
  const agent = privateKeyToAccount(agentKey)
  const signingSecret = generatePrivateKey()
  const signing = privateKeyToAccount(signingSecret)
  const customerRootKey = generatePrivateKey()
  const customerRoot = privateKeyToAccount(customerRootKey)
  const customerAgent = privateKeyToAccount(generatePrivateKey()).address
  const gpuCloud = privateKeyToAccount(generatePrivateKey()).address
  const businessLock: Address = '0x00000000000000000000000000000000000010c6'
  const customerLock: Address = '0x00000000000000000000000000000000000010c4'
  locks.set(businessLock.toLowerCase(), { account: root.address })
  locks.set(customerLock.toLowerCase(), { account: customerRoot.address })

  const authority = dollars(options.authority ?? 500)
  const mandate: Mandate = sandboxMandate({
    businessId: 'fixture-business',
    agentId: 'agt_fixture',
    account: root.address,
    agentKey: agent.address,
    suppliers: [DEMO_GPU_SUPPLIER],
    token: TOKEN.token,
    capPerCommitment: authority,
    capOpenReserves: authority,
    expiry: FIXTURE_START + 86_400n,
  })
  const businessMandate = mandateHash(mandate, {
    chainId: CHAIN_ID,
    verifyingContract: businessLock,
  })
  const customer: TestCustomerProfile = {
    label: TEST_CUSTOMER_LABEL,
    businessId: 'fixture-test-customer',
    account: customerRoot.address,
    lock: customerLock,
    chainId: CHAIN_ID,
    mandateHash: bytes32('the fixture customer mandate'),
    limits: { reserve: dollars(25), price: dollars(100), openOrders: 2 },
  }
  const supplier = { account: root.address, signingKey: signing.address, payee: root.address }
  const signingKey: RequestKey = {
    address: signing.address,
    signDigest: (digest) => signing.sign({ hash: digest }),
  }
  const orders = new Map<string, Order>()
  const bookings: { reference: BuyerSideReference; reserve: bigint }[] = []
  /** When each report landed, by the commitment it's on. */
  const reports = new Map<string, bigint>()
  let acceptFails = 0
  const acceptances: Hex[] = []
  let orderCount = 0
  let txCount = 0
  const tx = (label: string) => bytes32(`${label} ${++txCount}`)

  const reader: PinnedLockReader = {
    chainId: CHAIN_ID,
    factory: FACTORY,
    head: async () => head(),
    blockHash: async (n) => (n <= block ? bytes32(`block ${n}`) : null),
    isLock: async (lock) => locks.has(lock.toLowerCase()),
    lockFields: async (lock) => {
      const found = locks.get(lock.toLowerCase())
      if (!found) throw new Error(`No contract at ${lock}`)
      return { factory: FACTORY, account: found.account }
    },
    commitment: async (lock, commitmentId, side): Promise<DependencyRecord | null> => {
      const r = records.get(key(lock, commitmentId, side))
      return r
        ? {
            state: r.state,
            hasReport: r.hasReport,
            termsHash: r.termsHash,
            supplier: r.supplier,
            freeCancelBy: r.freeCancelBy,
          }
        : null
    },
  }

  /** What a lock records for a reserve funded under an approval built from the terms. */
  function record(a: Approval, state: LockedBacking['state']): LockedBacking {
    return {
      state,
      token: a.token,
      amount: a.amount,
      held: a.amount,
      payee: a.payee,
      supplier: a.supplier,
      supplierSigner: a.supplierSigner,
      freeCancelBy: a.freeCancelBy,
      acceptBy: a.acceptBy,
      chargeDeadline: a.chargeDeadline,
      contestWindow: a.contestWindow,
      releaseDate: a.releaseDate,
      charges: a.charges,
      day90SupplierShareBps: a.day90SupplierShareBps,
      arbiter: a.arbiter,
      termsHash: a.termsHash,
      mandateHash: a.mandateHash,
      approvalHash: approvalDigest(a, { chainId: CHAIN_ID, verifyingContract: customerLock }),
      fundingKey: a.fundingKey,
      reportCount: 0,
      reportKind: null,
      reportAmount: 0n,
      hasReport: false,
      contested: false,
      chargeStart: 0n,
      pausedAt: 0n,
      hasRuling: false,
    }
  }

  function approval(
    commitmentId: Hex,
    terms: Parameters<typeof lockTerms>[0],
    salt: Hex,
    parties: { supplier: Address; signer: Address; payee: Address },
    funding: { mandateHash: Hex; key: Address },
  ): Approval {
    return {
      commitmentId,
      token: TOKEN.token,
      ...lockTerms(terms, TOKEN.decimals),
      supplier: parties.supplier,
      supplierSigner: parties.signer,
      payee: parties.payee,
      termsHash: termsHash(terms, salt),
      mandateHash: funding.mandateHash,
      capPerCommitment: authority,
      capOpenReserves: authority,
      fundingKey: funding.key,
      nonce: 1n,
      expiry: now + 120n,
    }
  }

  const openReserves = () =>
    bookings.reduce((sum, b) => {
      const r = records.get(key(b.reference.lock, b.reference.commitmentId, 'buyer'))
      return r && (r.state === 'reserved' || r.state === 'accepted') ? sum + b.reserve : sum
    }, 0n)

  const readOf = (r: LockedBacking): LockRead => ({
    state: r.state,
    block: head(),
    freeCancelBy: r.freeCancelBy,
    releaseDate: r.releaseDate,
  })

  /** The customer's check of a quote, as its verifier runs it. */
  async function verify(order: Order): Promise<void> {
    const quote = order.quote
    if (!quote) return
    const refuse = (refusal: CustomerRefusal, line: string) => {
      order.status = 'refused'
      order.refusal = refusal
      order.said.push({ index: order.said.length, text: line })
    }
    if (!isChainedTerms(quote.terms)) {
      refuse(
        { code: 'dependency.required', layer: 'customer', block: null, index: null },
        "Your quote names no compute booking, so I can't rely on it to start my job.",
      )
      return
    }
    const checked = await verifyDependencies(
      {
        terms: quote.terms,
        approval: { side: 'buyer', supplier: supplier.account },
        disclosed: quote.disclosed,
        now,
      },
      { readers: [reader] },
    )
    if (!checked.ok) {
      refuse(
        { code: checked.reason, layer: 'customer', block: checked.block, index: checked.index },
        "The compute booking your quote names doesn't hold up, so I won't commit.",
      )
      return
    }
    order.checks = [...checked.checked]
    for (const c of checked.checked) {
      order.facts.push({
        index: order.facts.length,
        text: 'Your compute booking is accepted, past its free cancellation, and holds the GPUs for the whole job.',
        check: 'dependency',
        verifiedBy: 'customer',
        reference: c.on,
        block: c.block,
        transactionHash: null,
      })
    }
    // The customer reserves for the job in its own lock, under an approval naming this supplier.
    const terms = quote.terms as ChainedJobTerms
    const a = approval(
      order.offer.commitmentId,
      terms,
      quote.salt,
      { supplier: supplier.account, signer: supplier.signingKey, payee: supplier.payee },
      { mandateHash: customer.mandateHash, key: customerAgent },
    )
    records.set(key(customerLock, order.offer.commitmentId, 'buyer'), record(a, 'reserved'))
    const reference: BuyerSideReference = {
      kind: 'commitment',
      chainId: CHAIN_ID,
      lock: customerLock,
      commitmentId: order.offer.commitmentId,
      side: 'buyer',
      termsHash: quote.agreement.termsHash,
    }
    const fundedIn = tx('the customer reserves')
    order.reserve = { reference, amount: a.amount, fundedIn }
    order.status = 'reserved'
    order.said.push({
      index: order.said.length,
      text: 'Verified. I reserved for the job in my lock.',
    })
    order.facts.push({
      index: order.facts.length,
      text: 'The customer reserved for the job in its own lock.',
      check: 'reserve',
      verifiedBy: 'customer',
      reference,
      block: head(),
      transactionHash: fundedIn,
    })
  }

  const world: FixtureWorld = {
    kind: 'fixture',
    customer,
    computeSupplier: DEMO_GPU_SUPPLIER,
    supplier,
    token: { address: TOKEN.token, decimals: TOKEN.decimals },
    secrets: [rootKey, agentKey, signingSecret, customerRootKey],
    acceptances,
    failAcceptances(count) {
      acceptFails = count
    },

    async pullOrder(scenario) {
      const n = ++orderCount
      const orderId = orderIdOf(n)
      // The test customer's own clock: open for a quote, then the acceptance window, then work.
      const startsAt = now + DEMO_JOB_TIMING.quote + DEMO_JOB_TIMING.accept
      const offer: JobOffer = {
        orderId,
        commitmentId: bytes32(`job ${n}`),
        customer: { label: TEST_CUSTOMER_LABEL, businessId: customer.businessId },
        supplierBusinessId: 'fixture-business',
        terms: testnetDemoJobTerms(startsAt, ARBITER),
        requirement: { template: GPU_RESERVATION, condition: 'accepted', disclosed: 'subject' },
        expiry: now + DEMO_JOB_TIMING.quote,
      }
      orders.set(orderId, {
        offer,
        quote: null,
        status: 'offered',
        said: [],
        facts: [],
        refusal: null,
        checks: [],
        reserve: null,
        payment: null,
        scenario: scenario ?? null,
        cancelled: null,
        reads: 0,
      })
      return offer
    },

    async offers(order) {
      const s = order.terms.subject
      return demoComputeOffers({ startsAt: s.startsAt, deliverBy: s.deliverBy, listedAt: now })
    },

    async book(offer: ComputeOffer, gpus: number): Promise<BookOutcome> {
      const terms = computeOfferTerms(offer, gpus, {
        arbiter: ARBITER,
        day90SupplierShareBps: 5000,
      })
      const { reserve, price } = computeOfferCost(offer, gpus)
      const open = openReserves()
      const amounts = {
        needed: reserve,
        left: authority - open,
        authority,
        capPerCommitment: authority,
        dailyLimit: dollars(1000),
        dailyLeft: dollars(1000),
      }
      const request = {
        commitmentId: bytes32(`compute ${bookings.length + 1}`),
        agentKey: agent.address,
        supplier: offer.supplier,
        payee: gpuCloud,
        category: 'compute',
        terms,
      }
      // The SDK runs the mandate check first, counting nothing open, as Avow's check does after it.
      const sdk = checkMandate({
        mandate,
        request,
        token: TOKEN,
        openReserves: 0n,
        revoked: false,
        now,
        profile: TESTNET_DEMO_PROFILE,
      })
      if (sdk.result !== 'approved') return { ok: false, code: sdk.reason, layer: 'sdk', amounts }
      const avow = checkMandate({
        mandate,
        request,
        token: TOKEN,
        openReserves: open,
        revoked: false,
        now,
        profile: TESTNET_DEMO_PROFILE,
      })
      if (avow.result !== 'approved')
        return { ok: false, code: avow.reason, layer: 'avow', amounts }
      const salt = newSalt()
      const a = approval(
        request.commitmentId,
        terms,
        salt,
        { supplier: gpuCloud, signer: gpuCloud, payee: gpuCloud },
        { mandateHash: businessMandate, key: agent.address },
      )
      const reference: BuyerSideReference = {
        kind: 'commitment',
        chainId: CHAIN_ID,
        lock: businessLock,
        commitmentId: request.commitmentId,
        side: 'buyer',
        termsHash: a.termsHash,
      }
      now += 4n
      block += 4n
      // The GPU supplier accepts at once.
      records.set(key(businessLock, request.commitmentId, 'buyer'), record(a, 'accepted'))
      bookings.push({ reference, reserve })
      const held = records.get(key(businessLock, request.commitmentId, 'buyer')) as LockedBacking
      return {
        ok: true,
        booking: {
          offer,
          gpus,
          reference,
          terms,
          salt,
          reserve,
          price,
          reservedIn: tx('the compute reserve'),
          read: readOf(held),
        },
      }
    },

    async authority(): Promise<AuthorityNow> {
      return {
        capPerCommitment: authority,
        capOpenReserves: authority,
        openReservesLeft: authority - openReserves(),
        dailyLimit: dollars(1000),
        dailyLeft: dollars(1000),
        suppliers: [DEMO_GPU_SUPPLIER],
      }
    },

    async read(reference) {
      const r = records.get(key(reference.lock, reference.commitmentId, reference.side))
      return r ? readOf(r) : null
    },

    async quote(order, booking: WorldBooking | null): Promise<QuoteOutcome> {
      const held = orders.get(order.orderId)
      if (!held) return { ok: false, code: 'order.unknown', layer: 'customer' }
      if (held.quote) return { ok: false, code: 'order.out_of_step', layer: 'customer' }
      const quote = await quoteJob({
        offer: order,
        customer,
        supplier: { businessId: 'fixture-business', ...supplier },
        signingKey,
        compute: booking
          ? { reference: booking.reference, terms: booking.terms, salt: booking.salt }
          : null,
        expiry: now + 120n,
      })
      held.quote = quote
      held.status = 'verifying'
      held.said.push({
        index: held.said.length,
        text: 'Before I accept, I need to verify your compute.',
      })
      return { ok: true, quote }
    },

    async orderState(orderId): Promise<OrderState> {
      const o = orders.get(orderId)
      if (!o) throw new Error(`No order ${orderId}`)
      o.reads++
      if (o.status === 'verifying' && o.reads > 1) await verify(o)
      // A customer asked to cancel late does, shortly after the start and before the no-show charge.
      // It cancels halfway through the time Avow records a cancellation in, clear of both ends.
      const window = cancellationWindow(o.offer)
      const cancelsAt = window.opens + (window.closes - window.opens) / 2n
      if (o.status === 'accepted' && o.scenario === 'cancels_late' && now >= cancelsAt) {
        o.status = 'cancelled'
        o.cancelled = { at: now, recorded: options.charge !== 'referred' }
        o.said.push({
          index: o.said.length,
          text: "I'm cancelling this job after its start. My reserve backs the late-cancellation charge our terms set.",
        })
      }
      if (o.status === 'delivered' && o.reads > 1 && o.reserve) {
        o.status = 'paid'
        const price =
          o.offer.terms.consideration.kind === 'fixed' ? o.offer.terms.consideration.amount : 0n
        o.payment = {
          kind: 'payment',
          chainId: CHAIN_ID,
          transactionHash: tx('the payment'),
          logIndex: 0,
          token: TOKEN.token,
          from: customer.account,
          to: supplier.payee,
          amount: price,
          memo: o.offer.commitmentId,
        }
        o.said.push({ index: o.said.length, text: 'Received the result. I paid the price.' })
      }
      const common = {
        orderId,
        commitmentId: o.offer.commitmentId,
        customer: o.offer.customer,
        supplierBusinessId: o.offer.supplierBusinessId,
        said: o.said.map((s) => ({ ...s })),
        facts: o.facts.map((f) => ({ ...f })),
      }
      if (o.status === 'offered' || o.status === 'verifying') return { ...common, status: o.status }
      if (o.status === 'refused' && o.refusal) {
        return { ...common, status: 'refused', refusal: o.refusal, checks: o.checks }
      }
      if (!o.reserve) throw new Error(`Order ${orderId} has no reserve`)
      if (o.status === 'cancelled' && o.cancelled) {
        return {
          ...common,
          status: 'cancelled',
          checks: o.checks,
          reserve: o.reserve,
          cancellation: { cancelledAt: o.cancelled.at },
        }
      }
      if (o.status === 'paid' && o.payment) {
        return {
          ...common,
          status: 'paid',
          checks: o.checks,
          reserve: o.reserve,
          payment: o.payment,
        }
      }
      return {
        ...common,
        status: o.status as 'reserved' | 'accepted' | 'delivered',
        checks: o.checks,
        reserve: o.reserve,
      }
    },

    async accept(order, quote): Promise<JobAcceptance> {
      const k = key(customerLock, order.commitmentId, 'buyer')
      const r = records.get(k)
      if (!r)
        return { ok: false, code: 'chain.reserve_missing', layer: 'avow', block: null, index: null }
      if (!isAddressEqual(r.supplierSigner, supplier.signingKey)) {
        return {
          ok: false,
          code: 'approval.parties_mismatch',
          layer: 'service',
          block: null,
          index: null,
        }
      }
      const relied = await verifyDependencies(
        {
          terms: quote.terms as ChainedJobTerms,
          approval: { side: 'buyer', supplier: supplier.account },
          disclosed: quote.disclosed,
          now,
        },
        { readers: [reader] },
      )
      if (!relied.ok) {
        return {
          ok: false,
          code: relied.reason,
          layer: 'service',
          block: relied.block,
          index: relied.index,
        }
      }
      if (r.state === 'accepted') return { ok: true, sent: null, checks: relied.checked }
      const hash = tx('the acceptance')
      acceptances.push(hash)
      now += 2n
      block += 2n
      records.set(k, { ...r, state: 'accepted' })
      const o = orders.get(order.orderId)
      if (o) o.status = 'accepted'
      if (acceptFails > 0) {
        acceptFails--
        throw new SendError(
          `No receipt for ${hash} after waiting`,
          'unknown',
          { hashes: [hash], signings: 1 },
          { stage: 'landed' },
        )
      }
      return {
        ok: true,
        sent: {
          acceptance: {
            type: 'Acceptance',
            schemaVersion: '1',
            chainId: CHAIN_ID,
            lock: customerLock,
            message: {
              commitmentId: order.commitmentId,
              side: 'buyer',
              approvalHash: r.approvalHash,
              termsHash: r.termsHash,
              amount: r.amount,
              token: r.token,
              acceptBy: r.acceptBy,
              nonce: 1n,
              expiry: now + 600n,
            },
            signature: '0x',
          },
          disclosureId: bytes32(`disclosure ${hash}`),
          landed: { transactionHash: hash, blockNumber: block },
        },
        checks: relied.checked,
      }
    },

    async landed(hashes) {
      const found = hashes.find((h) => acceptances.includes(h))
      return found ? { transactionHash: found, blockNumber: block } : null
    },

    async reportCharge(order, kind): Promise<ChargeReport> {
      // The lock's own rules for a report, as the verifier checks them before it builds one.
      const k = key(customerLock, order.commitmentId, 'buyer')
      const r = records.get(k)
      const refuse = (code: Extract<ChargeReport, { ok: false }>['code']): ChargeReport => ({
        ok: false,
        code,
        layer: 'service',
      })
      if (!r) return refuse('chain.reserve_missing')
      if (r.state !== 'accepted') return refuse('report.not_reportable')
      if (r.hasReport) return refuse('report.open')
      const charge = r.charges.find((c) => c.kind === kind)
      if (!charge) return refuse('report.kind_not_allowed')
      if (now < charge.earliest) return refuse('report.too_early')
      if (now >= r.chargeDeadline) return refuse('commitment.ended')
      now += 2n
      block += 2n
      const reportNumber = r.reportCount + 1
      records.set(k, {
        ...r,
        hasReport: true,
        reportCount: reportNumber,
        reportKind: kind,
        reportAmount: charge.most,
      })
      reports.set(k, now)
      return {
        ok: true,
        amount: charge.most,
        reportNumber,
        transactionHash: tx('the report'),
        reportedAt: now,
      }
    },

    async charge(order, report): Promise<ChargeStanding> {
      // What Avow, the customer and the lock's own clock do to a report, each step once.
      const k = key(customerLock, order.commitmentId, 'buyer')
      const o = orders.get(order.orderId)
      const reportedAt = reports.get(k)
      let r = records.get(k)
      const how = options.charge ?? 'pays'
      if (r && reportedAt !== undefined) {
        const answerDue = now >= reportedAt + AVOW_ANSWERS_AFTER
        if (r.state === 'accepted' && r.hasReport && how !== 'unanswered' && answerDue) {
          // Avow confirms only from its own record of the customer's signed cancellation, and only
          // one clear of the report and of both ends of the time it records cancellations in.
          const at = o?.cancelled?.recorded ? o.cancelled.at : null
          const window = o ? cancellationWindow(o.offer) : null
          const clear =
            at !== null &&
            window !== null &&
            at <= reportedAt - AVOW_CLOCK_MARGIN &&
            at >= window.opens + AVOW_CLOCK_MARGIN &&
            at <= window.closes - AVOW_CLOCK_MARGIN
          r = clear
            ? { ...r, state: 'charge_pending', chargeStart: now, held: r.reportAmount }
            : { ...r, state: 'paused', pausedAt: now }
        } else if (
          r.state === 'accepted' &&
          r.hasReport &&
          now >= reportedAt + FIXTURE_CONFIRM_WINDOW
        ) {
          r = { ...r, state: 'paused', pausedAt: reportedAt + FIXTURE_CONFIRM_WINDOW }
        } else if (r.state === 'charge_pending' && how === 'contested' && now > r.chargeStart) {
          r = { ...r, state: 'paused', contested: true, pausedAt: now }
        } else if (r.state === 'charge_pending' && now >= r.chargeStart + r.contestWindow) {
          r = { ...r, state: 'charged', held: 0n }
        }
        records.set(k, r)
      }
      return chargeStanding(r ?? null, report, FIXTURE_CONFIRM_WINDOW)
    },

    async deliver(orderId, _result: DeliveryResult) {
      const o = orders.get(orderId)
      if (!o) throw new Error(`No order ${orderId}`)
      if (o.status === 'cancelled') throw new Error(`Order ${orderId} was cancelled`)
      o.status = 'delivered'
      o.reads = 0
    },

    async cancel(booking): Promise<CancelOutcome> {
      const k = key(booking.reference.lock, booking.reference.commitmentId, 'buyer')
      const r = records.get(k)
      if (!r)
        return {
          ok: false,
          code: 'chain.reserve_missing',
          layer: 'lock',
          why: 'The lock holds no such booking.',
        }
      records.set(k, { ...r, state: 'released' })
      return { ok: true, transactionHash: tx('the cancellation') }
    },

    async chainFor(job): Promise<ChildChain> {
      const wanted = [job.commitment, ...job.verification.dependencies.map((d) => d.on)]
      const byLock = new Map<string, ChainSnapshot['locks'][number]>()
      for (const ref of wanted) {
        const r = records.get(key(ref.lock, ref.commitmentId, ref.side))
        const lock = locks.get(ref.lock.toLowerCase())
        if (!lock) continue
        const entry = byLock.get(ref.lock.toLowerCase()) ?? {
          address: ref.lock,
          account: lock.account,
          records: [],
        }
        if (r)
          entry.records.push({ commitmentId: ref.commitmentId, side: ref.side, record: { ...r } })
        byLock.set(ref.lock.toLowerCase(), entry)
      }
      return {
        kind: 'snapshot',
        snapshot: {
          chainId: CHAIN_ID,
          factory: FACTORY,
          block: head(),
          locks: [...byLock.values()],
        },
      }
    },

    now: () => now,
    async sleep(ms) {
      const seconds = BigInt(Math.max(1, Math.ceil(ms / 1000)))
      now += seconds
      block += seconds
    },
  }
  return world
}
