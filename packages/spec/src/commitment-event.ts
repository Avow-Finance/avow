import { encodeAbiParameters, type Hex, keccak256 } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { OUTCOME_ENDINGS, type OutcomeKindIn } from './commitment.js'
import { CONTEST_REASON_NAMES } from './contest.js'
import { CHARGE_KINDS, type ChargeKind, MAX_REPORTS } from './eip712.js'
import { BUSINESS_ID, holdsOnly, isCount, LOWER_ADDRESS, LOWER_BYTES32 } from './fields.js'
import { bytes32, side, u64, u256 } from './json-fields.js'
import type { ReasonCode } from './reasons.js'
import { type CommitmentReference, commitmentReferenceJson } from './references.js'
import { COMMITMENT_EVENT_VERSION } from './version.js'
import type { Parsed } from './wire.js'

/**
 * A commitment event is the notice of one change in a commitment's life, such as a reserve
 * reaching the lock, the supplier's acceptance or a charge being paid. It is one typed record with
 * a code and that code's fixed fields. Every field is an id, a hash, an amount, a time or a word
 * from a fixed list. An event carries no text a person or a model wrote, so nothing in one can
 * pass for an instruction to whoever reads it. It names the terms by their hash and never carries
 * them, since terms hold words a party wrote.
 *
 * An event is a notice and the lock is the record. An event grants nothing and proves nothing by
 * itself, and whoever acts on one reads the lock, or checks the signed message the event names,
 * first.
 *
 * This module holds the shape, its JSON form, its id and its hash. Nothing in this package stores
 * an event, sends one or lets anyone subscribe to them.
 */

/** One kind of value a field holds: its JSON form, and the rule a held value meets. */
interface Field<S extends z.ZodType = z.ZodType> {
  json: S
  holds: (v: unknown) => boolean
  /** An amount of the commitment's own money, which is never more than its reserve. */
  money?: true
}
type FieldSet = Readonly<Record<string, Field>>
type ValuesOf<F extends FieldSet> = { -readonly [K in keyof F]: z.output<F[K]['json']> }

const field = <S extends z.ZodType>(json: S, holds: (v: unknown) => boolean): Field<S> => ({
  json,
  holds,
})
const isUint = (v: unknown, bits: number): v is bigint =>
  typeof v === 'bigint' && v >= 0n && v < 2n ** BigInt(bits)
const isHash = (v: unknown) => typeof v === 'string' && LOWER_BYTES32.test(v)
const oneOf = <const L extends readonly [string, ...string[]]>(list: L) =>
  field(z.enum(list), (v) => (list as readonly unknown[]).includes(v))
const orNull = <S extends z.ZodType>(f: Field<S>) =>
  field(f.json.nullable(), (v) => v === null || f.holds(v))

/** Unix seconds. */
const time = field(u64, (v) => isUint(v, 64))
/** 32 bytes of hex in lower case, so the same value is never written two ways. */
const hash = field(bytes32, isHash)
/** Micros of the terms' currency, whatever token the lock holds. */
const amount: Field<typeof u256> = { ...field(u256, (v) => isUint(v, 256)), money: true }
/** An amount that is never zero, such as the reserve, a charge reported or a charge paid. */
const positive: Field<typeof u256> = { ...amount, holds: (v) => isUint(v, 256) && v > 0n }
const flag = field(z.boolean(), (v) => typeof v === 'boolean')
const businessId = field(z.string().regex(BUSINESS_ID), (v) => {
  return typeof v === 'string' && BUSINESS_ID.test(v)
})
/** Which of the commitment's reports a change is about, counting from 1. */
const reportNumber = field(z.number().int().min(1).max(MAX_REPORTS), (v) => isCount(v, MAX_REPORTS))
/** The most pieces of evidence one side files on a commitment, which the lock counts in 16 bits. */
export const EVIDENCE_NUMBER_MAX = 65_535
const evidenceNumber = field(z.number().int().min(1).max(EVIDENCE_NUMBER_MAX), (v) =>
  isCount(v, EVIDENCE_NUMBER_MAX),
)
const chargeKind = oneOf(Object.keys(CHARGE_KINDS) as [ChargeKind, ...ChargeKind[]])
const outcomeIn = <E extends 'released' | 'resolved'>(ending: E) =>
  oneOf(
    Object.keys(OUTCOME_ENDINGS).filter(
      (k) => OUTCOME_ENDINGS[k as keyof typeof OUTCOME_ENDINGS] === ending,
    ) as [OutcomeKindIn<E>, ...OutcomeKindIn<E>[]],
  )

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const REFERENCE_KEYS = Object.keys(commitmentReferenceJson.shape)
const isReference = (v: unknown): boolean =>
  isObject(v) &&
  holdsOnly(v, REFERENCE_KEYS) &&
  v.kind === 'commitment' &&
  isCount(v.chainId, Number.MAX_SAFE_INTEGER) &&
  typeof v.lock === 'string' &&
  LOWER_ADDRESS.test(v.lock) &&
  isHash(v.commitmentId) &&
  side.safeParse(v.side).success &&
  isHash(v.termsHash)

