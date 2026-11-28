import {
  dollars,
  type OfferSearch,
  offerMatch,
  offerSearchResult,
  SANDBOX_PATHS,
  type ServiceOfferVersion,
} from '@avow-finance/spec'
import type { Hex } from 'viem'
import { json, wire } from './agent-folder.js'
import { deployment } from './sandbox-business.js'

const HOUR = 3600n

/** A sandbox seller's transcription by the hour, at $50 a unit, as Avow lists it. */
export const listedTranscript = (supplier = 'sandbox-seller'): ServiceOfferVersion => ({
  supplier,
  item: { name: 'Transcript', summary: 'One hour of audio transcribed into English text' },
  currency: 'USD',
  unitPrice: dollars(50),
  rules: {
    evidence: 'The transcript is delivered to the buyer as a text file',
    leadTime: 24n * HOUR,
    maxPerBooking: 10,
    dailyCapacity: 20,
    freeCancelWindow: 2n * HOUR,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
    payment: { route: 'transfer', dueAfterDelivery: 7n * 24n * HOUR },
  },
})

/**
 * Avow's answer to a search as the route builds it, from the spec's own `offerMatch` and
 * `offerSearchResult`, with every version eligible and checked now.
 */
export function searchAnswer(
  search: OfferSearch,
  mandate: Hex,
  versions: readonly ServiceOfferVersion[],
  checkedAt = BigInt(Math.floor(Date.now() / 1000)),
) {
  return wire(
    offerSearchResult({
      search,
      checkedAt,
      mandate,
      eligible: versions.map((v) => offerMatch(search, v, 'Test Transcripts', checkedAt)),
      needingApproval: [],
    }),
  )
}

/**
 * Avow's API as far as a search needs it: the deployment, no route for the agent's mandates, so
 * the agent keeps the one it enrolled with, then whatever the test answers. It counts each path.
 */
export function searchingAvow(
  answer: (path: string, body: Record<string, unknown>) => Response | null,
) {
  const paths: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path === '/config.json') return json(wire(deployment))
    const body = init?.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : {}
    const answered = path === SANDBOX_PATHS.agentMandates ? null : answer(path, body)
    return answered ?? json({ error: { reason: 'request.invalid', message: 'No such route' } }, 404)
  }) as typeof globalThis.fetch
  return { fetch, paths }
}
