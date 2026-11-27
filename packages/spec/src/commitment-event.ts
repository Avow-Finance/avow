import { encodeAbiParameters, type Hex, keccak256 } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.js'
import { CONTEST_REASON_NAMES, contestReasonOf } from './contest.js'
import {
  CHARGE_KINDS,
  type ChargeKind,
  MAX_REPORTS,
  RELEASE_REASONS,
  type ReleaseReason,
} from './eip712.js'
import { holdsOnly, isCount, isUint, LOWER_ADDRESS, LOWER_BYTES32 } from './fields.js'
import { address, bytes32, u64, u256 } from './json-fields.js'
import {
  chargeKindOf,
  LOCK_PARTIES,
  type LockParty,
  RELEASE_CAUSES,
  type ReleaseCause,
  releaseReasonOf,
} from './lock-log.js'
import type { ReasonCode } from './reasons.js'
import { commitmentReferenceJson } from './references.js'
import { COMMITMENT_EVENT_VERSION } from './version.js'
import type { Parsed } from './wire.js'

/**
 * A commitment event is the notice of one change in a commitment's life, such as a reserve
 * reaching the lock, the supplier's acceptance or a charge leaving the reserve. It is one typed
 * record with a code and that code's fixed fields. Every string in one is hex of a fixed length or
 * a word from a fixed list, and every other value is a number, a flag or null. An event carries no
 * text a person or a model wrote, so nothing in one can pass for an instruction to whoever reads
 * it. It names the commitment by its chain, its lock and its id, and it names no business, since
 * each side of a commitment already knows the other. It names the terms by their hash and never
 * carries them, since terms hold words a party wrote.
 *
 * An event is a notice and the lock is the record. An event carries no signature, grants nothing
 * and proves nothing by itself, and whoever acts on one reads the lock, or checks the signed
 * message the event names, first.
 *
 * This module holds the shape, its JSON form, its slot and its hash. Nothing in this package stores
 * an event, sends one, signs one or lets anyone subscribe to them.
 */

/** One kind of value a field holds: its JSON form, and the rule a held value meets. */
interface Field<S extends z.ZodType = z.ZodType> {
  json: S
  holds: (v: unknown) => boolean
}
type FieldSet = Readonly<Record<string, Field>>
type ValuesOf<F extends FieldSet> = { -readonly [K in keyof F]: z.output<F[K]['json']> }

