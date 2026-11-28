import { readFileSync } from 'node:fs'
import { type Hex, keccak256, toHex, zeroHash } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import { mandateHash } from './eip712.js'
import {
  type AuthorityLimits,
  parseSlice,
  type Slice,
  sliceAsMandate,
  sliceHash,
  sliceJson,
  sliceProblem,
  sliceRevocationHash,
  sliceRevocationJson,
  sliceTypedData,
  sliceWidensProblem,
} from './slice.js'
import {
  CHAIN_ID,
  DOMAIN,
  demoMandate,
  demoSlice,
  id,
  LOCK,
  newKey,
  TOKEN,
} from './test-helpers.js'
import { MESSAGE_VERSIONS } from './version.js'
import { toWire } from './wire.js'

const account = '0x00000000000000000000000000000000000000a1'
const agentKey = '0x00000000000000000000000000000000000000b2'
const subKey = '0x00000000000000000000000000000000000000c3'
const mandate = demoMandate(account, agentKey)
const mHash = mandateHash(mandate, DOMAIN)
const slice = demoSlice(mandate, mHash, subKey)

describe('a slice', () => {
  it('signs at its own version 1, with zero for a price limit and a replaced hash it leaves out', () => {
    const td = sliceTypedData(slice, DOMAIN)
    expect(td.domain.version).toBe(MESSAGE_VERSIONS.Slice)
    expect(MESSAGE_VERSIONS.Slice).toBe('1')
    expect(td.message.priceCapPerCommitment).toBe(0n)
    expect(td.message.replaces).toBe(zeroHash)
    expect(td.message.approvalRule).toBe(1)
    expect(td.message.approvalAbove).toBe(dollars(550))
  })

  it('hashes as version 1 published it', () => {
    // Pinned, so a change to the table or the encoding fails here and needs a new version.
    expect(sliceHash(slice, DOMAIN)).toBe(GOLDEN_SLICE)
    expect(
      sliceRevocationHash(
        { businessId: slice.businessId, account, agentId: slice.agentId, subKey, by: agentKey },
        DOMAIN,
      ),
    ).toBe(GOLDEN_REVOCATION)
  })

  it('changes its hash with any field, the price limit and the replaced hash included', () => {
    const base = sliceHash(slice, DOMAIN)
    const changed: Partial<Slice>[] = [
      { sliceId: id('other') },
      { mandateHash: id('other mandate') },
      { parentSliceId: id('parent') },
      { subKey: newKey().address },
      { by: account },
      { capOpenReserves: slice.capOpenReserves - 1n },
      { priceCapPerCommitment: 1n },
      { replaces: id('earlier') },
      { approvalRule: { kind: 'always' } },
    ]
    for (const c of changed) expect(sliceHash({ ...slice, ...c }, DOMAIN)).not.toBe(base)
  })

  it('is well formed as the demo builds it', () => {
    expect(sliceProblem(slice)).toBeNull()
    expect(sliceProblem({ ...slice, by: account })).toBeNull()
  })

  it('refuses one that is malformed', () => {
    const bad: Partial<Slice>[] = [
      { sliceId: zeroHash },
      { mandateHash: zeroHash },
      { replaces: zeroHash },
      { subKey: agentKey },
      { subKey: account },
      { by: newKey().address },
      { suppliers: [], categories: [] },
      { actions: [] },
      { capPerCommitment: 0n },
      { capPerCommitment: slice.capOpenReserves + 1n },
      { priceCapPerCommitment: 0n },
      { paymentLimits: [] },
      { paymentLimits: [{ token: TOKEN.token, amount: 0n, period: 86_400n }] },
      {
        paymentLimits: [
          { token: TOKEN.token, amount: 1n, period: 86_400n },
          { token: TOKEN.token, amount: 2n, period: 3600n },
        ],
      },
    ]
    for (const b of bad)
      expect(sliceProblem({ ...slice, ...b }), JSON.stringify(toWire(b))).toBe('slice.invalid')
  })

  it('reads back from its wire form, and refuses a malformed one as it reads', () => {
    const envelope = (message: Slice) =>
      JSON.parse(
        JSON.stringify(
          toWire({
            type: 'Slice',
            schemaVersion: '1',
            chainId: CHAIN_ID,
            lock: LOCK,
            message,
            signature: `0x${'11'.repeat(65)}`,
          }),
        ),
      )
    const read = parseSlice(envelope(slice), { chainId: CHAIN_ID, lock: LOCK })
    expect(read).toMatchObject({ ok: true, value: { message: slice } })
    expect(parseSlice(envelope({ ...slice, subKey: agentKey }), { chainId: CHAIN_ID })).toEqual({
      ok: false,
      reason: 'slice.invalid',
    })
    expect(parseSlice({ ...envelope(slice), schemaVersion: '2' }, { chainId: CHAIN_ID })).toEqual({
      ok: false,
      reason: 'message.schema_unknown',
    })
  })

  it('reads as a mandate with its own limits and the agent key', () => {
    const read = sliceAsMandate({ ...mandate, priceCapPerCommitment: dollars(900) }, slice)
    expect(read.agentKey).toBe(agentKey)
    expect(read.mandateId).toBe(slice.sliceId)
    expect(read.capPerCommitment).toBe(slice.capPerCommitment)
    expect(read.approvalRule).toEqual(slice.approvalRule)
    expect('priceCapPerCommitment' in read).toBe(false)
    expect('replaces' in read).toBe(false)
  })
})

