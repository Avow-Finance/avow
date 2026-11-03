import { readFileSync } from 'node:fs'
import { encodeAbiParameters, type Hex, keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import { API_PATHS, parseContestStatementAnswer, parseContestStatementRequest } from './api.js'
import {
  answersCharge,
  CONTEST_REASON_NAMES,
  CONTEST_REASONS,
  CONTEST_STATEMENT_LABEL,
  CONTEST_TEXT_MAX_BYTES,
  type ContestStatement,
  contestReasonOf,
  contestStatementHash,
  encodeContestStatement,
  parseContestStatement,
} from './contest.js'
import { CHARGE_KINDS, type ChargeKind, MAX_REPORTS } from './eip712.js'
import { id } from './test-helpers.js'
import { toWire } from './wire.js'

const statement: ContestStatement = {
  commitmentId: id('contested commitment'),
  side: 'buyer',
  reportNumber: 1,
  reason: 'job_started',
  text: 'The job started at 14:03, and the supplier receipted our start request.',
}
const KINDS = Object.keys(CHARGE_KINDS) as ChargeKind[]

describe('the six contest reasons', () => {
  it('number the reasons 1 to 6 in the agreed order, so 0 names none', () => {
    expect(CONTEST_REASON_NAMES.map((r) => [r, CONTEST_REASONS[r].code])).toEqual([
      ['never_cancelled', 1],
      ['cancelled_in_time', 2],
      ['job_started', 3],
      ['supplier_did_not_provide', 4],
      ['wrong_charge', 5],
      ['other', 6],
    ])
    for (const r of CONTEST_REASON_NAMES) expect(contestReasonOf(CONTEST_REASONS[r].code)).toBe(r)
    for (const code of [0, 7, 65_535, -1, 1.5]) expect(contestReasonOf(code)).toBeNull()
  })

  it('answer a late cancellation with two reasons, a no-show with two, and any charge with two', () => {
    const answering = (kind: ChargeKind) =>
      CONTEST_REASON_NAMES.filter((r) => answersCharge(r, kind))
    expect(answering('lateCancellation')).toEqual([
      'never_cancelled',
      'cancelled_in_time',
      'wrong_charge',
      'other',
    ])
    expect(answering('noShow')).toEqual([
      'job_started',
      'supplier_did_not_provide',
      'wrong_charge',
      'other',
    ])
    // Every kind a lock holds has a reason that answers it.
    for (const kind of KINDS) expect(answering(kind)).toContain('other')
  })

  it('say each reason in a sentence', () => {
    for (const r of CONTEST_REASON_NAMES) expect(CONTEST_REASONS[r].says).toMatch(/^[A-Z].+[^.]$/)
  })
})

describe('a contest statement', () => {
  const withText = (text: string) => ({ ...statement, text })
  const refusedText = (text: string) =>
    expect(parseContestStatement(withText(text)), JSON.stringify(text)).toEqual({
      ok: false,
      reason: 'contest.statement_invalid',
    })

  it('reads a statement, with the commitment id in lower case', () => {
    const upper = { ...statement, commitmentId: statement.commitmentId.toUpperCase() as Hex }
    expect(
      parseContestStatement({ ...upper, commitmentId: `0x${upper.commitmentId.slice(2)}` }),
    ).toEqual({
      ok: true,
      value: statement,
    })
  })

  it('refuses another shape: an unknown reason, a report the lock never holds, another side or an extra field', () => {
    const refused = [
      { ...statement, reason: 'supplier_did_not_deliver' },
      { ...statement, reason: 3 },
      { ...statement, reportNumber: 0 },
      { ...statement, reportNumber: MAX_REPORTS + 1 },
      { ...statement, reportNumber: 1.5 },
      { ...statement, reportNumber: '1' },
      { ...statement, side: 'business' },
      { ...statement, commitmentId: '0x1234' },
      { ...statement, text: 42 },
      { ...statement, evidence: id('extra') },
      (({ text: _, ...rest }) => rest)(statement),
      null,
      [],
    ]
    for (const json of refused) {
      expect(parseContestStatement(json), JSON.stringify(json)).toEqual({
        ok: false,
        reason: 'message.invalid',
      })
    }
  })

  it('takes text with tabs, line breaks and any language, and refuses blank text or a control character', () => {
    for (const text of ['ok', ' x ', 'tab\there', 'one\ntwo', 'one\r\ntwo', 'Zürich 日本語 🙂']) {
      expect(parseContestStatement(withText(text)).ok, JSON.stringify(text)).toBe(true)
    }
    for (const text of [
      '',
      ' ',
      '\n\t\r ',
      ' ',
      'nul\u0000',
      'escape\u001b[2J',
      'del\u007f',
      'c1\u0085',
    ]) {
      refusedText(text)
    }
  })

  it('refuses every Unicode noncharacter, which I-JSON forbids, and keeps the characters beside them', () => {
    const noncharacters = [
      ...Array.from({ length: 32 }, (_, i) => 0xfdd0 + i),
      ...Array.from({ length: 17 }, (_, plane) => [
        plane * 0x10000 + 0xfffe,
        plane * 0x10000 + 0xffff,
      ]).flat(),
    ]
    expect(noncharacters).toHaveLength(66)
    for (const c of noncharacters) refusedText(`before ${String.fromCodePoint(c)} after`)
    for (const c of [0xfdcf, 0xfdf0, 0xfffd, 0x1fffd, 0x10fffd, 0xe000, 0xf0000]) {
      const text = `before ${String.fromCodePoint(c)} after`
      expect(parseContestStatement(withText(text)).ok, c.toString(16)).toBe(true)
    }
  })

  it('refuses text with half a character, which UTF-8 cannot carry', () => {
    refusedText('broken \ud83d here')
    refusedText('\ude42 alone')
  })

  it('counts its limit in bytes of UTF-8, so text in any language meets the same limit', () => {
    expect(CONTEST_TEXT_MAX_BYTES).toBe(4000)
    expect(parseContestStatement(withText('a'.repeat(4000))).ok).toBe(true)
    refusedText('a'.repeat(4001))
    // Two bytes each, so 2,000 fit and 2,001 don't.
    expect(parseContestStatement(withText('é'.repeat(2000))).ok).toBe(true)
    refusedText('é'.repeat(2001))
    // Four bytes each.
    expect(parseContestStatement(withText('🙂'.repeat(1000))).ok).toBe(true)
    refusedText(`${'🙂'.repeat(1000)}a`)
  })
})

describe("a statement's encoding and hash", () => {
  it('writes canonical JSON of exactly the five fields, keys sorted, id in lower case', () => {
    const json = `{"commitmentId":"${statement.commitmentId}","reason":"job_started","reportNumber":1,"side":"buyer","text":"${statement.text}"}`
    expect(encodeContestStatement(statement)).toBe(json)
    const upper = `0x${statement.commitmentId.slice(2).toUpperCase()}` as Hex
    expect(encodeContestStatement({ ...statement, commitmentId: upper })).toBe(json)
    // A field a JavaScript caller adds never reaches the encoding.
    expect(encodeContestStatement({ ...statement, extra: 'unsigned' } as ContestStatement)).toBe(
      json,
    )
  })

  it('hashes the label and the canonical JSON, abi-encoded as two strings', () => {
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }],
        ['avow:contest-statement:v1', encodeContestStatement(statement)],
      ),
    )
    expect(CONTEST_STATEMENT_LABEL).toBe('avow:contest-statement:v1')
    expect(contestStatementHash(statement)).toBe(expected)
  })

  it('changes with every field', () => {
    const hash = contestStatementHash(statement)
    const changed: ContestStatement[] = [
      { ...statement, commitmentId: id('another commitment') },
      { ...statement, side: 'supplier' },
      { ...statement, reportNumber: 2 },
      { ...statement, reason: 'other' },
      { ...statement, text: `${statement.text} ` },
    ]
    for (const s of changed) expect(contestStatementHash(s), JSON.stringify(s)).not.toBe(hash)
  })

  it('refuses to encode or hash a statement outside the format', () => {
    for (const s of [
      { ...statement, text: ' ' },
      { ...statement, reportNumber: 3 },
      { ...statement, reason: 'none' as ContestStatement['reason'] },
    ]) {
      expect(() => encodeContestStatement(s)).toThrow("The statement can't be encoded")
      expect(() => contestStatementHash(s)).toThrow("The statement can't be encoded")
    }
  })
})

