import {
  CONTEST_REASONS,
  type ContestReason,
  type ContestStatement,
  type ContestStatementRequest,
  contestStatementHash,
  type ReasonCode,
} from '@avow-finance/spec'
import { LOCK_ABI, LOCK_PAUSED_EVENT_ABI, PAUSE_CAUSES } from '@avow-finance/verifier'
import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  type TransactionReceipt,
  toHex,
} from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Account } from 'viem/tempo'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BusinessRecords } from './avow-api.js'
import {
  CONTEST_SEND_MARGIN,
  type ContestConfig,
  type ContestRequest,
  contest,
  postContestStatement,
  readLandedContest,
  type SentContest,
  STATEMENT_TRIES,
} from './contest.js'
import { AvowApiError } from './http.js'
import { ADMINISTRATOR_ABI, type Call } from './lock.js'
import { SendError } from './send.js'
import { id, LOCK, lockRecord, TOKEN } from './test/fixture.js'

// Every key is generated for the run and held only in memory.
const root = Account.fromSecp256k1(generatePrivateKey())
const quick = { prepareTries: 1, sendTries: 1, signings: 1, wait: 1, receiptTimeout: 50 }
const COMMITMENT = id('contested commitment')
const TX = id('the contest transaction')
const CHARGE_START = 1_800_000_000n
const WINDOW = 600n
const RULING_KEY_END = 1800n
const RECORDED_AT = CHARGE_START + 90n
const TEXT = 'Our agent sent the start request on time, and the supplier receipted it.'

/** The lock's codes for the states a test sets, in the order the lock numbers them. */
const STATE = { reserved: 1, accepted: 2, charge_pending: 3, paused: 4, released: 5, resolved: 7 }
type LockRecord = ReturnType<typeof lockRecord>

/** A confirmed $500 no-show, pending since `CHARGE_START`, as the lock's `commitment` returns it. */
const pendingNoShow = (): LockRecord => ({
  ...lockRecord(null),
  state: STATE.charge_pending,
  hasReport: true,
  reportFinal: true,
  confirmed: true,
  reportKind: 1,
  reportCount: 1,
  amount: 500_000_000n,
  held: 500_000_000n,
  reportAmount: 500_000_000n,
  contestWindow: WINDOW,
  chargeStart: CHARGE_START,
})

let record: LockRecord | null
/** The lock's record as of the contest's block, which reads at that block see. */
let recordAtContest: LockRecord | null
/** The account the lock belongs to, the root key's own unless a test changes it. */
let lockOwner: Address
let chainNow: bigint
let receipts: Map<Hex, { status: 'success' | 'reverted'; logs: unknown[] }>
let sent: Call[]
let sentContests: SentContest[]
let sendFails: Error | null
/** What the lock's event says, which a test changes to show a transaction that carried another contest. */
let eventChange: { reasonCode?: number; statementHash?: Hex }
let posted: ContestStatementRequest[]
let avowSays: (AvowApiError | 'recorded')[]

/** The lock's `Paused` log for a contest, as the lock writes it in the transaction that took it. */
function pausedLog(args: {
  commitmentId: Hex
  side: number
  reasonCode: number
  statementHash: Hex
  pausedAt: bigint
}) {
  return {
    address: LOCK,
    blockHash: id('block'),
    blockNumber: '0x10',
    logIndex: '0x0',
    transactionHash: TX,
    transactionIndex: '0x0',
    removed: false,
    topics: encodeEventTopics({
      abi: LOCK_PAUSED_EVENT_ABI,
      eventName: 'Paused',
      args: { commitmentId: args.commitmentId },
    }),
    data: encodeAbiParameters(
      LOCK_PAUSED_EVENT_ABI[0].inputs.filter((i) => !i.indexed),
      [
        args.side,
        id('terms'),
        PAUSE_CAUSES.contest,
        args.pausedAt,
        args.reasonCode,
        args.statementHash,
        0n,
      ],
    ),
  }
}

