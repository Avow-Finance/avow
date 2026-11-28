import { dollars, SANDBOX_PATHS, SERVICE_CATEGORY } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { folderWithAgent, json, wire } from '../test/agent-folder.js'
import { listedTranscript, searchAnswer, searchingAvow } from '../test/offer-search.js'
import { sandboxAgent } from './agent.js'
import { OFFER_SEARCH_UNSERVED, offerSearchOf } from './offer-search.js'
import { loadAgentItem } from './store.js'

const BUYER = 'sandbox-buyer'

/** A buyer's agent in a folder, with Avow answering searches as `answer` says. */
async function buyer(answer: Parameters<typeof searchingAvow>[0]) {
  const { store } = await folderWithAgent(BUYER, {
    suppliers: ['sandbox-seller'],
    categories: [SERVICE_CATEGORY],
  })
  const item = await loadAgentItem(store)
  if (!item) throw new Error('the folder holds an agent')
  const avow = searchingAvow(answer)
  const agent = await sandboxAgent({ store, session: null, fetch: avow.fetch, log: () => {} })
  return { agent, mandate: item.mandateHash, paths: avow.paths }
}

const search = offerSearchOf({ query: 'transcript', budget: dollars(200), quantity: 2 })

describe("a buyer's search of Avow's directory", () => {
  it('sends the search with what it left out filled in, and answers the offers Avow found', async () => {
    const sent: Record<string, unknown>[] = []
    let mandate = '0x' as `0x${string}`
    const { agent, mandate: held } = await buyer((path, body) => {
      if (path !== SANDBOX_PATHS.offerSearch) return null
      sent.push(body)
      return json(searchAnswer(search, mandate, [listedTranscript()]))
    })
    mandate = held
    const outcome = await agent.searchOffers({
      query: ' transcript ',
      budget: dollars(200),
      quantity: 2,
    })
    if (!outcome.ok) throw new Error('the search was answered')
    expect(sent).toEqual([
      wire({
        query: 'transcript',
        budget: dollars(200),
        currency: 'USD',
        quantity: 2,
        deliverBy: null,
        needingApproval: false,
      }),
    ])
    const [found] = outcome.result.eligible.offers
    expect(found?.version).toEqual(listedTranscript())
    expect(found?.supplier).toEqual({ name: 'Test Transcripts', sandbox: true })
    expect(found?.quote.total).toBe(dollars(100))
    expect(outcome.result.mandate).toBe(held.toLowerCase())
  })

  it('refuses a search Avow would refuse, and sends nothing for it', async () => {
    const { agent, paths } = await buyer(() => null)
    await expect(agent.searchOffers({ budget: 0n })).rejects.toThrow(RangeError)
    await expect(agent.searchOffers({ budget: dollars(1), quantity: 0 })).rejects.toThrow(
      RangeError,
    )
    await expect(
      agent.searchOffers({ budget: dollars(1), query: 'x'.repeat(201) }),
    ).rejects.toThrow(RangeError)
    expect(paths).not.toContain(SANDBOX_PATHS.offerSearch)
  })

  it('says plainly when the sandbox lists no offers, whichever way it says so', async () => {
    for (const refusal of [
      json({ error: { reason: 'offer.listing_unavailable', message: 'No listings' } }, 409),
      null,
    ]) {
      const { agent } = await buyer((path) => (path === SANDBOX_PATHS.offerSearch ? refusal : null))
      expect(await agent.searchOffers({ budget: dollars(200) })).toEqual({
        ok: false,
        reason: 'offer.listing_unavailable',
        notice: OFFER_SEARCH_UNSERVED,
      })
    }
  })

  it('passes on any other refusal by its reason', async () => {
    const { agent } = await buyer((path) =>
      path === SANDBOX_PATHS.offerSearch
        ? json({ error: { reason: 'mandate.revoked', message: 'Revoked' } }, 403)
        : null,
    )
    await expect(agent.searchOffers({ budget: dollars(200) })).rejects.toMatchObject({
      reason: 'mandate.revoked',
    })
  })

  it('refuses an answer to another search, or one checked long ago', async () => {
    let mandate = '0x' as `0x${string}`
    let answer = () => searchAnswer({ ...search, budget: dollars(300) }, mandate, [])
    const { agent, mandate: held } = await buyer((path) =>
      path === SANDBOX_PATHS.offerSearch ? json(answer()) : null,
    )
    mandate = held
    const asked = { query: 'transcript', budget: dollars(200), quantity: 2 }
    await expect(agent.searchOffers(asked)).rejects.toThrow(/another search/)
    answer = () => searchAnswer(search, mandate, [], BigInt(Math.floor(Date.now() / 1000)) - 3600n)
    await expect(agent.searchOffers(asked)).rejects.toThrow(/checked just now/)
  })

  it('reads its own mandate again before refusing an answer checked against another', async () => {
    const other = `0x${'ee'.repeat(32)}` as const
    const { agent, paths } = await buyer((path) =>
      path === SANDBOX_PATHS.offerSearch ? json(searchAnswer(search, other, [])) : null,
    )
    const reads = () => paths.filter((p) => p === SANDBOX_PATHS.agentMandates).length
    const before = reads()
    await expect(
      agent.searchOffers({ query: 'transcript', budget: dollars(200), quantity: 2 }),
    ).rejects.toThrow(/another mandate/)
    expect(reads()).toBe(before + 1)
  })

  it("refuses an answer the spec's parser finds inconsistent", async () => {
    let mandate = '0x' as `0x${string}`
    const { agent, mandate: held } = await buyer((path) => {
      if (path !== SANDBOX_PATHS.offerSearch) return null
      const answer = searchAnswer(search, mandate, [listedTranscript()])
      // A total that isn't what the offer costs for the quantity.
      answer.eligible.offers[0].quote.total = '1'
      return json(answer)
    })
    mandate = held
    await expect(
      agent.searchOffers({ query: 'transcript', budget: dollars(200), quantity: 2 }),
    ).rejects.toMatchObject({ reason: 'message.invalid' })
  })
})