describe('what a slice may divide', () => {
  const parent: AuthorityLimits = mandate

  it('lets a slice keep or narrow every limit', () => {
    expect(sliceWidensProblem(slice, parent)).toBeNull()
    expect(sliceWidensProblem(parent, parent)).toBeNull()
  })

  it('refuses a slice that widens any limit', () => {
    const wider: Partial<AuthorityLimits>[] = [
      { actions: ['reserve', 'pay'] },
      { suppliers: ['biz_supplier', 'biz_other'] },
      { suppliers: [] },
      { categories: ['storage'] },
      { categories: [] },
      { capPerCommitment: mandate.capPerCommitment + 1n },
      { capOpenReserves: mandate.capOpenReserves + 1n },
      { paymentLimits: [{ token: TOKEN.token, amount: dollars(5001), period: 86_400n }] },
      { paymentLimits: [{ token: TOKEN.token, amount: dollars(1), period: 3600n }] },
      { paymentLimits: [{ token: newKey().address, amount: dollars(1), period: 86_400n }] },
      { approvalRule: { kind: 'never' } },
      { approvalRule: { kind: 'above', amount: dollars(801) } },
      { expiry: mandate.expiry + 1n },
    ]
    for (const w of wider) {
      expect(sliceWidensProblem({ ...slice, ...w }, parent), JSON.stringify(toWire(w))).toBe(
        'slice.widens',
      )
    }
  })

  it("keeps a parent's price limit, and lets a slice set one when the parent has none", () => {
    const priced = { ...parent, priceCapPerCommitment: dollars(400) }
    expect(sliceWidensProblem(slice, priced)).toBe('slice.widens')
    expect(sliceWidensProblem({ ...slice, priceCapPerCommitment: dollars(401) }, priced)).toBe(
      'slice.widens',
    )
    expect(sliceWidensProblem({ ...slice, priceCapPerCommitment: dollars(400) }, priced)).toBeNull()
    expect(sliceWidensProblem({ ...slice, priceCapPerCommitment: dollars(1) }, parent)).toBeNull()
  })

  it('lets a slice name suppliers or categories under a parent that names none, and send more to a person', () => {
    const open = { ...parent, suppliers: [], approvalRule: { kind: 'never' } as const }
    expect(sliceWidensProblem({ ...slice, suppliers: ['biz_any'] }, open)).toBeNull()
    expect(sliceWidensProblem({ ...slice, approvalRule: { kind: 'always' } }, parent)).toBeNull()
    expect(sliceWidensProblem({ ...slice, paymentLimits: [] }, parent)).toBeNull()
  })
})

/**
 * The vectors another implementation checks itself against, in `vectors/slice-v1.json`.
 * `scripts/write-slice-vectors.mjs` wrote them. The file is pinned by its bytes, so a change to how a
 * slice hashes needs new vectors and a new version.
 */
describe('pinned slice vectors', () => {
  const bytes = readFileSync(new URL('../vectors/slice-v1.json', import.meta.url))
  const file = JSON.parse(bytes.toString('utf8')) as {
    domain: { chainId: number; verifyingContract: Hex }
    slices: { name: string; message: unknown; hash: Hex }[]
    revocations: { name: string; message: unknown; hash: Hex }[]
  }

  it('stays byte for byte as version 1 published it', () => {
    expect(keccak256(toHex(bytes))).toBe(
      '0x62936ad07bbef3c56e1883f6771f5fd383d7eca62d89ce3a824206fc23325381',
    )
    expect(file.slices).toHaveLength(4)
  })

  for (const v of file.slices) {
    it(`${v.name}: reads as a well-formed slice and reproduces its hash`, () => {
      const s = sliceJson.parse(v.message)
      expect(sliceProblem(s)).toBeNull()
      expect(sliceHash(s, file.domain)).toBe(v.hash)
    })
  }

  it('links each version to the one before it', () => {
    const [first, narrowed, byAccount] = file.slices.map((v) => sliceJson.parse(v.message))
    expect(narrowed?.replaces).toBe(file.slices[0]?.hash)
    expect(byAccount?.replaces).toBe(file.slices[1]?.hash)
    expect(sliceWidensProblem(narrowed as Slice, first as Slice)).toBeNull()
  })

  for (const v of file.revocations) {
    it(`${v.name}: reproduces its hash`, () => {
      expect(sliceRevocationHash(sliceRevocationJson.parse(v.message), file.domain)).toBe(v.hash)
    })
  }
})

const GOLDEN_SLICE = '0xbf2f097374d685d08cea4f2527cedebdfa67e5d1c1971d1e62f21cfb17988e14'
const GOLDEN_REVOCATION = '0xf4d70dcd4d2f637fd258d91764e7467d6bf32106426a1207adebf6155c64363a'
