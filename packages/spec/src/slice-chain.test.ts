import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { dollars } from './demo.js'
import { digestOf, mandateHash, mandateVersion, type Signed } from './eip712.js'
import { type MandateChain, mandateChainProblem } from './mandate-chain.js'
import {
  MAX_SLICE_DEPTH,
  type Slice,
  type SliceRevocation,
  sliceHash,
  sliceReplacementProblem,
  sliceRevocationTypedData,
  sliceTypedData,
} from './slice.js'
import {
  parseWorkerSlices,
  sliceChainProblem,
  sliceRevocationProblem,
  type WorkerSlices,
} from './slice-chain.js'
import { CHAIN_ID, DOMAIN, demoMandate, demoSlice, id, LOCK, newKey } from './test-helpers.js'
import type { Mandate } from './types.js'
import { toWire } from './wire.js'

const admin = newKey()
const agent = newKey()
const first = demoMandate(admin.address, agent.address)
const mHash = mandateHash(first, DOMAIN)

function mandates(current: Mandate = first, ...earlier: Mandate[]): MandateChain {
  const signed = (m: Mandate) => ({
    type: 'Mandate' as const,
    schemaVersion: mandateVersion(m),
    chainId: CHAIN_ID,
    lock: LOCK,
    message: m,
    signature: `0x${'11'.repeat(65)}` as Hex,
  })
  const read = mandateChainProblem(
    { current: signed(current), earlier: earlier.map(signed) },
    { domain: DOMAIN, agentKey: agent.address, witness: mHash },
  )
  if (!read.ok) throw new Error(read.reason)
  return read.value
}

type Key = ReturnType<typeof newKey>
const keysByAddress = new Map<string, Key>([
  [admin.address.toLowerCase(), admin],
  [agent.address.toLowerCase(), agent],
])
const key = () => {
  const k = newKey()
  keysByAddress.set(k.address.toLowerCase(), k)
  return k
}
const signer = (a: Address) => keysByAddress.get(a.toLowerCase()) as Key

async function sign(s: Slice): Promise<Signed<Slice>> {
  return {
    type: 'Slice',
    schemaVersion: '1',
    chainId: CHAIN_ID,
    lock: LOCK,
    message: s,
    signature: await signer(s.by).sign({ hash: digestOf(sliceTypedData(s, DOMAIN)) }),
  }
}

async function revoke(subKey: Address, by: Address): Promise<Signed<SliceRevocation>> {
  const message: SliceRevocation = {
    businessId: first.businessId,
    account: first.account,
    agentId: first.agentId,
    subKey,
    by,
  }
  return {
    type: 'SliceRevocation',
    schemaVersion: '1',
    chainId: CHAIN_ID,
    lock: LOCK,
    message,
    signature: await signer(by).sign({ hash: digestOf(sliceRevocationTypedData(message, DOMAIN)) }),
  }
}

/** A slice under `parent`, handed out by its worker's key, a little narrower. */
const under = (parent: Slice, subKey: Address): Slice => ({
  ...parent,
  sliceId: id(`slice-${subKey}`),
  parentSliceId: parent.sliceId,
  issuerKey: parent.subKey,
  subKey,
  by: parent.subKey,
  capOpenReserves: parent.capOpenReserves - dollars(1),
})

/** The next version of a slice, signed by `by`. */
const next = (before: Slice, change: Partial<Slice>, by = before.issuerKey): Slice => ({
  ...before,
  ...change,
  by,
  nonce: before.nonce + 1n,
  replaces: sliceHash(before, DOMAIN),
})

const level = async (current: Slice, ...earlier: Slice[]) => ({
  current: await sign(current),
  earlier: await Promise.all(earlier.map(sign)),
})

const worker = key()
const top = demoSlice(first, mHash, worker.address)
const expected = (subKey: Address = worker.address, chain = mandates()) => ({
  domain: DOMAIN,
  mandates: chain,
  subKey,
})