const field = <S extends z.ZodType>(json: S, holds: (v: unknown) => boolean): Field<S> => ({
  json,
  holds,
})
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
/** Whether a value is a whole number from 0 to `max`, with zero written one way. */
const isIndex = (v: unknown, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max && !Object.is(v, -0)
const oneOf = <const L extends readonly [string, ...string[]]>(list: L) =>
  field(z.enum(list), (v) => (list as readonly unknown[]).includes(v))
const orNull = <S extends z.ZodType>(f: Field<S>) =>
  field(f.json.nullable(), (v) => v === null || f.holds(v))
const namesOf = <W extends string>(table: Readonly<Record<W, unknown>>) =>
  Object.keys(table) as [W, ...W[]]

/** Unix seconds. */
const time = field(u64, (v) => isUint(v, 64))
/** 32 bytes of hex in lower case, so the same value is never written two ways. */
const hash = field(bytes32, (v) => typeof v === 'string' && LOWER_BYTES32.test(v))
/** An account's address in lower case. */
const account = field(address, (v) => typeof v === 'string' && LOWER_ADDRESS.test(v))
/** Micros of the terms' currency, whatever token the lock holds. */
const amount = field(u256, (v) => isUint(v, 256))
/** An amount that is never zero, such as the reserve or a charge reported. */
const positive = field(u256, (v) => isUint(v, 256, 1n))
const flag = field(z.boolean(), (v) => typeof v === 'boolean')
/** A number a lock logs as it was written, in an unsigned integer of 8 or 16 bits. */
const logged = (bits: 8 | 16) =>
  field(
    z
      .number()
      .int()
      .min(0)
      .max(2 ** bits - 1),
    (v) => isIndex(v, 2 ** bits - 1),
  )
/** Which of the commitment's reports a change is about, counting from 1. */
const reportNumber = field(z.number().int().min(1).max(MAX_REPORTS), (v) => isCount(v, MAX_REPORTS))
/** The most pieces of evidence one side files on a commitment, which the lock counts in 16 bits. */
export const EVIDENCE_NUMBER_MAX = 65_535
const evidenceNumber = field(z.number().int().min(1).max(EVIDENCE_NUMBER_MAX), (v) =>
  isCount(v, EVIDENCE_NUMBER_MAX),
)
const party = oneOf(namesOf<LockParty>(LOCK_PARTIES))

/**
 * What became of an amount the lock sent. `paid` is a transfer that went through in that step.
 * `owed` is a transfer that failed, such as for a paused token or a blocked address, so the lock
 * recorded the amount as owed to that party. Anyone can have the lock pay an owed amount later,
 * which is a `reserve.owed_paid`.
 */
export const SENT_STATES = ['paid', 'owed'] as const

/** An amount the lock sent out of a reserve, which is never zero, and what became of it. */
export interface SentAmount {
  amount: bigint
  state: (typeof SENT_STATES)[number]
}
const SENT_KEYS = ['amount', 'state']
/**
 * An amount the lock sent in this step. A step that sends nothing carries null in its place, so an
 * amount of zero with a state is never written.
 */
const sent = field(z.strictObject({ amount: u256, state: z.enum(SENT_STATES) }), (v) => {
  return (
    isObject(v) &&
    holdsOnly(v, SENT_KEYS) &&
    isUint(v.amount, 256, 1n) &&
    (SENT_STATES as readonly unknown[]).includes(v.state)
  )
})

/**
 * The commitment an event is about: its chain, its lock and its id, as a commitment reference
 * writes them. An event names no side, since a lock reserves the buyer's side only, and the terms
 * hash travels beside this as a field of its own.
 */
const commitmentJson = commitmentReferenceJson.pick({
  chainId: true,
  lock: true,
  commitmentId: true,
})
/** Whether a value reads as the commitment's name and reads back as it was written, in lower case. */
const isCommitment = (v: unknown): boolean => {
  const read = commitmentJson.safeParse(v)
  return (
    read.success &&
    isObject(v) &&
    Object.entries(read.data).every(([name, value]) => v[name] === value)
  )
}

/**
 * Who can state an event, and what an event carries to say how its time is known. The source is a
 * field of every event, so a reader never has to guess which clock a time came from. The sources
 * are listed strongest first, which is the order `sameSlot` settles two differing statements by.
 *
 * - `block` is a change the lock logged. `at` is the time of the block that holds the log, and the
 *   block's number, the transaction and the log's index say where the log sits, so anyone can read
 *   it from the chain. Whoever writes one waits until the block is final. That is a rule for the
 *   writer, and nothing in an event shows it was kept.
 * - `avow` is a change Avow's API recorded, with `at` by Avow's clock.
 * - `supplier` is a change a supplier's adapter recorded, with `at` by the clock of the machine the
 *   adapter runs on. It is the supplier's own word, good for the supplier's own system and no more.
 */
const SOURCES = {
  block: {
    at: time,
    blockNumber: field(u64, (v) => isUint(v, 64)),
    transactionHash: hash,
    /** The log's index in its block, as the receipt numbers it. */
    logIndex: field(z.number().int().min(0), (v) => isIndex(v, Number.MAX_SAFE_INTEGER)),
  },
  avow: { at: time },
  supplier: { at: time },
} as const satisfies Record<string, FieldSet>

export type CommitmentEventSource = keyof typeof SOURCES
/** Every source, strongest first. */
export const COMMITMENT_EVENT_SOURCES = Object.keys(SOURCES) as [
  CommitmentEventSource,
  ...CommitmentEventSource[],
]

/** When a change happened and how that is known, as an event from one of the sources `S` says it. */
export type ObservedBy<S extends CommitmentEventSource = CommitmentEventSource> = {
  [K in S]: { source: K } & ValuesOf<(typeof SOURCES)[K]>
}[S]

/** The hash of the terms the commitment was made under. */
const terms = { termsHash: hash } as const
/**
 * What a party to the agreement states about it: the terms, the reserve, which is the most the
 * supplier can charge, and when the agreement both sides signed lapses.
 */
const agreement = { ...terms, reserve: positive, agreementExpiry: time } as const

/**
 * Every code, in the order a commitment's life can reach them, with who can state it and exactly
 * the fields it then carries. `key` names the fields that tell one occurrence of a step from
 * another on the same commitment, which the event's slot is derived from. A code with no key
 * happens at most once for a commitment.
 *
 * `booking` codes are changes off the lock, to the agreement and to what Avow records beside it.
 * `reserve` codes follow the money the business reserved. `charge` codes follow a charge the
 * supplier reported, through to its payment or its ruling.
 *
 * A code stated from a block carries only what the lock's log for that step holds, so it is
 * written from the lock's logs and nothing else. `COMMITMENT_EVENT_LOGS` names the log and the
 * argument each field is read from.
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
    by: { avow: { ...terms, reserve: positive, approvalHash: hash, approvalExpiry: time } },
  },
  /** The lock took the reserve, under the approval and the mandate it names by their digests. */
  'reserve.locked': {
    key: [],
    by: { block: { ...terms, reserve: positive, approvalHash: hash, mandateHash: hash } },
  },
  /**
   * The supplier's own check of the funded reserve passed, so the supplier holds the capacity
   * without granting it yet.
   */
  'reserve.held': { key: [], by: { supplier: agreement } },
  /**
   * The lock took the supplier's acceptance, which is when the commitment exists. From a block it
   * names the signed acceptance by its digest. A supplier's adapter that states it names the
   * acceptance's transaction when it saw one.
   */
  'reserve.accepted': {
    key: [],
    by: {
      block: { ...terms, acceptanceHash: hash },
      supplier: { ...agreement, acceptedIn: orNull(hash) },
    },
  },
  /**
   * The booking ended with no acceptance by its deadline. The event doesn't say whether a reserve
   * had come. A reserve that did reach the lock is still there when the booking lapses, and it goes
   * back to the business, which is a `reserve.released`.
   */
  'booking.lapsed': { key: [], by: { avow: agreement, supplier: agreement } },
  /** Avow timestamped the business's signed request to start. `requestHash` is its digest. */
  'booking.start_requested': {
    key: ['requestHash'],
    by: { avow: { ...terms, requestHash: hash } },
  },
  /**
   * Avow recorded the supplier's signed start receipt. `receiptHash` is the receipt's digest, which
   * tells two receipts for one request apart, `requestHash` is the start request the receipt
   * names, and `startedAt` is the start the receipt states, by the supplier's word.
   */
  'booking.started': {
    key: ['receiptHash'],
    by: { avow: { ...terms, requestHash: hash, receiptHash: hash, startedAt: time } },
  },
  /**
   * Avow recorded the business's cancellation after free cancellation had ended. `requestHash` is
   * the digest of the signed request, which Avow's timestamp names, and it tells two requests
   * apart. A cancellation in time is a release on the lock.
   */
  'booking.cancelled_late': {
    key: ['requestHash'],
    by: { avow: { ...terms, requestHash: hash } },
  },
  /**
   * The lock took the supplier's report of a charge. Nothing has moved. Avow answers by `answerBy`.
   * `kindCode` is the kind of charge as the lock logged it, and `kind` is its name, or null for a
   * kind this package doesn't name. `contested` says the business's contest of an earlier report
   * stands, so this one waits for a ruling from the start.
   */
  'charge.reported': {
    key: ['reportNumber'],
    by: {
      block: {
        ...terms,
        reportNumber,
        kind: orNull(oneOf(namesOf<ChargeKind>(CHARGE_KINDS))),
        kindCode: logged(8),
        amount: positive,
        evidenceHash: hash,
        answerBy: time,
        contested: flag,
      },
    },
  },
  /** The supplier withdrew its report before Avow answered it. */
  'charge.withdrawn': {
    key: ['reportNumber'],
    by: { block: { ...terms, reportNumber, evidenceHash: hash } },
  },
  /**
   * Avow confirmed the report. `returned` is the reserve above the charge, which the lock sent
   * back to the business, or null when the charge is the whole reserve.
   */
  'charge.confirmed': {
    key: [],
    by: {
      block: {
        ...terms,
        reportNumber,
        amount: positive,
        evidenceHash: hash,
        returned: orNull(sent),
      },
    },
  },
  /** Avow sent the report to a ruling, with the hash of what it rests that on. */
  'charge.referred': {
    key: [],
    by: { block: { ...terms, reportNumber, evidenceHash: hash, returned: orNull(sent) } },
  },
  /**
   * Avow didn't answer the report by its deadline, so the report is final and waits for a ruling.
   * `pausedAt` is the moment the days to a ruling count from.
   */
  'charge.unanswered': {
    key: [],
    by: { block: { ...terms, pausedAt: time, evidenceHash: hash, returned: orNull(sent) } },
  },
  /** Avow paused a charge it had confirmed, which then waits for a ruling. */
  'charge.paused': {
    key: [],
    by: { block: { ...terms, pausedAt: time, evidenceHash: hash } },
  },
  /**
   * The business contested the charge, and nothing pays until someone rules. `reasonCode` is the
   * reason as the lock logged it, which a lock takes as any 16-bit number, and `reason` is the one
   * of the six reasons it stands for, or null for a number that names none. `statementHash` is the
   * hash of the business's statement. A lock takes one contest for a commitment.
   */
  'charge.contested': {
    key: [],
    by: {
      block: {
        ...terms,
        reason: orNull(oneOf(CONTEST_REASON_NAMES)),
        reasonCode: logged(16),
        statementHash: hash,
        pausedAt: time,
        returned: orNull(sent),
      },
    },
  },
  /** One party filed a piece of evidence on a paused charge. Each party numbers its own. */
  'charge.evidence_filed': {
    key: ['filer', 'number'],
    by: { block: { ...terms, filer: party, number: evidenceNumber, evidenceHash: hash } },
  },
  /**
   * A ruling was posted. Nothing has moved, and the lock sends the ruling's amounts once the ruling
   * delay has passed. `ruledBy` is the account that posted it, which is Avow's ruling key or the
   * arbiter the terms name.
   */
  'charge.ruled': {
    key: [],
    by: { block: { ...terms, ruledBy: account, toSupplier: amount, evidenceHash: hash } },
  },
  /**
   * The contest window closed with no contest, so the lock took the charge out of the reserve and
   * sent it to the supplier. `amount` says whether the lock paid it or recorded it as owed.
   */
  'charge.charged': {
    key: [],
    by: { block: { ...terms, amount: sent, evidenceHash: hash } },
  },
  /**
   * The lock settled a paused charge, by its ruling when `byRuling` is true and by the day-90
   * default otherwise. Each share says whether the lock paid it or recorded it as owed, and a
   * share of nothing is null.
   */
  'charge.resolved': {
    key: [],
    by: {
      block: {
        ...terms,
        byRuling: flag,
        toSupplier: orNull(sent),
        toBusiness: orNull(sent),
        evidenceHash: hash,
      },
    },
  },
  /**
   * The lock sent what it still held back to the business. `cause` is which of the lock's five
   * steps did it. `reasonCode` is the reason as the lock logged it, which is any 8-bit number from
   * Avow or from the supplier's consent and zero for the other causes. `reason` is the name of a
   * consent's reason, and null for any other cause or for a number that names none.
   */
  'reserve.released': {
    key: [],
    by: {
      block: {
        ...terms,
        cause: oneOf(namesOf<ReleaseCause>(RELEASE_CAUSES)),
        reason: orNull(oneOf(namesOf<ReleaseReason>(RELEASE_REASONS))),
        reasonCode: logged(8),
        evidenceHash: hash,
        returned: sent,
      },
    },
  },
  /**
   * The lock paid an amount it had recorded as owed, to the party it was owed to. A lock numbers no
   * such payment, and it can pay one party more than once, so each is told apart by where its log
   * sits. The lock's log names no terms, so this is the one code that carries no terms hash.
   */
  'reserve.owed_paid': {
    key: ['party', 'transactionHash', 'logIndex'],
    by: { block: { party, amount: positive } },
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

type Plain = Record<string, unknown>
/**
 * What an event's fields have to say together, beside what each says alone. A word that stands for
 * a lock's number is the word that number has, and a step can't be written as one a lock never
 * takes.
 */
const FITS: { readonly [C in CommitmentEventCode]?: (v: Plain) => boolean } = {
  'charge.reported': (v) => v.kind === chargeKindOf(v.kindCode as number),
  'charge.contested': (v) => v.reason === contestReasonOf(v.reasonCode as number),
  // A lock resolves a charge only while it holds some of the reserve, so one share is never nothing.
  'charge.resolved': (v) => v.toSupplier !== null || v.toBusiness !== null,
  'reserve.released': (v) => {
    const code = v.reasonCode as number
    const byConsent = v.cause === 'supplier_consent'
    const givesReason = byConsent || v.cause === 'returned_by_avow'
    return v.reason === (byConsent ? releaseReasonOf(code) : null) && (givesReason || code === 0)
  },
}

/** What every event carries, whatever its code, beside its version, its code and its source. */
const COMMON = {
  /** The commitment on its lock: the chain, the lock and the commitment id. */
  commitment: field(commitmentJson, isCommitment),
} as const satisfies FieldSet

interface CommonFields extends ValuesOf<typeof COMMON> {
  /** `COMMITMENT_EVENT_VERSION`. */
  schemaVersion: string
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

/** An event the lock logged, of one of the codes `C`. */
export type BlockEvent<C extends CommitmentEventCode = CommitmentEventCode> = Extract<
  CommitmentEvent<C>,
  { source: 'block' }
>

/** An event before it has its version, as a writer states it to `commitmentEvent`. */
export type CommitmentEventFact = CommitmentEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'schemaVersion'>
    : never
  : never

/**
 * The names of the fields a code carries of its own when the source `S` states it, beside the
 * common fields and the source's.
 */
export type CommitmentEventFieldName<
  C extends CommitmentEventCode,
  S extends CommitmentEventSource,
> = S extends keyof FieldsBy<C> ? keyof FieldsBy<C>[S] & string : never

const fieldsBy = (code: CommitmentEventCode): Partial<Record<CommitmentEventSource, FieldSet>> =>
  CODES[code].by

/** The sources that can state each code. */
export const COMMITMENT_EVENT_STATED_BY = Object.fromEntries(
  COMMITMENT_EVENT_CODES.map((code) => [code, Object.keys(fieldsBy(code))]),
) as unknown as { readonly [C in CommitmentEventCode]: readonly CommitmentEventSource[] }

/**
 * The fields each code's slot is derived from beside the code and the commitment, which tell one
 * occurrence of the step from another on the same commitment. Every source that states the code
 * carries them. A code with none happens at most once for a commitment.
 */
export const COMMITMENT_EVENT_KEYS = Object.fromEntries(
  COMMITMENT_EVENT_CODES.map((code) => [code, CODES[code].key]),
) as unknown as { readonly [C in CommitmentEventCode]: readonly string[] }

/**
 * The names of the fields an event of a code carries beside the common ones and the source's when
 * a source states it, or null for a source that can't state the code.
 */
export function commitmentEventFields(
  code: CommitmentEventCode,
  source: CommitmentEventSource,
): readonly string[] | null {
  const fields = fieldsBy(code)[source]
  return fields ? Object.keys(fields) : null
}

const COMMON_KEYS = ['schemaVersion', 'code', 'source', ...Object.keys(COMMON)]

/** How a code is written: a subject, a dot and what happened to it, in at most 64 characters. */
const CODE_SHAPE = /^[a-z]+\.[a-z]+(_[a-z]+)*$/
const isCodeShaped = (code: string) => code.length <= 64 && CODE_SHAPE.test(code)

const holdsAll = (value: Plain, fields: FieldSet): boolean =>
  Object.entries(fields).every(([name, f]) => f.holds(value[name]))

/** The first problem with a plain copy of a value, or null for a well-formed event. */
function problemOf(v: unknown): ReasonCode | null {
  if (!isObject(v) || typeof v.schemaVersion !== 'string') return 'message.invalid'
  if (v.schemaVersion !== COMMITMENT_EVENT_VERSION) return 'message.schema_unknown'
  const { code, source } = v
  if (typeof code !== 'string') return 'message.invalid'
  // Only the tables' own keys count, never a name every object inherits.
  if (!Object.hasOwn(CODES, code)) {
    return isCodeShaped(code) ? 'event.code_unknown' : 'message.invalid'
  }
  const known = code as CommitmentEventCode
  const by = fieldsBy(known)
  if (typeof source !== 'string' || !Object.hasOwn(by, source)) return 'message.invalid'
  const stated = source as CommitmentEventSource
  const fields: FieldSet = { ...SOURCES[stated], ...by[stated] }
  const sound =
    holdsOnly(v, [...COMMON_KEYS, ...Object.keys(fields)]) &&
    holdsAll(v, COMMON) &&
    holdsAll(v, fields) &&
    (FITS[known]?.(v) ?? true)
  return sound ? null : 'message.invalid'
}

/**
 * Checks an event on its own. It gives `message.schema_unknown` for a version this code doesn't
 * read, before it reads anything else, `event.code_unknown` for a code this code doesn't know, and
 * `message.invalid` for anything else that isn't a well-formed event. It never throws, whatever
 * it's given, and an event that passes has one canonical form, one slot and one hash. So it holds
 * exactly the fields its code carries when its source states it, every hash and address is in
 * lower case, and a word that stands for a lock's number is the word that number has.
 *
 * A pass says the event is well formed. It says nothing about whether the event is true.
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

/** A plain copy of a well-formed event, or a thrown error for anything else. */
function checkedCopy(event: unknown, use: string): Plain {
  const copy: unknown = structuredClone(event)
  const problem = problemOf(copy)
  if (problem) throw new TypeError(`The event can't be ${use} (${problem})`)
  return copy as Plain
}

/**
 * Makes an event from what a writer states, at this package's version. It throws on a statement
 * `commitmentEventProblem` refuses, such as one with a lock's address in mixed case, so a writer
 * never holds an event a reader would turn away.
 */
export function commitmentEvent(fact: CommitmentEventFact): CommitmentEvent {
  return checkedCopy(
    { ...fact, schemaVersion: COMMITMENT_EVENT_VERSION },
    'made',
  ) as unknown as CommitmentEvent
}

/** The label an event's slot starts from, which names the version of the rule that derives it. */
export const COMMITMENT_EVENT_SLOT_LABEL = 'avow:commitment-event-slot:v1'

/** The label an event's hash starts from. */
export const COMMITMENT_EVENT_LABEL = 'avow:commitment-event:v1'

const labelled = (label: string, value: unknown): Hex =>
  keccak256(
    encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [label, canonicalJson(value)]),
  )

/**
 * An event's slot: which step of which commitment it is about. It is keccak256 of the ABI encoding
 * of the string `avow:commitment-event-slot:v1` and the canonical JSON of the code, the commitment
 * and the code's key fields.
 *
 * A slot names a place in a commitment's life and says nothing about what happened there. Two
 * events that share a slot can state different things, such as two amounts for one report, so a
 * slot is never proof and never a reason to drop an event. `sameSlot` says which of two stands.
 * It throws on an event `commitmentEventProblem` refuses, so one step never has two slots.
 */
export function commitmentEventSlot(event: CommitmentEvent): Hex {
  const v = checkedCopy(event, 'given a slot')
  const code = v.code as CommitmentEventCode
  const key = Object.fromEntries(COMMITMENT_EVENT_KEYS[code].map((name) => [name, v[name]]))
  return labelled(COMMITMENT_EVENT_SLOT_LABEL, { code, commitment: v.commitment, key })
}

/**
 * An event's hash: keccak256 of the ABI encoding of the string `avow:commitment-event:v1` and the
 * event's canonical JSON, RFC 8785 as the terms use. It covers every field, the source and the time
 * among them, so two deliveries of one event have one hash, and two events that differ in anything
 * have two. It throws on an event `commitmentEventProblem` refuses, so nothing outside the format
 * is hashed.
 */
export function commitmentEventHash(event: CommitmentEvent): Hex {
  return labelled(COMMITMENT_EVENT_LABEL, checkedCopy(event, 'hashed'))
}

/**
 * What a receiver that holds one event does when another arrives.
 *
 * - `other_slot`: the two are about different steps, and neither bears on the other.
 * - `repeat`: the two are one event, hash for hash. Drop the one that arrived.
 * - `arrived_replaces`: they differ, and the one that arrived comes from a stronger source.
 * - `held_stands`: they differ, and the one already held comes from a stronger source.
 * - `read_the_lock`: they differ and come from the same source, so neither stands on its word.
 */
export type SameSlot =
  | 'other_slot'
  | 'repeat'
  | 'arrived_replaces'
  | 'held_stands'
  | 'read_the_lock'

/**
 * Settles two events by the receiver's rules. A repeat is an event with the same hash, and only a
 * repeat is dropped. When two events share a slot and differ, a block's statement replaces a
 * clock's and Avow's clock replaces a supplier's. Two differing statements from one source, two
 * blocks among them, leave nothing to choose between, so the receiver reads the lock, or checks the
 * signed message the events name. It throws on an event `commitmentEventProblem` refuses.
 *
 * The answer ranks two notices. It makes neither of them proof.
 */
export function sameSlot(held: CommitmentEvent, arrived: CommitmentEvent): SameSlot {
  if (commitmentEventSlot(held) !== commitmentEventSlot(arrived)) return 'other_slot'
  if (commitmentEventHash(held) === commitmentEventHash(arrived)) return 'repeat'
  const rank = (e: CommitmentEvent) => COMMITMENT_EVENT_SOURCES.indexOf(e.source)
  if (rank(held) === rank(arrived)) return 'read_the_lock'
  return rank(arrived) < rank(held) ? 'arrived_replaces' : 'held_stands'
}

/** Where a log sits, which every event from a block carries: its lock, its block and its index. */
export type LockPlace = Pick<BlockEvent, 'commitment' | 'blockNumber' | 'logIndex'>

/**
 * The order of two changes: `order` is negative when the first came first, zero for one log and
 * positive when the second came first. Two changes on different locks, or on different chains,
 * have no order, and `comparable` is false.
 */
export type LockOrder = { comparable: true; order: -1 | 0 | 1 } | { comparable: false }

/**
 * Orders two changes one lock logged, by block and then by the log's place in the block, which is
 * the order the lock made them in. Events carry no sequence number, since no one party observes
 * every change, and a time from one clock says nothing against a time from another. Two locks keep
 * no order between them, so it refuses to compare a change on one with a change on another.
 */
export function lockOrder(a: LockPlace, b: LockPlace): LockOrder {
  if (a.commitment.chainId !== b.commitment.chainId || a.commitment.lock !== b.commitment.lock) {
    return { comparable: false }
  }
  const first =
    a.blockNumber !== b.blockNumber ? a.blockNumber < b.blockNumber : a.logIndex < b.logIndex
  const same = a.blockNumber === b.blockNumber && a.logIndex === b.logIndex
  return { comparable: true, order: same ? 0 : first ? -1 : 1 }
}

const jsonOf = (fields: FieldSet) =>
  Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.json]))

