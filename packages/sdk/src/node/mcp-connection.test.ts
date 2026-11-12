import { pairingCode } from '@avow-finance/spec'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { approvalLink, type ConnectOptions } from '../sandbox/connect.js'
import { type AgentItem, memoryStore, write } from '../sandbox/store.js'
import { mcpConnection } from './mcp-connection.js'

const BUSINESS = 'sandbox-9df2eec2a472a1819d20fba1f8a6f70a232f6447'
const OTHER = 'sandbox-1111111111111111111111111111111111111111'

/**
 * A connect that asks, holds the request until the administrator approves it, and then hands back
 * the agent item. What it was asked with is kept for the test to read.
 */
function fakeConnect(failure?: Error) {
  const agentKey = privateKeyToAccount(generatePrivateKey()).address
  const asks: ConnectOptions[] = []
  let approve: () => void = () => {}
  const approved = new Promise<void>((done) => {
    approve = done
  })
  const connect = async (o: ConnectOptions): Promise<AgentItem> => {
    asks.push(o)
    o.onEvent?.({
      type: 'asked',
      businessId: o.businessId,
      agentKey,
      pairingCode: pairingCode(agentKey),
    })
    if (failure) throw failure
    o.onEvent?.({ type: 'waiting', expiresAt: 1_800_003_600n })
    await approved
    o.onEvent?.({ type: 'approved', agentId: 'agt_research' })
    return {
      mandate: {
        message: { businessId: o.businessId, agentId: 'agt_research', expiry: 1_900_000_000n },
      },
    } as unknown as AgentItem
  }
  return { connect, asks, approve, agentKey }
}

describe('the MCP connection', () => {
  it('answers once Avow holds the request, keeps waiting, and reports the connection', async () => {
    const fake = fakeConnect()
    const connection = mcpConnection({ store: memoryStore(), connect: fake.connect })
    expect(await connection.state()).toEqual({ at: 'none' })

    const waiting = await connection.start({
      businessId: BUSINESS,
      label: 'Research agent',
      sell: false,
    })
    expect(waiting).toEqual({
      at: 'waiting',
      businessId: BUSINESS,
      label: 'Research agent',
      pairingCode: pairingCode(fake.agentKey),
      link: approvalLink(fake.agentKey),
      expiresAt: 1_800_003_600,
    })
    expect(await connection.state()).toEqual(waiting)

    // Asking the same business again answers with the same request, and asks nothing new.
    expect(await connection.start({ businessId: BUSINESS, label: null, sell: false })).toEqual(
      waiting,
    )
    expect(fake.asks).toHaveLength(1)
    // It asks one business at a time.
    await expect(connection.start({ businessId: OTHER, label: null, sell: false })).rejects.toThrow(
      'one business at a time',
    )

    fake.approve()
    await expect
      .poll(() => connection.state())
      .toEqual({
        at: 'connected',
        businessId: BUSINESS,
        agentId: 'agt_research',
        expiry: 1_900_000_000,
      })
  })

  it('asks with two calls at once only once, so the agent never makes two keys', async () => {
    const fake = fakeConnect()
    const connection = mcpConnection({ store: memoryStore(), connect: fake.connect })
    const ask = { businessId: BUSINESS, label: null, sell: false }
    const [a, b] = await Promise.all([connection.start(ask), connection.start(ask)])
    expect(a).toEqual(b)
    expect(fake.asks).toHaveLength(1)
  })

  it('fails with the reason when the ask never reaches Avow, and lets the model ask again', async () => {
    const unknown = new Error(
      `Avow has no sandbox business ${OTHER}. Copy its ID from the console.`,
    )
    const failing = fakeConnect(unknown)
    const store = memoryStore()
    const connection = mcpConnection({ store, connect: failing.connect })
    await expect(connection.start({ businessId: OTHER, label: null, sell: false })).rejects.toThrow(
      unknown.message,
    )
    expect(await connection.state()).toEqual({
      at: 'failed',
      businessId: OTHER,
      reason: unknown.message,
    })
    // The failed ask leaves the way open, here for the business the model meant.
    await expect(
      connection.start({ businessId: BUSINESS, label: null, sell: false }),
    ).rejects.toThrow()
    expect(failing.asks.map((a) => a.businessId)).toEqual([OTHER, BUSINESS])
  })

  it('resumes a request a restart left in the folder, under the name it asked with', async () => {
    const store = memoryStore()
    await write(store, 'request', {
      agentKey: generatePrivateKey(),
      businessId: BUSINESS,
      label: 'Research agent',
    })
    const fake = fakeConnect()
    const connection = mcpConnection({ store, connect: fake.connect })
    expect(await connection.state()).toEqual({
      at: 'saved',
      businessId: BUSINESS,
      label: 'Research agent',
    })
    await connection.start({ businessId: BUSINESS, label: null, sell: true })
    expect(fake.asks[0]).toMatchObject({
      businessId: BUSINESS,
      label: 'Research agent',
      sell: true,
    })
  })

  it('names a request made without a name the way the terminal does', async () => {
    const fake = fakeConnect()
    const connection = mcpConnection({ store: memoryStore(), connect: fake.connect })
    await connection.start({ businessId: BUSINESS, label: null, sell: false })
    expect(fake.asks[0]?.label).toBe('My agent')
  })
})