describe("a worker's chain of slices", () => {
  it('links one slice to the mandate it divides, signed by the agent key', async () => {
    const served: WorkerSlices = { levels: [await level(top)], revocations: [] }
    const read = await sliceChainProblem(served, expected())
    expect(read).toMatchObject({
      ok: true,
      value: { levels: [{ slice: top, hash: sliceHash(top, DOMAIN), earlier: [] }] },
    })
  })

  it('links a worker that divides its own slice, down to the depth a slice can sit', async () => {
    const levels: Slice[] = [top]
    while (levels.length < MAX_SLICE_DEPTH) {
      levels.push(under(levels[levels.length - 1] as Slice, key().address))
    }
    const last = levels[levels.length - 1] as Slice
    const served = { levels: await Promise.all(levels.map((s) => level(s))), revocations: [] }
    const read = await sliceChainProblem(served, expected(last.subKey))
    expect(read.ok).toBe(true)

    const deeper = under(last, key().address)
    const tooDeep = { ...served, levels: [...served.levels, await level(deeper)] }
    expect(await sliceChainProblem(tooDeep, expected(deeper.subKey))).toEqual({
      ok: false,
      reason: 'slice.too_deep',
    })
  })

  it('names the worker it expects, and refuses another', async () => {
    const served = { levels: [await level(top)], revocations: [] }
    expect(await sliceChainProblem(served, expected(key().address))).toEqual({
      ok: false,
      reason: 'slice.key_mismatch',
    })
  })

  it("refuses a slice that doesn't link to the agent, its mandate or the level above", async () => {
    const child = under(top, key().address)
    const cases: [Slice[], Address][] = [
      [[{ ...top, issuerKey: admin.address, by: admin.address }], worker.address],
      [[{ ...top, parentSliceId: id('somewhere') }], worker.address],
      [[{ ...top, mandateHash: id('another mandate') }], worker.address],
      [[{ ...top, businessId: 'biz_other' }], worker.address],
      [[top, { ...child, parentSliceId: id('somewhere') }], child.subKey],
      [[top, { ...child, issuerKey: agent.address, by: agent.address }], child.subKey],
      [[top, { ...child, subKey: agent.address }], agent.address],
    ]
    for (const [slices, subKey] of cases) {
      const served = { levels: await Promise.all(slices.map((s) => level(s))), revocations: [] }
      expect(await sliceChainProblem(served, expected(subKey))).toMatchObject({ ok: false })
    }
  })

  it('refuses a first version wider than its parent, and an id held by two levels', async () => {
    const wide = { ...top, capPerCommitment: first.capPerCommitment + 1n }
    expect(
      await sliceChainProblem({ levels: [await level(wide)], revocations: [] }, expected()),
    ).toEqual({
      ok: false,
      reason: 'slice.widens',
    })
    const child = { ...under(top, key().address), capOpenReserves: top.capOpenReserves + 1n }
    expect(
      await sliceChainProblem(
        { levels: [await level(top), await level(child)], revocations: [] },
        expected(child.subKey),
      ),
    ).toEqual({ ok: false, reason: 'slice.widens' })
    const twin = { ...under(top, key().address), sliceId: top.sliceId }
    expect(
      await sliceChainProblem(
        { levels: [await level(top), await level(twin)], revocations: [] },
        expected(twin.subKey),
      ),
    ).toMatchObject({ ok: false })
  })

  it('takes a slice handed out under an earlier mandate in the chain', async () => {
    const replaced = { ...first, capOpenReserves: dollars(1500), nonce: 2n, replaces: mHash }
    const served = { levels: [await level(top)], revocations: [] }
    expect(
      (await sliceChainProblem(served, expected(worker.address, mandates(replaced, first)))).ok,
    ).toBe(true)
  })

  it('refuses a version signed by anyone but its issuer or the account', async () => {
    const forged = {
      ...(await sign(top)),
      signature: await worker.sign({ hash: digestOf(sliceTypedData(top, DOMAIN)) }),
    }
    expect(
      await sliceChainProblem(
        { levels: [{ current: forged, earlier: [] }], revocations: [] },
        expected(),
      ),
    ).toEqual({ ok: false, reason: 'slice.signature_invalid' })
  })

  describe('a slice replaced', () => {
    it('by its issuer, only narrower', async () => {
      const narrower = next(top, { capOpenReserves: dollars(800) })
      const ok = await sliceChainProblem(
        { levels: [await level(narrower, top)], revocations: [] },
        expected(),
      )
      expect(ok).toMatchObject({
        ok: true,
        value: {
          levels: [{ hash: sliceHash(narrower, DOMAIN), earlier: [sliceHash(top, DOMAIN)] }],
        },
      })
      const wider = next(top, { capOpenReserves: dollars(1300) })
      expect(
        await sliceChainProblem({ levels: [await level(wider, top)], revocations: [] }, expected()),
      ).toEqual({ ok: false, reason: 'slice.widens' })
    })

    it('by the account, to anything inside its parent and nothing beyond', async () => {
      const raised = next(top, { capOpenReserves: dollars(1900) }, admin.address)
      expect(
        (
          await sliceChainProblem(
            { levels: [await level(raised, top)], revocations: [] },
            expected(),
          )
        ).ok,
      ).toBe(true)
      const beyond = next(top, { capOpenReserves: dollars(2001) }, admin.address)
      expect(
        await sliceChainProblem(
          { levels: [await level(beyond, top)], revocations: [] },
          expected(),
        ),
      ).toEqual({ ok: false, reason: 'slice.widens' })
    })

    it("keeps a child's account-signed version standing when its parent is narrowed after", async () => {
      // The parent's $1,200 at once is narrowed to $800 after the administrator gave the child $1,000.
      const child = under(top, key().address)
      const raised = next(child, { capOpenReserves: dollars(1000) }, admin.address)
      const narrowed = next(top, { capOpenReserves: dollars(800) })
      const served = {
        levels: [await level(narrowed, top), await level(raised, child)],
        revocations: [],
      }
      expect((await sliceChainProblem(served, expected(child.subKey))).ok).toBe(true)
      // An account-signed version past every version of its parent is still refused.
      const beyond = next(child, { capOpenReserves: dollars(1300) }, admin.address)
      const wide = { ...served, levels: [served.levels[0], await level(beyond, child)] }
      expect(await sliceChainProblem(wide as WorkerSlices, expected(child.subKey))).toEqual({
        ok: false,
        reason: 'slice.widens',
      })
    })

    it('naming the version before it, and none for the first', async () => {
      const unlinked = {
        ...next(top, { capOpenReserves: dollars(800) }),
        replaces: id('elsewhere'),
      }
      expect(
        await sliceChainProblem(
          { levels: [await level(unlinked, top)], revocations: [] },
          expected(),
        ),
      ).toEqual({ ok: false, reason: 'slice.replaces_mismatch' })
      const orphan = { ...top, replaces: id('elsewhere') }
      expect(
        await sliceChainProblem({ levels: [await level(orphan)], revocations: [] }, expected()),
      ).toEqual({ ok: false, reason: 'slice.replaces_mismatch' })
    })

    it('in one line, so a version that skips one is refused', async () => {
      const narrowed = next(top, { capOpenReserves: dollars(800) }, admin.address)
      // The issuer signs over the version before the administrator's, putting the limit back.
      const undone = {
        ...next(top, { capOpenReserves: dollars(1100) }),
        nonce: narrowed.nonce + 1n,
      }
      expect(
        await sliceChainProblem(
          { levels: [await level(undone, top)], revocations: [] },
          expected(),
        ),
      ).toEqual({ ok: false, reason: 'slice.replaces_mismatch' })
      // Avow takes a version only when it replaces the one held as current.
      expect(
        sliceReplacementProblem(
          next(top, { capOpenReserves: dollars(1100) }),
          narrowed,
          first,
          DOMAIN,
        ),
      ).toBe('slice.replaces_mismatch')
      expect(
        sliceReplacementProblem(
          next(narrowed, { capOpenReserves: dollars(700) }, top.issuerKey),
          narrowed,
          first,
          DOMAIN,
        ),
      ).toBeNull()
      expect(
        sliceReplacementProblem(
          next(narrowed, { capOpenReserves: dollars(900) }, top.issuerKey),
          narrowed,
          first,
          DOMAIN,
        ),
      ).toBe('slice.widens')
    })

    it('without changing which worker or parent it is for', async () => {
      const moved = next(top, { subKey: key().address })
      expect(
        await sliceChainProblem(
          { levels: [await level(moved, top)], revocations: [] },
          expected(moved.subKey),
        ),
      ).toEqual({ ok: false, reason: 'slice.chain_mismatch' })
    })
  })

  describe('a revoked worker key', () => {
    const child = under(top, key().address)
    const served = async (revocations: Signed<SliceRevocation>[]) => ({
      levels: [await level(top), await level(child)],
      revocations,
    })

    it('ends its slice and every slice below it, revoked by the account or a key above', async () => {
      for (const r of [
        await revoke(child.subKey, admin.address),
        await revoke(child.subKey, agent.address),
        await revoke(child.subKey, worker.address),
        await revoke(worker.address, agent.address),
      ]) {
        expect(await sliceChainProblem(await served([r]), expected(child.subKey))).toEqual({
          ok: false,
          reason: 'slice.revoked',
        })
      }
    })

    it('passes over a revocation from the worker itself, a key below, a sibling or a forger', async () => {
      const sibling = under(top, key().address)
      const forged = {
        ...(await revoke(child.subKey, agent.address)),
        signature: (await revoke(child.subKey, admin.address)).signature,
      }
      for (const r of [
        await revoke(child.subKey, child.subKey),
        await revoke(worker.address, child.subKey),
        await revoke(child.subKey, sibling.subKey),
        forged,
      ]) {
        expect((await sliceChainProblem(await served([r]), expected(child.subKey))).ok).toBe(true)
        expect(
          await sliceRevocationProblem(r, {
            domain: DOMAIN,
            mandate: first,
            above: [agent.address, worker.address],
          }),
        ).toBe('slice.signature_invalid')
      }
    })

    it("leaves a sibling's chain standing when one worker is revoked", async () => {
      const sibling = under(top, key().address)
      const revoked = await revoke(child.subKey, worker.address)
      const siblingChain = {
        levels: [await level(top), await level(sibling)],
        revocations: [revoked],
      }
      expect((await sliceChainProblem(siblingChain, expected(sibling.subKey))).ok).toBe(true)
      expect(await sliceChainProblem(await served([revoked]), expected(child.subKey))).toEqual({
        ok: false,
        reason: 'slice.revoked',
      })
    })

    it("passes over a revocation of a key that isn't on the way", async () => {
      const elsewhere = await revoke(key().address, agent.address)
      expect((await sliceChainProblem(await served([elsewhere]), expected(child.subKey))).ok).toBe(
        true,
      )
    })
  })

  it('reads from its wire form, levels and revocations each checked', async () => {
    const wire = JSON.parse(
      JSON.stringify(
        toWire({
          levels: [await level(top)],
          revocations: [await revoke(key().address, agent.address)],
        }),
      ),
    )
    const read = parseWorkerSlices(wire, { chainId: CHAIN_ID, lock: LOCK })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect((await sliceChainProblem(read.value, expected())).ok).toBe(true)
    expect(parseWorkerSlices({ ...wire, levels: [] }, { chainId: CHAIN_ID, lock: LOCK })).toEqual({
      ok: false,
      reason: 'message.invalid',
    })
  })
})