/** The JSON form of each code as each source states it, one strict object apiece. */
const JSON_BY: Readonly<Record<string, Readonly<Record<string, z.ZodType>>>> = Object.fromEntries(
  COMMITMENT_EVENT_CODES.map((code) => [
    code,
    Object.fromEntries(
      Object.entries(fieldsBy(code)).map(([source, fields]) => [
        source,
        z.strictObject({
          schemaVersion: z.literal(COMMITMENT_EVENT_VERSION),
          code: z.literal(code),
          source: z.literal(source),
          ...jsonOf(COMMON),
          ...jsonOf(SOURCES[source as CommitmentEventSource]),
          ...jsonOf(fields),
        }),
      ]),
    ),
  ]),
)

/**
 * An event as JSON, one strict object for each code and source that can state it. Amounts and
 * times travel as decimal strings, and hex reads in lower case. `commitmentEventProblem` holds the
 * rules a parsed event still has to meet.
 */
export const commitmentEventJson = z.union(
  Object.values(JSON_BY).flatMap((by) => Object.values(by)),
) as unknown as z.ZodType<CommitmentEvent>

const header = z.object({
  schemaVersion: z.string(),
  code: z.unknown().optional(),
  source: z.unknown().optional(),
})

/**
 * Reads an event from JSON. The version is read before anything else, so an event of a version
 * this code doesn't read is refused as `message.schema_unknown` and never as malformed. The code is
 * read next, so an event of this version with a code this reader doesn't know is refused as
 * `event.code_unknown`, and a reader that meets one sets that one event aside and keeps reading
 * the rest. A source or a field this version doesn't know is `message.invalid`, as is an event
 * `commitmentEventProblem` refuses. It never throws.
 */
export function parseCommitmentEvent(json: unknown): Parsed<CommitmentEvent> {
  try {
    const head = header.safeParse(json)
    if (!head.success) return { ok: false, reason: 'message.invalid' }
    const { schemaVersion, code, source } = head.data
    if (schemaVersion !== COMMITMENT_EVENT_VERSION) {
      return { ok: false, reason: 'message.schema_unknown' }
    }
    if (typeof code !== 'string' || typeof source !== 'string') {
      return { ok: false, reason: 'message.invalid' }
    }
    // Only the tables' own keys count, never a name every object inherits.
    if (!Object.hasOwn(JSON_BY, code)) {
      return { ok: false, reason: isCodeShaped(code) ? 'event.code_unknown' : 'message.invalid' }
    }
    const by = JSON_BY[code] ?? {}
    const parsed = Object.hasOwn(by, source) ? by[source]?.safeParse(json) : undefined
    if (!parsed?.success) return { ok: false, reason: 'message.invalid' }
    const event = parsed.data as CommitmentEvent
    const problem = commitmentEventProblem(event)
    return problem ? { ok: false, reason: problem } : { ok: true, value: event }
  } catch {
    return { ok: false, reason: 'message.invalid' }
  }
}