/**
 * The vectors another implementation checks itself against, in `vectors/contest-statement-v1.json`.
 * `scripts/write-contest-statement-vectors.mjs` wrote them. This fails when the code and the file
 * disagree, so a change to how a statement encodes or hashes needs new vectors and a new label.
 */
describe('pinned contest statement vectors', () => {
  const file = JSON.parse(
    readFileSync(new URL('../vectors/contest-statement-v1.json', import.meta.url), 'utf8'),
  ) as {
    label: string
    vectors: { name: string; statement: unknown; canonicalJson: string; hash: Hex }[]
  }

  it('holds three vectors under the current label', () => {
    expect(file.label).toBe(CONTEST_STATEMENT_LABEL)
    expect(file.vectors).toHaveLength(3)
  })

  for (const v of file.vectors) {
    it(`${v.name}: reproduces the canonical JSON and the hash`, () => {
      const parsed = parseContestStatement(v.statement)
      if (!parsed.ok) throw new Error(`the vector's statement doesn't parse: ${parsed.reason}`)
      expect(encodeContestStatement(parsed.value)).toBe(v.canonicalJson)
      expect(contestStatementHash(parsed.value)).toBe(v.hash)
      expect(
        keccak256(
          encodeAbiParameters(
            [{ type: 'string' }, { type: 'string' }],
            [file.label, v.canonicalJson],
          ),
        ),
      ).toBe(v.hash)
    })
  }

  it('hashes an id in mixed case as the same id in lower case', () => {
    const [plain, , mixed] = file.vectors
    const lowered = { ...(mixed?.statement as ContestStatement) }
    lowered.commitmentId = lowered.commitmentId.toLowerCase() as Hex
    expect(contestStatementHash(lowered)).toBe(mixed?.hash)
    expect(plain?.hash).not.toBe(mixed?.hash)
  })
})

