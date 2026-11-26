import { API_AUTH_SCHEME, SANDBOX_PATHS, toWire } from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { rootRequestKey } from '../http.js'
import { sandboxWaitingRequests } from './waiting-requests.js'

const DOMAIN = { chainId: 42431, verifyingContract: `0x${'22'.repeat(20)}` } as const

describe("a business's waiting requests", () => {
  it('reads them signed by the root key, and answers the list Avow sends', async () => {
    const request = {
      id: 'ab'.repeat(16),
      kind: 'raise_limit',
      businessId: 'sandbox-test',
      agentKey: `0x${'11'.repeat(20)}`,
      terms: { limit: 'per_commitment', from: 250_000_000n, to: 400_000_000n },
      reason: 'over_commitment_limit',
      basis: { mandate: `0x${'33'.repeat(32)}` },
      requestedAt: 1_800_000_000n,
      expiresAt: 1_800_086_400n,
      status: { state: 'waiting' },
    } as const
    const seen: { path: string; signed: boolean }[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        path: new URL(String(input)).pathname,
        signed:
          new Headers(init?.headers).get('authorization')?.startsWith(`${API_AUTH_SCHEME} `) ??
          false,
      })
      return Response.json(toWire({ requests: [request] }))
    }) as typeof globalThis.fetch
    const list = await sandboxWaitingRequests({
      baseUrl: 'https://api.test',
      key: rootRequestKey(Account.fromSecp256k1(generatePrivateKey())),
      domain: DOMAIN,
      fetch,
    })
    expect(list.requests.map((r) => r.id)).toEqual([request.id])
    expect(seen).toEqual([{ path: SANDBOX_PATHS.approvalRequestsWaiting, signed: true }])
  })
})
