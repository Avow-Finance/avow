import { triggerCall } from '@avow-finance/sdk'
import { SIDE_CODES } from '@avow-finance/spec'
import { FACTORY_EVENTS_ABI, LOCK_EVENTS_ABI } from '@avow-finance/verifier'
import {
  type AbiEvent,
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  type Hex,
  keccak256,
  toEventSelector,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { type CommitmentSide, TooManyLogsError } from './chain.js'
import { tempoKeeperChain } from './tempo.js'
import { commitment, FACTORY, lockAt } from './test/fixtures.js'
import { type NodeLog, type NodeScript, scriptedNode } from './test/scripted-node.js'

const ZERO32: Hex = `0x${'00'.repeat(32)}`
const [L1, L2, L3] = [lockAt(1), lockAt(2), lockAt(3)]
const LIMITS = { prepareTries: 2, sendTries: 3, signings: 1, wait: 1, receiptTimeout: 200 }

/** A log of `event` with these values, as a contract would write it. */
function logOf(
  event: AbiEvent,
  values: Record<string, unknown>,
  address: Address,
  block: bigint,
): NodeLog {
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args: values } as never)
  const unindexed = event.inputs.filter((input) => !input.indexed)
  const data = encodeAbiParameters(
    unindexed,
    unindexed.map((input) => values[input.name ?? '']),
  )
  return { address, block, topics: topics as [Hex, ...Hex[]], data }
}

const lockEvent = (name: (typeof LOCK_EVENTS_ABI)[number]['name']) =>
  getAbiItem({ abi: LOCK_EVENTS_ABI, name }) as AbiEvent

const lockCreated = (lock: Address, block: bigint, factory: Address = FACTORY) =>
  logOf(FACTORY_EVENTS_ABI[0], { account: lockAt(0xacc), lock }, factory, block)

const reserved = (s: CommitmentSide, block: bigint, side: number = SIDE_CODES[s.side]) =>
  logOf(
    lockEvent('Reserved'),
    {
      commitmentId: s.commitmentId,
      side,
      termsHash: ZERO32,
      mandateHash: ZERO32,
      amount: 500_000_000n,
      supplier: lockAt(0x5),
      payout: lockAt(0x5),
      fundedBy: lockAt(0xf),
      approvalNonce: 1n,
      approvalHash: ZERO32,
    },
    s.lock,
    block,
  )

const released = (s: CommitmentSide, block: bigint) =>
  logOf(
    lockEvent('Released'),
    {
      commitmentId: s.commitmentId,
      side: SIDE_CODES[s.side],
      termsHash: ZERO32,
      cause: 2,
      reason: 1,
      evidenceHash: ZERO32,
      returned: 500_000_000n,
    },
    s.lock,
    block,
  )

const charged = (s: CommitmentSide, block: bigint) =>
  logOf(
    lockEvent('Charged'),
    {
      commitmentId: s.commitmentId,
      side: SIDE_CODES[s.side],
      termsHash: ZERO32,
      amount: 250_000_000n,
      evidenceHash: ZERO32,
    },
    s.lock,
    block,
  )

const resolved = (s: CommitmentSide, block: bigint) =>
  logOf(
    lockEvent('Resolved'),
    {
      commitmentId: s.commitmentId,
      side: SIDE_CODES[s.side],
      termsHash: ZERO32,
      byRuling: false,
      toSupplier: 250_000_000n,
      toBusiness: 250_000_000n,
      evidenceHash: ZERO32,
    },
    s.lock,
    block,
  )

const S1: CommitmentSide = { lock: L1, commitmentId: commitment(1), side: 'buyer' }
const S2: CommitmentSide = { lock: L2, commitmentId: commitment(2), side: 'supplier' }
const S3: CommitmentSide = { lock: L1, commitmentId: commitment(3), side: 'buyer' }
const dueKey = (s: CommitmentSide) => `${s.lock}:${s.commitmentId}:${SIDE_CODES[s.side]}`

function onNode(script: NodeScript) {
  const node = scriptedNode(script)
  const key = privateKeyToAccount(generatePrivateKey())
  return { node, key, chain: tempoKeeperChain({ client: node.client, key, limits: LIMITS }) }
}

