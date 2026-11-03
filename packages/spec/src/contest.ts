import { encodeAbiParameters, type Hex, keccak256 } from 'viem'
import { z } from 'zod'
import { canonicalJson, isWellFormedText } from './canonical.js'
import { type ChargeKind, MAX_REPORTS } from './eip712.js'
import { bytes32, side } from './json-fields.js'
import type { Side } from './types.js'
import type { Parsed } from './wire.js'

/**
 * Why a business contests a charge, each reason by the code the lock's `contest` takes and logs in
 * its `Paused` event, with the kinds of charge it answers and a sentence for a person. Code 0 is no
 * reason, so every contest names one. Two reasons answer a late cancellation, two answer a no-show,
 * and `wrong_charge` and `other` answer any kind, so every charge has a reason that fits it.
 */
export const CONTEST_REASONS = {
  never_cancelled: {
    code: 1,
    answers: ['lateCancellation'],
    says: 'The business never cancelled',
  },
  cancelled_in_time: {
    code: 2,
    answers: ['lateCancellation'],
    says: 'The business cancelled before free cancellation ended',
  },
  job_started: {
    code: 3,
    answers: ['noShow'],
    says: 'The business showed up and the job started',
  },
  supplier_did_not_provide: {
    code: 4,
    answers: ['noShow'],
    says: "The supplier didn't provide what the terms promise",
  },
  wrong_charge: {
    code: 5,
    answers: 'any',
    says: 'The charge is the wrong kind or the wrong amount',
  },
  other: {
    code: 6,
    answers: 'any',
    says: 'Another reason, which the statement sets out',
  },
} as const satisfies Record<
  string,
  { code: number; answers: readonly ChargeKind[] | 'any'; says: string }
>

export type ContestReason = keyof typeof CONTEST_REASONS

/** Every reason's name, in the order of their codes. */
export const CONTEST_REASON_NAMES = Object.keys(CONTEST_REASONS) as [
  ContestReason,
  ...ContestReason[],
]

/** Whether a reason answers a charge of this kind. */
export function answersCharge(reason: ContestReason, kind: ChargeKind): boolean {
  const { answers } = CONTEST_REASONS[reason]
  return answers === 'any' || (answers as readonly ChargeKind[]).includes(kind)
}

/** The reason a lock's code stands for, or null for a code that names none, such as 0. */
export function contestReasonOf(code: number): ContestReason | null {
  return CONTEST_REASON_NAMES.find((r) => CONTEST_REASONS[r].code === code) ?? null
}

/**
 * What a business says when it contests a charge: the commitment, the side and the report it
 * contests, its reason, and its own account in its own words. The contest carries the statement's
 * hash, `contestStatementHash`, which the lock logs as its `Paused` event's `evidenceHash`, so
 * anyone holding the text can check it's the statement the business contested with.
 */
export interface ContestStatement {
  commitmentId: Hex
  /** The side the charge is on. This release reserves only the buyer's. */
  side: Side
  /** The report the contest names, which is the lock's `reportCount` when the business contests. */
  reportNumber: number
  reason: ContestReason
  /** The business's account in its own words, in at most `CONTEST_TEXT_MAX_BYTES` of UTF-8. */
  text: string
}

/** The most text a statement carries, in bytes of UTF-8, which is about 600 words of English. */
export const CONTEST_TEXT_MAX_BYTES = 4000

/** The label every statement hash starts from, which names the statement format's version. */
export const CONTEST_STATEMENT_LABEL = 'avow:contest-statement:v1'

/** A control character, C0, DEL or C1, other than tab, line feed and carriage return. */
const CONTROL = /(?![\t\n\r])\p{Cc}/u

/**
 * Whether text holds a Unicode noncharacter, which I-JSON (RFC 7493) forbids: U+FDD0 to U+FDEF,
 * and the last two code points of every plane, U+FFFE and U+FFFF up to U+10FFFE and U+10FFFF.
 */
function hasNoncharacter(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe) return true
  }
  return false
}

/**
 * Whether a statement's text is one the format takes: some character that isn't white space, no
 * control character but tab, line feed and carriage return, no noncharacter, well-formed Unicode,
 * and at most `CONTEST_TEXT_MAX_BYTES` of UTF-8. The text is hashed exactly as written, with no
 * trimming or normalizing.
 */
function textFits(text: string): boolean {
  return (
    /\S/.test(text) &&
    !CONTROL.test(text) &&
    isWellFormedText(text) &&
    !hasNoncharacter(text) &&
    new TextEncoder().encode(text).length <= CONTEST_TEXT_MAX_BYTES
  )
}

const statementJson = z.strictObject({
  commitmentId: bytes32,
  side,
  reportNumber: z.number().int().min(1).max(MAX_REPORTS),
  reason: z.enum(CONTEST_REASON_NAMES),
  text: z.string(),
})

/**
 * Parses a contest statement. A statement of another shape, such as one naming a reason that isn't
 * one of the six or a report the lock can't hold, is refused as invalid, and one whose text the
 * format doesn't take with `contest.statement_invalid`. The commitment id reads in lower case.
 */
export function parseContestStatement(json: unknown): Parsed<ContestStatement> {
  const parsed = statementJson.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'message.invalid' }
  if (!textFits(parsed.data.text)) return { ok: false, reason: 'contest.statement_invalid' }
  return { ok: true, value: parsed.data }
}

/**
 * A statement's canonical JSON, the one encoding its hash covers: RFC 8785, as the terms use, with
 * exactly the statement's five fields and the commitment id in lower case. Throws on a statement
 * `parseContestStatement` refuses, so nothing outside the format is ever hashed.
 */
export function encodeContestStatement(s: ContestStatement): string {
  const parsed = parseContestStatement({
    commitmentId: s.commitmentId,
    side: s.side,
    reportNumber: s.reportNumber,
    reason: s.reason,
    text: s.text,
  })
  if (!parsed.ok) throw new TypeError(`The statement can't be encoded (${parsed.reason})`)
  return canonicalJson(parsed.value)
}

/**
 * The hash a contest carries to the lock as its statement hash:
 * `keccak256(abi.encode(string "avow:contest-statement:v1", string canonicalJson))`. The label
 * keeps a statement's hash from ever matching a hash of the terms or of another format.
 */
export function contestStatementHash(s: ContestStatement): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [CONTEST_STATEMENT_LABEL, encodeContestStatement(s)],
    ),
  )
}