/**
 * How each source knows when a change happened, and what an event carries to say so. The source is
 * a field of every event, so a reader never has to guess which clock a time came from.
 *
 * - `block` is a change the lock logged. `at` is the time of the block that holds the log, and the
 *   block's number, the transaction and the log's index say where the log sits, so anyone can read
 *   it from the chain. A writer states a block only once it is final, so an event never names a log
 *   a reorganization dropped.
 * - `avow` is a change Avow's API recorded, with `at` by Avow's clock.
 * - `supplier` is a change a supplier's adapter recorded, with `at` by the clock of the machine the
 *   adapter runs on.
 */
const SOURCES = {
  block: {
    at: time,
    blockNumber: field(u64, (v) => isUint(v, 64)),
    transactionHash: hash,
    /** The log's index in its block, as the receipt numbers it. */
    logIndex: field(z.number().int().min(0), (v) => {
      return Number.isSafeInteger(v) && (v as number) >= 0 && !Object.is(v, -0)
    }),
  },
  avow: { at: time },
  supplier: { at: time },
} as const satisfies Record<string, FieldSet>

export type CommitmentEventSource = keyof typeof SOURCES
export const COMMITMENT_EVENT_SOURCES = Object.keys(SOURCES) as [
  CommitmentEventSource,
  ...CommitmentEventSource[],
]

/** When a change happened and how that is known, as an event from one of the sources `S` says it. */
export type ObservedBy<S extends CommitmentEventSource = CommitmentEventSource> = {
  [K in S]: { source: K } & ValuesOf<(typeof SOURCES)[K]>
}[S]

/** When the agreement both sides signed lapses if no reserve reaches the lock. */
const agreement = { agreementExpiry: time } as const

/**
 * Every code, in the order a commitment's life can reach them, with who can state it and exactly
 * the fields it then carries. `key` names the fields that tell one happening of a code from
 * another on the same commitment, which the event's id is derived from. A code with no key
 * happens at most once for a commitment.
 *
 * `booking` codes are changes off the lock, to the agreement and to what Avow records beside it.
 * `reserve` codes follow the money the business reserved. `charge` codes follow a charge the
 * supplier reported, through to its payment or its ruling.
 */