/** A chain that answers reads of the lock, the latest block's time and the receipts it holds. */
const client = createClient({
  chain: tempoModerato,
  transport: custom(
    {
      async request({ method, params }) {
        if (method === 'eth_getBlockByNumber') {
          return {
            number: '0x10',
            timestamp: toHex(chainNow),
            hash: id('a block'),
            parentHash: id('its parent'),
            transactions: [],
          }
        }
        if (method === 'eth_getTransactionReceipt') {
          const [hash] = params as [Hex]
          const held = receipts.get(hash)
          if (!held) return null
          return {
            transactionHash: hash,
            blockHash: id('block'),
            blockNumber: '0x10',
            transactionIndex: '0x0',
            from: root.address,
            to: LOCK,
            cumulativeGasUsed: '0x1',
            gasUsed: '0x1',
            effectiveGasPrice: '0x1',
            contractAddress: null,
            logs: held.logs,
            logsBloom: `0x${'00'.repeat(256)}`,
            status: held.status === 'success' ? '0x1' : '0x0',
            type: '0x2',
          }
        }
        if (method !== 'eth_call') throw new Error(`the test reached the chain with ${method}`)
        const [call, block] = params as [{ to: Address; data: Hex }, unknown]
        if (call.to.toLowerCase() !== LOCK) throw new Error(`a read of ${call.to}`)
        const { functionName } = decodeFunctionData({ abi: LOCK_ABI, data: call.data })
        if (functionName === 'commitment') {
          // The contest landed in block 0x10, and a read there sees the lock as the contest left it.
          const held = block === '0x10' && recordAtContest ? recordAtContest : record
          return encodeFunctionResult({
            abi: LOCK_ABI,
            functionName: 'commitment',
            result: (held ?? lockRecord(null)) as never,
          })
        }
        if (functionName === 'account') {
          return encodeFunctionResult({ abi: LOCK_ABI, functionName, result: lockOwner })
        }
        if (functionName === 'token') {
          return encodeFunctionResult({ abi: LOCK_ABI, functionName, result: TOKEN.token })
        }
        if (functionName === 'rulingKeyEnd') {
          return encodeFunctionResult({ abi: LOCK_ABI, functionName, result: RULING_KEY_END })
        }
        throw new Error(`a read of ${functionName}`)
      },
    },
    { retryCount: 0 },
  ),
})

/** Avow's records route, answering from a script, recorded by default. */
const avow: BusinessRecords = {
  async postContestStatement(request) {
    posted.push(request)
    const next = avowSays.shift() ?? 'recorded'
    if (next instanceof AvowApiError) throw next
    return { statementHash: contestStatementHash(request.statement), recordedAt: RECORDED_AT }
  },
}

/**
 * Sends as the root key would, and lands like the lock. It tells `onSent` the hash first, then
 * pauses the charge and returns a receipt holding the lock's event for the contest it carried.
 */
async function send(
  calls: readonly Call[],
  onSent: Parameters<NonNullable<ContestConfig['send']>>[1],
) {
  sent.push(...calls)
  await onSent(TX, chainNow + 25n)
  // The caller hears the hash before the bytes go out.
  expect(sentContests.map((c) => c.hash)).toEqual([TX])
  if (sendFails) throw sendFails
  const [call] = calls as [Call]
  const { args } = decodeFunctionData({ abi: ADMINISTRATOR_ABI, data: call.data })
  const [commitmentId, side, , reasonCode, statementHash] = args as [
    Hex,
    number,
    number,
    number,
    Hex,
  ]
  if (record) record = { ...record, state: STATE.paused, contested: true, pausedAt: chainNow }
  recordAtContest = record
  const log = pausedLog({
    commitmentId,
    side,
    reasonCode,
    statementHash,
    pausedAt: chainNow,
    ...eventChange,
  })
  receipts.set(TX, { status: 'success', logs: [log] })
  return { status: 'success', transactionHash: TX, logs: [log] } as unknown as TransactionReceipt
}

