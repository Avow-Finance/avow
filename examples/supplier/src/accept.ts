import { type Call, type OnSent, SendError } from '@avow-finance/sdk'
import {
  type HashSigner,
  type ReplayGuard,
  type SupplierAuthorizationAnswer,
  toWire,
} from '@avow-finance/spec'
import {
  type AcceptanceConfig,
  type Agreed,
  acceptCall,
  type ChainReader,
  prepareAcceptance,
  signAcceptance,
  verifySupplierAuthorization,
} from '@avow-finance/verifier'
import type { Address, Hex } from 'viem'
import { showDisclosure } from './disclosure.js'
import type { Booking, BookingStatus, SupplierStore } from './store.js'

export interface AcceptDeps {
  store: SupplierStore
  /** The verifier's settings, with the supplier's account and signing key. */
  config: AcceptanceConfig
  chain: ChainReader
  replay: ReplayGuard
  /** Asks Avow for a fresh authorization for a commitment, signed with the signing key. */
  authorize: (c: {
    chainId: number
    lock: Address
    commitmentId: Hex
  }) => Promise<SupplierAuthorizationAnswer>
  signingKey: HashSigner
  /** Sends a call the signing key pays the fee for, and resolves with its receipt once it lands. */
  send: (call: Call, onSent: OnSent) => Promise<{ status: 'success' | 'reverted' }>
  /** The lock's state for a commitment now, or null when it holds none. */
  lockState: (lock: Address, commitmentId: Hex) => Promise<string | null>
  /** The latest finalized block's time. */
  finalizedTime: () => Promise<bigint>
  now: () => bigint
  log: (line: string) => void
}

/** Every message crosses JSON on its way to the verifier, as it would between two businesses. */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(toWire(value)))

/**
 * Moves one booking on. Once the agent funds the reserve, Avow authorizes it, and the supplier's
 * verifier checks Avow's authorization, the buyer's mandate and the lock before the supplier holds
 * capacity. Then it checks Avow's approval against the supplier's own terms and the lock, signs
 * the acceptance it builds and sends it to the lock. Until the acceptance lands the reserve can
 * still go back to the business, so the supplier grants the capacity only once the acceptance's
 * receipt, or the lock itself, shows the lock took it. A booking whose reserve never arrives
 * lapses at its acceptance deadline.
 */