describe('posting a statement to Avow', () => {
  const contestedIn = id('the contest transaction')
  const body = (change: Record<string, unknown> = {}) =>
    JSON.parse(JSON.stringify(toWire({ statement, contestedIn, ...change })))

  it('names one path for each commitment, in lower case', () => {
    expect(API_PATHS.contestStatements('0xABCDEF')).toBe(
      '/v1/commitments/0xabcdef/contest-statements',
    )
  })

  it('reads a request with the statement and the transaction that carried the contest', () => {
    expect(parseContestStatementRequest(body())).toEqual({
      ok: true,
      value: { statement, contestedIn },
    })
  })

  it("refuses a request without a transaction, with an extra field, or whose statement doesn't parse", () => {
    expect(parseContestStatementRequest({ statement })).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parseContestStatementRequest(body({ contestedIn: '0x12' }))).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(parseContestStatementRequest(body({ evidence: [] }))).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
    expect(
      parseContestStatementRequest(body({ statement: { ...statement, reason: 'none' } })),
    ).toEqual({ ok: false, reason: 'message.invalid' })
    // A statement whose text the format refuses keeps that reason.
    expect(parseContestStatementRequest(body({ statement: { ...statement, text: '' } }))).toEqual({
      ok: false,
      reason: 'contest.statement_invalid',
    })
  })

  it("reads Avow's answer only for the statement the caller sent", () => {
    const statementHash = contestStatementHash(statement)
    const answer = { statementHash, recordedAt: '1800000060' }
    expect(parseContestStatementAnswer(answer, { statementHash })).toEqual({
      ok: true,
      value: { statementHash, recordedAt: 1_800_000_060n },
    })
    const upper = `0x${statementHash.slice(2).toUpperCase()}` as Hex
    expect(
      parseContestStatementAnswer({ ...answer, statementHash: upper }, { statementHash }),
    ).toEqual({
      ok: true,
      value: { statementHash, recordedAt: 1_800_000_060n },
    })
    const refused = [
      { ...answer, statementHash: id('another statement') },
      { ...answer, recordedAt: 1_800_000_060 },
      { ...answer, extra: true },
      { statementHash },
    ]
    for (const json of refused) {
      expect(parseContestStatementAnswer(json, { statementHash })).toEqual({
        ok: false,
        reason: 'message.invalid',
      })
    }
  })
})
