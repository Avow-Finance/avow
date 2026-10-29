import { type Call, type OnSent, SendError } from '@avow-finance/sdk'
import {
  type HashSigner,
  parseTerms,
  type ReplayGuard,
  type SupplierAuthorizationAnswer,
  termsAgreementJson,
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
import type { Booking, SupplierStore } from './store.js'

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
export async function advance(deps: AcceptDeps, b: Booking): Promise<Booking['status']> {
  const { store } = deps
  const terms = parseTerms(b.terms)
  const agreement = termsAgreementJson.safeParse(b.agreement)
  if (!terms.ok || !agreement.success) throw new Error(`The booking ${b.commitmentId} won't parse`)
  const save = (status: Booking['status'], sent?: Booking['sent'] | null) => {
    b.status = status
    if (sent === null) delete b.sent
    else if (sent) b.sent = sent
    store.put(b)
    return status
  }
  /** Grants the capacity the supplier held, which it does only once the lock holds the acceptance. */
  const grant = (shownBy: string) => {
    // Here a real supplier grants the capacity it held for the booking.
    deps.log(`granting the capacity held for ${b.commitmentId}, now that ${shownBy}`)
    return save('accepted')
  }

  if (b.status === 'accepting') {
    // The lock's own state shows the acceptance landed as surely as its receipt would.
    if ((await deps.lockState(b.lock, b.commitmentId)) === 'accepted') {
      return grant('the lock shows the acceptance')
    }
    // A send is recorded before its bytes go out, so without one nothing went out.
    if (b.sent) {
      const validBefore = b.sent.validBefore === null ? null : BigInt(b.sent.validBefore)
      // Until the chain is past the transaction's validity, it may still land.
      if (validBefore === null || (await deps.finalizedTime()) <= validBefore) return 'accepting'
      deps.log(`the acceptance for ${b.commitmentId} never landed, so it goes again`)
    }
    save('held', null)
  }
  if (deps.now() >= terms.value.remedies.acceptBy) {
    deps.log(`the reserve for ${b.commitmentId} never came before its acceptance deadline`)
    return save('lapsed')
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

  const a = agreement.data
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
        terms: terms.value,
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
    save('held')
  }

  const prepared = await prepareAcceptance(
    {
      authorization: json(answer.authorization),
      approval: json(answer.approval),
      mandate: json(answer.mandate),
      agreed,
      terms: terms.value,
      now,
    },
    { config: deps.config, chain: deps.chain },
  )
  if (!prepared.ok) {
    deps.log(`the verifier built no acceptance for ${b.commitmentId}: ${prepared.reason}`)
    return b.status
  }
  // The quickstart confirms for its person. A real integration shows this and waits for a yes.
  deps.log(`${prepared.disclosure.title} (disclosure ${prepared.disclosure.id})`)
  for (const section of prepared.disclosure.sections) {
    deps.log(`  ${section.heading}`)
    for (const line of section.lines) deps.log(`    ${line}`)
  }
  const acceptance = await signAcceptance(prepared, deps.signingKey, {
    disclosureId: prepared.disclosure.id,
  })
  save('accepting', null)
  let receipt: { status: 'success' | 'reverted' }
  try {
    receipt = await deps.send(acceptCall(acceptance), (hash, validBefore) => {
      save('accepting', { hash, validBefore: validBefore?.toString() ?? null })
    })
  } catch (e) {
    if (e instanceof SendError && e.outcome === 'failed') {
      deps.log(`sending the acceptance for ${b.commitmentId} failed: ${e.message}`)
      return save('held', null)
    }
    throw e
  }
  if (receipt.status !== 'success') {
    deps.log(`the acceptance for ${b.commitmentId} reverted, so the lock didn't take it`)
    return save('held', null)
  }
  return grant("the acceptance's receipt shows the lock took it")
}

/** Moves every open booking on, each on its own, so one that fails holds up none of the rest. */
export async function advanceAll(deps: AcceptDeps): Promise<void> {
  for (const b of deps.store.bookings()) {
    if (b.status === 'accepted' || b.status === 'lapsed') continue
    try {
      await advance(deps, b)
    } catch (e) {
      deps.log(`booking ${b.commitmentId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
