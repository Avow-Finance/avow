import { API_AUTH_SCHEME, type Mandate, SANDBOX_PATHS, toWire } from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { askForChange, hasSettled, isUsable, raiseAsk, readOwnRequest } from './requests.js'

const current = { capPerCommitment: 250_000_000n, capOpenReserves: 1_000_000_000n } as Mandate
const ID = 'ab'.repeat(16)
const DOMAIN = { chainId: 42431, verifyingContract: `0x${'22'.repeat(20)}` } as const

describe('asking to raise a limit', () => {
  it("starts from the agent's current mandate, with the fixed reason for that limit", () => {
    expect(raiseAsk(current, 'per_commitment', 400_000_000n)).toEqual({
      kind: 'raise_limit',
      terms: { limit: 'per_commitment', from: 250_000_000n, to: 400_000_000n },
      reason: 'over_commitment_limit',
    })
    expect(raiseAsk(current, 'open_reserves', 2_000_000_000n).reason).toBe('reserves_limit_full')
  })

  it('refuses to ask for a limit that holds no more than now', () => {
    expect(() => raiseAsk(current, 'per_commitment', 250_000_000n)).toThrow(RangeError)
    expect(() => raiseAsk(current, 'open_reserves', 1n)).toThrow(RangeError)
  })

  it('asks as the agent, and answers with the link that opens its signing page', async () => {
    const agentKey = Account.fromSecp256k1(generatePrivateKey(), {
      access: Account.fromSecp256k1(generatePrivateKey()).address,
    })
    const ask = raiseAsk(current, 'per_commitment', 400_000_000n)
    const record = {
      id: ID,
      ...ask,
      businessId: 'sandbox-test',
      agentKey: agentKey.accessKeyAddress,
      basis: { mandate: `0x${'33'.repeat(32)}` },
      requestedAt: 1_800_000_000n,
      expiresAt: 1_800_086_400n,
      status: { state: 'waiting' },
    }
    const seen: { path: string; body: unknown; signed: boolean }[] = []
    const send = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      seen.push({
        path: url.pathname,
        body: JSON.parse(
          typeof init?.body === 'string'
            ? init.body
            : new TextDecoder().decode(init?.body as Uint8Array),
        ),
        signed:
          new Headers(init?.headers).get('authorization')?.startsWith(`${API_AUTH_SCHEME} `) ??
          false,
      })
      return Response.json(toWire(record), { status: 201 })
    }) as typeof fetch
    const context = { apiUrl: 'https://api.test', agentKey, domain: DOMAIN, send }
    const asked = await askForChange(context, ask)
    expect(asked.link).toBe(`https://testnet.avow.finance/#sign-${ID}`)
    expect(asked.request.status.state).toBe('waiting')
    expect(seen[0]).toMatchObject({ path: SANDBOX_PATHS.approvalRequests, signed: true })
    expect(seen[0]?.body).toEqual(toWire(ask))
    const read = await readOwnRequest(context, ID)
    expect(seen[1]?.path).toBe(SANDBOX_PATHS.approvalRequest(ID))
    expect(isUsable(read.request)).toBe(false)
    expect(hasSettled(read.request)).toBe(false)
  })
})