const config: ContestConfig = { client, root, lock: LOCK, avow, send, limits: quick }
const ask = (change: Partial<ContestRequest> = {}) =>
  contest(config, {
    commitmentId: COMMITMENT,
    reason: 'job_started',
    text: TEXT,
    onSent: (s) => sentContests.push(s),
    ...change,
  })
const statement = (change: Partial<ContestStatement> = {}): ContestStatement => ({
  commitmentId: COMMITMENT,
  side: 'buyer',
  reportNumber: 1,
  reason: 'job_started',
  text: TEXT,
  ...change,
})
const refusal = (reason: ReasonCode) =>
  new AvowApiError(`refused: ${reason}`, {
    status: 409,
    reason,
    requestId: id('a request'),
    definite: true,
  })

beforeEach(() => {
  record = pendingNoShow()
  recordAtContest = null
  lockOwner = root.address
  chainNow = CHARGE_START + 60n
  receipts = new Map()
  sent = []
  sentContests = []
  sendFails = null
  eventChange = {}
  posted = []
  avowSays = []
})

describe('contesting a charge with the root key', () => {
  it('sends the contest, waits for it to land, and gives Avow the statement', async () => {
    const result = await ask()
    const s = statement()
    expect(result).toEqual({
      ok: true,
      contest: {
        statement: s,
        statementHash: contestStatementHash(s),
        transactionHash: TX,
        charge: { kind: 'noShow', amount: 500_000_000n },
        pausedAt: chainNow,
        ruleBy: chainNow + RULING_KEY_END,
      },
      posted: { ok: true, recordedAt: RECORDED_AT },
    })
    // One call to the lock's contest, naming the latest report, the reason's code and the hash.
    expect(sent).toHaveLength(1)
    const call = decodeFunctionData({ abi: ADMINISTRATOR_ABI, data: (sent[0] as Call).data })
    expect(sent[0]?.to).toBe(LOCK)
    expect(call.functionName).toBe('contest')
    expect(call.args).toEqual([COMMITMENT, 0, 1, 3, contestStatementHash(s)])
    expect(sentContests).toEqual([{ statement: s, hash: TX, validBefore: chainNow + 25n }])
    expect(posted).toEqual([{ statement: s, contestedIn: TX }])
  })

  it('contests an open report Avow has not answered, naming the report the lock holds', async () => {
    record = {
      ...pendingNoShow(),
      state: STATE.accepted,
      reportFinal: false,
      confirmed: false,
      chargeStart: 0n,
      reportCount: 2,
    }
    // Long after any contest window, since an open report takes a contest at any time.
    chainNow = CHARGE_START + 86_400n
    const result = await ask()
    expect(result.ok && result.contest.statement.reportNumber).toBe(2)
    const call = decodeFunctionData({ abi: ADMINISTRATOR_ABI, data: (sent[0] as Call).data })
    expect(call.args[2]).toBe(2)
  })

  it('writes the commitment id in lower case, whatever case it was given in', async () => {
    const upper = `0x${COMMITMENT.slice(2).toUpperCase()}` as Hex
    const result = await ask({ commitmentId: upper })
    expect(result.ok && result.contest.statement.commitmentId).toBe(COMMITMENT)
  })

  it('takes a pending charge while its window stays open for as long as a send can take to land', async () => {
    expect(CONTEST_SEND_MARGIN).toBe(25n)
    chainNow = CHARGE_START + WINDOW - CONTEST_SEND_MARGIN - 1n
    expect((await ask()).ok).toBe(true)
  })
})