const CODES = {
  /** Both sides signed the terms agreement. Nothing is reserved yet. */
  'booking.agreed': { key: [], by: { avow: agreement, supplier: agreement } },
  /**
   * Avow's reserve check passed and Avow signed its approval, which the lock needs before it takes
   * the reserve. Avow can approve one commitment more than once, so each approval is told apart by
   * its digest.
   */
  'reserve.approved': {
    key: ['approvalHash'],
    by: { avow: { approvalHash: hash, approvalExpiry: time } },
  },
  /** The lock took the reserve, under the approval and the mandate it names. */
  'reserve.locked': { key: [], by: { block: { approvalHash: hash, mandateHash: hash } } },
  /**
   * The supplier's own check of the funded reserve passed, so the supplier holds the capacity
   * without granting it yet.
   */
  'reserve.held': { key: [], by: { supplier: agreement } },
  /**
   * The lock took the supplier's acceptance, which is when the commitment exists. A supplier's
   * adapter that states it names the acceptance's transaction when it saw one.
   */
  'reserve.accepted': {
    key: [],
    by: { block: {}, supplier: { ...agreement, acceptedIn: orNull(hash) } },
  },
  /**
   * The booking ended with no acceptance, since no reserve came in time. A reserve that did reach
   * the lock and was never accepted goes back to the business, which is a `reserve.released`.
   */
  'booking.lapsed': { key: [], by: { avow: agreement, supplier: agreement } },
  /** Avow timestamped the business's signed request to start. `requestHash` is its digest. */
  'booking.start_requested': { key: ['requestHash'], by: { avow: { requestHash: hash } } },
  /**
   * Avow recorded the supplier's signed start receipt for that request. `startedAt` is the start
   * the receipt states, by the supplier's word.
   */
  'booking.started': {
    key: ['requestHash'],
    by: { avow: { requestHash: hash, startedAt: time } },
  },
  /**
   * Avow recorded the business's cancellation after free cancellation had ended. `requestHash` is
   * the digest of the signed request, which Avow's timestamp names. A cancellation in time is a
   * release on the lock.
   */
  'booking.cancelled_late': { key: [], by: { avow: { requestHash: hash } } },
  /**
   * The lock took the supplier's report of a charge. Nothing has moved. Avow answers by `answerBy`.
   * `contested` says the business's contest of an earlier report stands, so this one waits for a
   * ruling from the start.
   */
  'charge.reported': {
    key: ['reportNumber'],
    by: {
      block: {
        reportNumber,
        kind: chargeKind,
        amount: positive,
        evidenceHash: hash,
        answerBy: time,
        contested: flag,
      },
    },
  },
  /** The supplier withdrew its report before Avow answered it. */
  'charge.withdrawn': { key: ['reportNumber'], by: { block: { reportNumber } } },
  /**
   * Avow confirmed the report. The reserve above the charge went back to the business, and the
   * business can contest the charge until `contestableUntil`, which is null when it already has.
   */
  'charge.confirmed': {
    key: ['reportNumber'],
    by: {
      block: { reportNumber, amount: positive, returned: amount, contestableUntil: orNull(time) },
    },
  },
  /** Avow sent the report to a ruling, since its records don't support it. */
  'charge.referred': { key: ['reportNumber'], by: { block: { reportNumber, returned: amount } } },
  /**
   * Avow didn't answer the report by its deadline, so the report is final and waits for a ruling.
   * `pausedAt` is the moment the days to a ruling count from.
   */
  'charge.unanswered': {
    key: ['reportNumber'],
    by: { block: { reportNumber, pausedAt: time, returned: amount } },
  },
  /** Avow paused a charge it had confirmed, which then waits for a ruling. */
  'charge.paused': { key: ['reportNumber'], by: { block: { reportNumber } } },
  /**
   * The business contested the charge, with one of the six reasons and the hash of its statement.
   * Nothing pays until someone rules. A lock takes one contest for a commitment.
   */
  'charge.contested': {
    key: [],
    by: {
      block: {
        reportNumber,
        reason: oneOf(CONTEST_REASON_NAMES),
        statementHash: hash,
        pausedAt: time,
        returned: amount,
      },
    },
  },
  /** One side filed a piece of evidence on a paused charge. Each side numbers its own. */
  'charge.evidence_filed': {
    key: ['filer', 'number'],
    by: {
      block: {
        filer: field(side, (v) => side.safeParse(v).success),
        number: evidenceNumber,
        evidenceHash: hash,
      },
    },
  },
  /**
   * A ruling was posted, by Avow or by the arbiter the terms name. Nothing has moved. The lock
   * pays it once the ruling delay has passed.
   */
  'charge.ruled': {
    key: [],
    by: {
      block: { ruledBy: oneOf(['avow', 'arbiter']), toSupplier: amount, evidenceHash: hash },
    },
  },
  /** The contest window closed with no contest, and the lock paid the charge to the supplier. */
  'charge.paid': {
    key: [],
    by: { block: { reportNumber, kind: chargeKind, amount: positive } },
  },
  /** The lock paid a paused charge out, by its ruling or by the day-90 default. */
  'charge.resolved': {
    key: [],
    by: {
      block: { outcome: outcomeIn('resolved'), toSupplier: amount, toBusiness: amount },
    },
  },
  /** The lock gave what it still held back to the business, for the reason `outcome` names. */
  'reserve.released': {
    key: [],
    by: { block: { outcome: outcomeIn('released'), returned: amount } },
  },
} as const satisfies Record<
  string,
  { key: readonly string[]; by: Partial<Record<CommitmentEventSource, FieldSet>> }