const logQueries = (node: ReturnType<typeof scriptedNode>) =>
  node.requests.filter((r) => r.method === 'eth_getLogs').map((r) => r.params[0])

describe('the keeper on Tempo', () => {
  it('reads the latest block and the time of any block', async () => {
    const { chain } = onNode({ head: 500n })
    const head = await chain.head()
    expect(head.number).toBe(500n)
    expect(await chain.timestampOf(400n)).toBe(head.timestamp - 100n)
  })

  it('reads each lock the factory created from its LockCreated logs', async () => {
    const { node, chain } = onNode({
      head: 500n,
      logs: [lockCreated(L1, 120n), lockCreated(L2, 130n), lockCreated(L3, 140n, lockAt(0xbad))],
    })
    expect(await chain.locksCreated(FACTORY, { from: 100n, to: 200n })).toEqual([
      getAddress(L1),
      getAddress(L2),
    ])
    expect(logQueries(node)).toEqual([
      {
        address: FACTORY,
        topics: [[toEventSelector(FACTORY_EVENTS_ABI[0])]],
        fromBlock: '0x64',
        toBlock: '0xc8',
      },
    ])
  })

  it("reads reserves and endings from the locks' logs, each side by the code the lock logs", async () => {
    const S4: CommitmentSide = { lock: L3, commitmentId: commitment(4), side: 'buyer' }
    const { node, chain } = onNode({
      head: 500n,
      logs: [
        reserved(S1, 110n),
        released(S1, 120n),
        reserved(S2, 130n),
        charged(S2, 140n),
        resolved(S3, 150n),
        // A lock the query doesn't name.
        reserved(S4, 160n),
      ],
    })
    expect(await chain.sideEvents([L1, L2], { from: 100n, to: 200n })).toEqual([
      { ...S1, lock: getAddress(L1), kind: 'reserved' },
      { ...S1, lock: getAddress(L1), kind: 'ended' },
      { ...S2, lock: getAddress(L2), kind: 'reserved' },
      { ...S2, lock: getAddress(L2), kind: 'ended' },
      { ...S3, lock: getAddress(L1), kind: 'ended' },
    ])
    expect(logQueries(node)[0]).toMatchObject({
      address: [L1, L2],
      topics: [
        ['Reserved', 'Released', 'Charged', 'Resolved'].map((name) =>
          toEventSelector(lockEvent(name as 'Reserved')),
        ),
      ],
    })
  })

  it("refuses a log it can't read, so no reserve goes missing", async () => {
    const cut = reserved(S1, 110n)
    const short = onNode({ head: 500n, logs: [{ ...cut, data: cut.data.slice(0, 66) as Hex }] })
    await expect(short.chain.sideEvents([L1], { from: 100n, to: 200n })).rejects.toThrow()
    const odd = onNode({ head: 500n, logs: [reserved(S1, 110n, 2)] })
    await expect(odd.chain.sideEvents([L1], { from: 100n, to: 200n })).rejects.toThrow(
      `The lock ${L1} logged side 2, which no side has`,
    )
  })

  it("counts only the lock's NothingDue() as no step due, simulated from the run's key", async () => {
    const { node, key, chain } = onNode({ head: 500n, due: [dueKey(S1)] })
    expect(await chain.isDue(S1)).toBe(true)
    expect(await chain.isDue({ ...S1, side: 'supplier' })).toBe(false)
    // Simulated from the run's key, with the call the keeper would send.
    const [simulation] = node.requests.filter((r) => r.method === 'eth_call')
    const request = simulation?.params[0] as {
      from: Address
      to?: Address
      data?: Hex
      calls?: { to: Address; data: Hex }[]
    }
    expect(request.from.toLowerCase()).toBe(key.address.toLowerCase())
    const call = triggerCall(S1.lock, S1.commitmentId, S1.side)
    expect(request.to ?? request.calls?.[0]?.to).toBe(call.to)
    expect(request.data ?? request.calls?.[0]?.data).toBe(call.data)
  })

  it('throws on any other revert, so the run reports the side as unchecked', async () => {
    // The lock's answer for a commitment it doesn't know, and a revert that carries no data.
    const unknown = onNode({ head: 500n, revertData: '0x5b07c989' })
    await expect(unknown.chain.isDue(S1)).rejects.toThrow(
      'The lock reverted with 0x5b07c989, an error other than NothingDue()',
    )
    const bare = onNode({ head: 500n, revertData: null })
    await expect(bare.chain.isDue(S1)).rejects.toThrow('Execution reverted')
  })

  it('throws when the node is rate limited or down', async () => {
    for (const callsFail of ['http-rate-limit', 'rpc-rate-limit', 'gateway'] as const) {
      const { chain } = onNode({ head: 500n, due: [dueKey(S1)], callsFail })
      await expect(chain.isDue(S1), callsFail).rejects.toThrow()
      await expect(chain.isDue({ ...S1, side: 'supplier' }), callsFail).rejects.toThrow()
    }
  })

  it('throws a TooManyLogsError for a range the node holds too many logs for', async () => {
    const { chain } = onNode({
      head: 500n,
      maxResults: 1,
      logs: [lockCreated(L1, 120n), lockCreated(L2, 130n)],
    })
    const refusal = chain.locksCreated(FACTORY, { from: 100n, to: 200n })
    await expect(refusal).rejects.toBeInstanceOf(TooManyLogsError)
    await expect(refusal).rejects.toMatchObject({ range: { from: 100n, to: 200n } })
    expect(await chain.locksCreated(FACTORY, { from: 100n, to: 125n })).toEqual([getAddress(L1)])
    const sides = onNode({
      head: 500n,
      maxResults: 1,
      logs: [reserved(S1, 110n), released(S1, 120n)],
    })
    await expect(sides.chain.sideEvents([L1], { from: 100n, to: 200n })).rejects.toBeInstanceOf(
      TooManyLogsError,
    )
  })

  it("reads the outcome by hash when the node answers the send with an error, and sends the step's transaction once", async () => {
    const { node, chain } = onNode({
      head: 500n,
      due: [dueKey(S1)],
      send: 'take-then-fail',
      receipt: 'success',
    })
    const result = await chain.send(S1)
    expect(node.sent).toHaveLength(1)
    const hash = keccak256(node.sent[0] as Hex)
    expect(result).toEqual({ outcome: 'landed', hash })
    expect(node.requests).toContainEqual({ method: 'eth_getTransactionByHash', params: [hash] })
    expect(node.requests).toContainEqual({ method: 'eth_getTransactionReceipt', params: [hash] })
    // The one transaction is the trigger call, signed locally.
    const tx = Transaction.deserialize(node.sent[0] as Transaction.TransactionSerializedTempo)
    const call = triggerCall(S1.lock, S1.commitmentId, S1.side)
    expect('calls' in tx && tx.calls).toEqual([expect.objectContaining(call)])
  })

  it('reports a transaction that reverted as failed', async () => {
    const { chain } = onNode({ head: 500n, due: [dueKey(S1)], receipt: 'reverted' })
    const result = await chain.send(S1)
    expect(result.outcome).toBe('failed')
    expect(result.outcome === 'failed' && result.reason).toMatch(/reverted/)
  })

  it('reports a transaction whose receipt never comes as unknown, with its hash', async () => {
    const { node, chain } = onNode({ head: 500n, due: [dueKey(S1)], receipt: 'none' })
    const result = await chain.send(S1)
    expect(result).toMatchObject({
      outcome: 'unknown',
      hashes: [keccak256(node.sent[0] as Hex)],
    })
  })

  it("has the faucet fund the run's key, and waits for the faucet's transfers", async () => {
    const { node, key, chain } = onNode({ head: 500n })
    await chain.fund()
    expect(node.requests).toContainEqual({ method: 'tempo_fundAddress', params: [key.address] })
    for (const hash of node.faucetHashes) {
      expect(node.requests).toContainEqual({ method: 'eth_getTransactionReceipt', params: [hash] })
    }
  })
})
