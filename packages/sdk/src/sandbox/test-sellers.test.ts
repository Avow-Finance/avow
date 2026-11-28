import { describe, expect, it } from 'vitest'
import { json, wire } from '../test/agent-folder.js'
import { deployment } from '../test/sandbox-business.js'
import { SELLER, testPing, testSellersList } from '../test/test-sellers.js'
import { sandboxTestSellers } from './test-sellers.js'

/** The sandbox's deployment file, with whatever a test adds to it. */
const sandbox = (extra: Record<string, unknown> = {}) =>
  (async () => json({ ...wire(deployment), ...extra })) as unknown as typeof fetch

describe("the sandbox's test sellers", () => {
  it('are read from the deployment file, each labelled with its offers whole', async () => {
    expect(await sandboxTestSellers({ fetch: sandbox({ testSellers: testSellersList }) })).toEqual({
      listed: true,
      sellers: [
        { businessId: SELLER, name: 'Test Seller One (test business)', offers: [testPing] },
      ],
    })
  })

  it('are none when the deployment lists none, or lists an empty list', async () => {
    expect(await sandboxTestSellers({ fetch: sandbox() })).toEqual({ listed: false })
    expect(await sandboxTestSellers({ fetch: sandbox({ testSellers: [] }) })).toEqual({
      listed: false,
    })
  })

  it("are refused whole when one isn't labelled as a test business", async () => {
    const unlabelled = [{ ...testSellersList[0], name: 'Seller One' }]
    await expect(
      sandboxTestSellers({ fetch: sandbox({ testSellers: unlabelled }) }),
    ).rejects.toThrow("The SDK can't read the sandbox's list of test sellers")
  })

  it('are read only from a deployment on a factory the SDK trusts', async () => {
    const elsewhere = sandbox({
      factory: '0x00000000000000000000000000000000000000f1',
      testSellers: testSellersList,
    })
    await expect(sandboxTestSellers({ fetch: elsewhere })).rejects.toThrow('the SDK trusts only')
  })
})