describe('what it refuses before sending anything', () => {
  const refusedWith = async (reason: ReasonCode, change: Partial<ContestRequest> = {}) => {
    expect(await ask(change)).toEqual({ ok: false, reason })
    expect(sent).toEqual([])
    expect(posted).toEqual([])
  }

  it('a commitment the lock holds nothing for', async () => {
    record = null
    await refusedWith('chain.reserve_missing')
  })

  it('a commitment already contested, paused or with the contested report withdrawn', async () => {
    record = { ...pendingNoShow(), state: STATE.paused, contested: true, pausedAt: CHARGE_START }
    await refusedWith('contest.already_contested')
    record = { ...pendingNoShow(), state: STATE.accepted, hasReport: false, contested: true }
    await refusedWith('contest.already_contested')
  })

  it('a commitment with no pending charge and no standing report, or one already paused or ended', async () => {
    const records: LockRecord[] = [
      { ...pendingNoShow(), state: STATE.reserved, hasReport: false, reportCount: 0 },
      { ...pendingNoShow(), state: STATE.accepted, hasReport: false },
      // Paused by Avow or by a report Avow didn't answer, so a ruling comes without a contest.
      { ...pendingNoShow(), state: STATE.paused, contested: false },
      { ...pendingNoShow(), state: STATE.released, hasReport: false },
      { ...pendingNoShow(), state: STATE.resolved, contested: true },
    ]
    for (const r of records) {
      record = r
      await refusedWith('contest.not_contestable')
    }
  })

  it('a pending charge whose window closes before a contest sent now could land', async () => {
    for (const before of [CONTEST_SEND_MARGIN, 1n]) {
      chainNow = CHARGE_START + WINDOW - before
      await refusedWith('contest.window_closed')
    }
  })

  it("throws for a root key that isn't the lock's account, and sends nothing", async () => {
    lockOwner = '0x00000000000000000000000000000000000000b2'
    await expect(ask()).rejects.toThrow(
      `belongs to the account ${lockOwner}, so the root key ${root.address} can't contest on it`,
    )
    expect(sent).toEqual([])
  })

  it("a pending charge whose contest window has closed by the chain's clock", async () => {
    chainNow = CHARGE_START + WINDOW
    await refusedWith('contest.window_closed')
    chainNow = CHARGE_START + WINDOW + 3600n
    await refusedWith('contest.window_closed')
  })

  it("a reason that doesn't answer the kind of charge reported", async () => {
    for (const reason of ['never_cancelled', 'cancelled_in_time'] as ContestReason[]) {
      await refusedWith('contest.reason_not_for_charge', { reason })
    }
    record = { ...pendingNoShow(), reportKind: 0 }
    for (const reason of ['job_started', 'supplier_did_not_provide'] as ContestReason[]) {
      await refusedWith('contest.reason_not_for_charge', { reason })
    }
  })

  it('a statement whose text the format refuses', async () => {
    for (const text of ['', '   ', 'a'.repeat(4001), 'nul\u0000']) {
      await refusedWith('contest.statement_invalid', { text })
    }
  })

  it('sends a reason that answers any charge, whatever the kind', async () => {
    for (const kind of [0, 1]) {
      for (const reason of ['wrong_charge', 'other'] as ContestReason[]) {
        record = { ...pendingNoShow(), reportKind: kind }
        sentContests = []
        const result = await ask({ reason })
        expect(result.ok && CONTEST_REASONS[result.contest.statement.reason].code).toBe(
          CONTEST_REASONS[reason].code,
        )
      }
    }
  })
})