export async function advance(deps: AcceptDeps, booking: Booking): Promise<BookingStatus> {
  const { store } = deps
  // What every status shares. Each save builds the booking whole from it, so a status records an
  // acceptance transaction only when it's one that sends or keeps one.
  const { status: _status, sent: _sent, ...record } = booking
  let b = booking
  const save = (next: Booking): BookingStatus => {
    store.put(next)
    b = next
    return next.status
  }
  /** Grants the capacity the supplier held, which it does only once the lock holds the acceptance. */
  const grant = (shownBy: string) => {
    // Here a real supplier grants the capacity it held for the booking.
    deps.log(`granting the capacity held for ${b.commitmentId}, now that ${shownBy}`)
    // The accepted booking keeps the acceptance transaction sent for it, when there was one.
    const { sent } = b
    return save(sent ? { ...record, status: 'accepted', sent } : { ...record, status: 'accepted' })
  }

  if (b.status === 'accepting') {
    // The lock's own state shows the acceptance landed as surely as its receipt would.
    if ((await deps.lockState(b.lock, b.commitmentId)) === 'accepted') {
      return grant('the lock shows the acceptance')
    }
    // A send is recorded before its bytes go out, so without one nothing went out.
    if (b.sent) {
      const { validBefore } = b.sent
      // Until the chain is past the transaction's validity, it may still land.
      if (validBefore === null || (await deps.finalizedTime()) <= validBefore) return 'accepting'
      deps.log(`the acceptance for ${b.commitmentId} never landed, so it goes again`)
    }
    save({ ...record, status: 'held' })
  }
  if (deps.now() >= b.terms.remedies.acceptBy) {
    deps.log(`the reserve for ${b.commitmentId} never came before its acceptance deadline`)
    return save({ ...record, status: 'lapsed' })
  }

  const answer = await deps.authorize({
    chainId: b.chainId,
    lock: b.lock,
    commitmentId: b.commitmentId,
  })
  if (!answer.ok) {
    if (answer.reason === 'chain.reserve_accepted') {
      if ((await deps.lockState(b.lock, b.commitmentId)) === 'accepted') {
        return grant('the lock shows the acceptance')
      }
    }
    // A reserve not funded yet is the usual answer while the agent pays, so only others are noted.
    if (answer.reason !== 'chain.reserve_missing') {
      deps.log(`Avow signed no authorization for ${b.commitmentId}: ${answer.reason}`)
    }
    return b.status
  }

  const a = b.agreement
  const agreed: Required<Agreed> = {
    commitmentId: a.commitmentId,
    termsHash: a.termsHash,
    category: a.category,
    buyerBusinessId: a.buyerBusinessId,
    mandateHash: a.mandateHash,
  }
  const now = deps.now()
  if (b.status === 'agreed') {
    const verified = await verifySupplierAuthorization(
      {
        authorization: json(answer.authorization),
        agreed,
        terms: b.terms,
        mandate: json(answer.mandate),
        now,
      },
      { config: deps.config, chain: deps.chain, replay: deps.replay },
    )
    if (!verified.ok) {
      deps.log(
        `the verifier refused Avow's authorization for ${b.commitmentId}: ${verified.reason}`,
      )
      return b.status
    }
    // Here a real supplier holds the capacity the booking needs, and grants none of it yet.
    deps.log(
      `holding capacity for ${b.commitmentId}, which Avow authorized, until the lock accepts`,
    )
    save({ ...record, status: 'held' })
  }

  const prepared = await prepareAcceptance(
    {
      authorization: json(answer.authorization),
      approval: json(answer.approval),
      mandate: json(answer.mandate),
      agreed,
      terms: b.terms,
      now,
    },
    { config: deps.config, chain: deps.chain },
  )
  if (!prepared.ok) {
    deps.log(`the verifier built no acceptance for ${b.commitmentId}: ${prepared.reason}`)
    return b.status
  }
  showDisclosure(prepared.disclosure, deps.log)
  const acceptance = await signAcceptance(prepared, deps.signingKey, {
    disclosureId: prepared.disclosure.id,
  })
  save({ ...record, status: 'accepting' })
  let receipt: { status: 'success' | 'reverted' }
  try {
    receipt = await deps.send(acceptCall(acceptance), (hash, validBefore) => {
      save({ ...record, status: 'accepting', sent: { hash, validBefore } })
    })
  } catch (e) {
    if (e instanceof SendError && e.outcome === 'failed') {
      deps.log(`sending the acceptance for ${b.commitmentId} failed: ${e.message}`)
      return save({ ...record, status: 'held' })
    }
    throw e
  }
  if (receipt.status !== 'success') {
    deps.log(`the acceptance for ${b.commitmentId} reverted, so the lock didn't take it`)
    return save({ ...record, status: 'held' })
  }
  return grant("the acceptance's receipt shows the lock took it")
}

/** Whether a booking is done with, which an accepted or a lapsed one is. */
const finished = (status: BookingStatus) => status === 'accepted' || status === 'lapsed'

/**
 * The supplier's poll, which moves every open booking on each time it runs. Each booking moves on
 * by itself, so one that fails, or whose file the store refuses, holds up none of the rest. The
 * poll reads a booking it found accepted or lapsed once and never again. A file the store refuses
 * is logged once and read again only once its text changes, so a damaged file doesn't fill the
 * log and a mended one moves on at the next poll. A booking whose move fails is tried again at
 * every poll, and logged each time.
 */
export function bookingPoller(deps: AcceptDeps): () => Promise<void> {
  const done = new Set<Hex>()
  /** The text of each file the store refused, as it was when refused. */
  const refused = new Map<Hex, string>()
  const note = (id: Hex, e: unknown) =>
    deps.log(`booking ${id}: ${e instanceof Error ? e.message : String(e)}`)
  return async () => {
    for (const id of deps.store.commitmentIds()) {
      if (done.has(id)) continue
      let b: Booking
      try {
        const text = deps.store.bookingText(id)
        if (text === null || refused.get(id) === text) continue
        refused.set(id, text)
        b = deps.store.parseBooking(id, text)
        refused.delete(id)
      } catch (e) {
        note(id, e)
        continue
      }
      try {
        if (finished(b.status) || finished(await advance(deps, b))) done.add(id)
      } catch (e) {
        note(id, e)
      }
    }
  }
}