>

type Codes = typeof CODES
export type CommitmentEventCode = keyof Codes

/** Every code, in the order a commitment's life can reach them. */
export const COMMITMENT_EVENT_CODES = Object.keys(CODES) as [
  CommitmentEventCode,
  ...CommitmentEventCode[],
]

/**
 * Amounts that are parts of one sum of money, so that together they are never more than the
 * reserve. A confirmation holds the charge and returns the rest, and a resolution splits what the
 * lock still held.
 */
const TOGETHER: Partial<Record<CommitmentEventCode, readonly string[]>> = {
  'charge.confirmed': ['amount', 'returned'],
  'charge.resolved': ['toSupplier', 'toBusiness'],
}

/** What every event carries, whatever its code, beside its version, its code and its source. */
const COMMON = {
  /** The same for the same fact, however often it is observed or sent. `commitmentEventId` gives it. */
  id: hash,
  /** The commitment on its lock: the chain, the lock, the commitment id, the side and the terms hash. */
  commitment: field(commitmentReferenceJson, isReference),
  buyerBusinessId: businessId,
  supplierBusinessId: businessId,
  /** The most the supplier can charge on the commitment, which the business reserves. */
  reserve: positive,
} as const satisfies FieldSet

interface CommonFields extends ValuesOf<typeof COMMON> {
  /** `COMMITMENT_EVENT_VERSION`. */
  schemaVersion: string
  commitment: CommitmentReference
}

type FieldsBy<C extends CommitmentEventCode> = Codes[C]['by']
type EventBy<C extends CommitmentEventCode, S extends keyof FieldsBy<C>> = CommonFields & {
  code: C
} & ObservedBy<S & CommitmentEventSource> &
  (FieldsBy<C>[S] extends FieldSet ? ValuesOf<FieldsBy<C>[S]> : never)

/**
 * One change in a commitment's life, of one of the codes `C`, or of any code when `C` is left out.
 * The code and the source decide which fields it carries, so a reserve the lock took with Avow's
 * clock for its time, or an acceptance with a report number, can't be written as one. Both are
 * fields of the event itself, so checking them narrows its type.
 */
export type CommitmentEvent<C extends CommitmentEventCode = CommitmentEventCode> = {
  [K in C]: { [S in keyof FieldsBy<K>]: EventBy<K, S> }[keyof FieldsBy<K>]
}[C]

/** An event before it has its version and its id, as a writer states it to `commitmentEvent`. */
export type CommitmentEventFact = CommitmentEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'id' | 'schemaVersion'>
    : never
  : never

const fieldsBy = (code: CommitmentEventCode): Partial<Record<CommitmentEventSource, FieldSet>> =>
  CODES[code].by

/** The sources that can state each code. */
export const COMMITMENT_EVENT_STATED_BY = Object.fromEntries(
  COMMITMENT_EVENT_CODES.map((code) => [code, Object.keys(fieldsBy(code))]),
) as unknown as { readonly [C in CommitmentEventCode]: readonly CommitmentEventSource[] }

/**
 * The fields each code's id is derived from beside the code and the commitment's reference, which
 * tell one happening of the code from another on the same commitment. Every source that states the
 * code carries them.
 */
