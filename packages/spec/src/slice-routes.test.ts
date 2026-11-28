import { describe, expect, it } from 'vitest'
import { API_PATH_PATTERN } from './api-request.js'
import { digestOf, mandateHash } from './eip712.js'
import { SANDBOX_PATHS } from './sandbox.js'
import { sliceTypedData } from './slice.js'
import { parseWorkerSlicesAnswer, parseWorkerSlicesRead } from './slice-routes.js'
import { CHAIN_ID, DOMAIN, demoMandate, demoSlice, LOCK, newKey } from './test-helpers.js'
import { toWire } from './wire.js'

const agent = newKey()
const worker = newKey()
const mandate = demoMandate(newKey().address, agent.address)
const slice = demoSlice(mandate, mandateHash(mandate, DOMAIN), worker.address)
const expected = { chainId: CHAIN_ID, lock: LOCK }

async function answer() {
  return JSON.parse(
    JSON.stringify(
      toWire({
        slices: {
          levels: [
            {
              current: {
                type: 'Slice',
                schemaVersion: '1',
                chainId: CHAIN_ID,
                lock: LOCK,
                message: slice,
                signature: await agent.sign({ hash: digestOf(sliceTypedData(slice, DOMAIN)) }),
              },
              earlier: [],
            },
          ],
          revocations: [],
        },
        holdings: { openReserves: { mandate: 5n, slices: [3n] }, approvedWithin: [2n] },
      }),
    ),
  )
}

describe('the slice routes', () => {
  it('sit at paths a signed request can name', () => {
    for (const path of [
      SANDBOX_PATHS.slices,
      SANDBOX_PATHS.workerSlices,
      SANDBOX_PATHS.sliceRevocations,
    ]) {
      expect(API_PATH_PATTERN.test(path)).toBe(true)
    }
  })

  it('read a request that names only the worker key', () => {
    const read = parseWorkerSlicesRead({ subKey: worker.address })
    expect(read.ok && read.value.subKey.toLowerCase()).toBe(worker.address.toLowerCase())
    expect(parseWorkerSlicesRead({ subKey: worker.address, more: 1 }).ok).toBe(false)
    expect(
      parseWorkerSlicesRead({ subKey: worker.address, excluding: `0x${'ab'.repeat(32)}` }).ok,
    ).toBe(true)
    expect(parseWorkerSlicesRead({ subKey: worker.address, excluding: '0x12' }).ok).toBe(false)
    expect(parseWorkerSlicesRead({ subKey: 'nope' }).ok).toBe(false)
  })

  it('read an answer whose holdings name every level', async () => {
    const read = parseWorkerSlicesAnswer(await answer(), expected)
    expect(read).toMatchObject({
      ok: true,
      value: { holdings: { openReserves: { mandate: 5n, slices: [3n] }, approvedWithin: [2n] } },
    })
    const short = await answer()
    short.holdings.approvedWithin = []
    expect(parseWorkerSlicesAnswer(short, expected).ok).toBe(false)
    const negative = await answer()
    negative.holdings.openReserves.mandate = '-1'
    expect(parseWorkerSlicesAnswer(negative, expected).ok).toBe(false)
  })
})