describe('once the contest has landed', () => {
  it("returns the contest with Avow's refusal when posting fails, and posting again is safe", async () => {
    avowSays = [refusal('service.unavailable')]
    const result = await ask()
    if (!result.ok) throw new Error(result.reason)
    expect(result.contest.transactionHash).toBe(TX)
    expect(result.posted.ok).toBe(false)
    expect(!result.posted.ok && result.posted.error).toMatchObject({
      reason: 'service.unavailable',
    })
    // The same statement goes again, and Avow answers as it would have.
    expect(await postContestStatement(avow, result.contest, quick)).toEqual({
      statementHash: result.contest.statementHash,
      recordedAt: RECORDED_AT,
    })
    expect(posted).toEqual([
      { statement: result.contest.statement, contestedIn: TX },
      { statement: result.contest.statement, contestedIn: TX },
    ])
  })

  it("asks again while Avow's node hasn't seen the contest, and stops after a few tries", async () => {
    avowSays = [refusal('contest.not_on_chain'), refusal('contest.not_on_chain')]
    const result = await ask()
    expect(result.ok && result.posted).toEqual({ ok: true, recordedAt: RECORDED_AT })
    expect(posted).toHaveLength(3)

    posted = []
    sentContests = []
    record = pendingNoShow()
    avowSays = Array.from({ length: STATEMENT_TRIES }, () => refusal('contest.not_on_chain'))
    const unseen = await ask()
    expect(posted).toHaveLength(STATEMENT_TRIES)
    expect(unseen.ok && !unseen.posted.ok && unseen.posted.error).toMatchObject({
      reason: 'contest.not_on_chain',
    })
  })

  it('posts only once for any other refusal', async () => {
    avowSays = [refusal('contest.statement_mismatch'), refusal('contest.statement_mismatch')]
    const result = await ask()
    expect(posted).toHaveLength(1)
    expect(result.ok && result.posted.ok).toBe(false)
  })

  it("throws the sender's error when the contest fails or its outcome is unknown, and posts nothing", async () => {
    sendFails = new SendError(`The transaction ${TX} reverted`, 'failed', {
      hashes: [TX],
      signings: 1,
    })
    await expect(ask()).rejects.toBe(sendFails)
    expect(posted).toEqual([])
  })

  it('throws when the receipt holds another contest than the statement', async () => {
    eventChange = { statementHash: id('another statement') }
    await expect(ask()).rejects.toThrow(
      `${TX} holds no contest of ${COMMITMENT} with this statement`,
    )
    record = pendingNoShow()
    sentContests = []
    eventChange = { reasonCode: 6 }
    await expect(ask()).rejects.toThrow('holds no contest')
    expect(posted).toEqual([])
  })
})

describe('settling a contest from the chain', () => {
  it('reads a contest that landed as contest returned it', async () => {
    const result = await ask()
    if (!result.ok) throw new Error(result.reason)
    expect(await readLandedContest(config, result.contest.statement, TX)).toEqual(result.contest)
  })

  it('reads nothing from a transaction that failed or that the chain lacks', async () => {
    expect(await readLandedContest(config, statement(), TX)).toBeNull()
    receipts.set(TX, { status: 'reverted', logs: [] })
    expect(await readLandedContest(config, statement(), TX)).toBeNull()
  })

  it('shows the charge the contested report named, after the supplier withdrew it and filed another', async () => {
    record = { ...pendingNoShow(), state: STATE.accepted, confirmed: false, reportFinal: false }
    const result = await ask()
    if (!result.ok) throw new Error(result.reason)
    expect(result.contest.charge).toEqual({ kind: 'noShow', amount: 500_000_000n })
    // The supplier withdraws report 1 and files a $250 late cancellation as report 2, which the
    // lock pauses at once, since the contest stays on record.
    record = {
      ...pendingNoShow(),
      state: STATE.paused,
      contested: true,
      reportCount: 2,
      reportKind: 0,
      reportAmount: 250_000_000n,
    }
    expect(await readLandedContest(config, result.contest.statement, TX)).toEqual(result.contest)
  })

  it('throws for a transaction whose contest named another report than the statement', async () => {
    const result = await ask()
    if (!result.ok) throw new Error(result.reason)
    recordAtContest = { ...(recordAtContest as LockRecord), reportCount: 2 }
    await expect(readLandedContest(config, result.contest.statement, TX)).rejects.toThrow(
      'holds no contest',
    )
  })

  it('throws for a transaction that carried a contest with another statement', async () => {
    const result = await ask()
    if (!result.ok) throw new Error(result.reason)
    await expect(
      readLandedContest(config, statement({ text: 'Other words.' }), TX),
    ).rejects.toThrow('holds no contest')
  })
})