export const COMMITMENT_EVENT_KEYS = Object.fromEntries(
  COMMITMENT_EVENT_CODES.map((code) => [code, CODES[code].key]),
) as unknown as { readonly [C in CommitmentEventCode]: readonly string[] }

/**
 * The names of the fields an event of a code carries beside the common ones when a source states
 * it, or null for a source that can't state the code.
 */
export function commitmentEventFields(
  code: CommitmentEventCode,
  source: CommitmentEventSource,
): readonly string[] | null {
  const fields = fieldsBy(code)[source]
  return fields ? Object.keys(fields) : null
}

/** The label an event's id starts from, which names the version of the rule that derives it. */
export const COMMITMENT_EVENT_ID_LABEL = 'avow:commitment-event-id:v1'

/** The label an event's hash starts from. */
export const COMMITMENT_EVENT_LABEL = 'avow:commitment-event:v1'

const labelled = (label: string, value: unknown): Hex =>
  keccak256(
    encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [label, canonicalJson(value)]),
  )

/**
 * An event's id: keccak256 of the ABI encoding of the string `avow:commitment-event-id:v1` and the
 * canonical JSON of the code, the commitment's reference and the code's key fields. It names the
 * fact and nothing about who observed it or when, so the lock's log of an acceptance and a
 * supplier's own record of the same acceptance share one id, and a receiver that has handled an id
 * drops every later event with it. It is derived from well-formed fields, with hex in lower case,
 * and it throws for a code this version doesn't know.
 */
export function commitmentEventId(
  fact: Pick<CommitmentEvent, 'code' | 'commitment'> & object,
): Hex {
  const key = Object.fromEntries(
    COMMITMENT_EVENT_KEYS[fact.code].map((name) => [name, (fact as Record<string, unknown>)[name]]),
  )
  return labelled(COMMITMENT_EVENT_ID_LABEL, {
    ...key,
    code: fact.code,
    commitment: fact.commitment,
  })
}

/** Makes an event from what a writer states, at this package's version and with its id. */
export function commitmentEvent(fact: CommitmentEventFact): CommitmentEvent {
  return {
    ...fact,
    schemaVersion: COMMITMENT_EVENT_VERSION,
    id: commitmentEventId(fact),
  } as CommitmentEvent
}

const COMMON_KEYS = ['schemaVersion', 'code', 'source', ...Object.keys(COMMON)]

const holdsAll = (value: Record<string, unknown>, fields: FieldSet): boolean =>
  Object.entries(fields).every(([name, f]) => f.holds(value[name]))

/** The first problem with a plain copy of a value, or null for a well-formed event. */
function problemOf(v: unknown): ReasonCode | null {
  if (!isObject(v) || typeof v.schemaVersion !== 'string') return 'message.invalid'
  if (v.schemaVersion !== COMMITMENT_EVENT_VERSION) return 'message.schema_unknown'
  const { code, source } = v
  // Only the tables' own keys count, never a name every object inherits.
  if (typeof code !== 'string' || !Object.hasOwn(CODES, code)) return 'message.invalid'
  const by = fieldsBy(code as CommitmentEventCode)
  if (typeof source !== 'string' || !Object.hasOwn(by, source)) return 'message.invalid'
  const stated = source as CommitmentEventSource
  const fields: FieldSet = { ...SOURCES[stated], ...by[stated] }
  const sound =
    holdsOnly(v, [...COMMON_KEYS, ...Object.keys(fields)]) &&
    holdsAll(v, COMMON) &&
    holdsAll(v, fields)
  if (!sound) return 'message.invalid'
  const reserve = v.reserve as bigint
  const sum = (names: readonly string[]) => names.reduce((s, name) => s + (v[name] as bigint), 0n)
  const withinReserve =
    Object.entries(fields).every(([name, f]) => !f.money || (v[name] as bigint) <= reserve) &&
    sum(TOGETHER[code as CommitmentEventCode] ?? []) <= reserve
  if (!withinReserve) return 'message.invalid'
  return v.id === commitmentEventId(v as unknown as CommitmentEvent) ? null : 'message.invalid'
}

/**
 * Checks an event on its own. It gives `message.schema_unknown` for a version this code doesn't
 * read, before it reads anything else, and `message.invalid` for one that isn't well formed. It
 * never throws, whatever it's given, and an event that passes has one canonical form and one hash.
 * So it holds exactly the fields its code carries when its source states it, every hash and address
 * is in lower case, no amount is more than the reserve, and its id is the one its fields derive.
 */
export function commitmentEventProblem(event: CommitmentEvent): ReasonCode | null {
  try {
    // Read once into a plain copy, so what's checked can't change between two reads.
    return problemOf(structuredClone(event))
  } catch {
    // A value that throws when read, or that can't be copied, is no event.
    return 'message.invalid'
  }
}

/**
 * An event's hash: keccak256 of the ABI encoding of the string `avow:commitment-event:v1` and the
 * event's canonical JSON, RFC 8785 as the terms use. It covers every field, the source and the time
 * among them, so two events with one id that differ in who observed the fact have two hashes. It
 * throws on an event `commitmentEventProblem` refuses, so nothing outside the format is hashed.
 */
export function commitmentEventHash(event: CommitmentEvent): Hex {
  const copy: unknown = structuredClone(event)
  const problem = problemOf(copy)
  if (problem) throw new TypeError(`The event can't be hashed (${problem})`)
  return labelled(COMMITMENT_EVENT_LABEL, copy)
}

/** Where a log sits in its chain, which every event from a block carries. */
export type LockPlace = Pick<ObservedBy<'block'>, 'blockNumber' | 'logIndex'>

/**
 * Orders two changes one lock logged, by block and then by the log's place in the block, which is
 * the order the lock made them in. It is negative when `a` came first. Events carry no sequence
 * number, since no one party observes every change, and a time from one clock says nothing against
 * a time from another. This order holds only between two `block` events of the same lock.
 */
export function lockOrder(a: LockPlace, b: LockPlace): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
  return a.logIndex - b.logIndex
}

const jsonOf = (fields: FieldSet) =>
  Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.json]))

/**
 * An event as JSON, one strict object for each code and source that can state it. Amounts and
 * times travel as decimal strings, and hex reads in lower case. `commitmentEventProblem` holds the
 * rules a parsed event still has to meet.
 */
export const commitmentEventJson = z.union(
  COMMITMENT_EVENT_CODES.flatMap((code) =>
    Object.entries(fieldsBy(code)).map(([source, fields]) =>
      z.strictObject({
        schemaVersion: z.literal(COMMITMENT_EVENT_VERSION),
        code: z.literal(code),
        source: z.literal(source),
        ...jsonOf(COMMON),
        ...jsonOf(SOURCES[source as CommitmentEventSource]),
        ...jsonOf(fields),
      }),
    ),
  ),
) as unknown as z.ZodType<CommitmentEvent>

const header = z.object({ schemaVersion: z.string() })

/**
 * Reads an event from JSON. The version is read before anything else, so an event of a version
 * this code doesn't read is refused as `message.schema_unknown` and never as malformed. A code,
 * a source or a field this version doesn't know is `message.invalid`, as is an event
 * `commitmentEventProblem` refuses. It never throws.
 */
export function parseCommitmentEvent(json: unknown): Parsed<CommitmentEvent> {
  try {
    const version = header.safeParse(json)
    if (!version.success) return { ok: false, reason: 'message.invalid' }
    if (version.data.schemaVersion !== COMMITMENT_EVENT_VERSION) {
      return { ok: false, reason: 'message.schema_unknown' }
    }
    const parsed = commitmentEventJson.safeParse(json)
    if (!parsed.success) return { ok: false, reason: 'message.invalid' }
    const problem = commitmentEventProblem(parsed.data)
    return problem ? { ok: false, reason: problem } : { ok: true, value: parsed.data }
  } catch {
    return { ok: false, reason: 'message.invalid' }
  }
}
