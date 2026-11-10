import type { Address } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { MODERATO_FACTORY } from '../moderato.js'
import { fakeChain } from '../test/fake-chain.js'
import {
  config,
  deployment,
  enrolledBusiness,
  LOCK,
  LOCK_BLOCK,
  recordingPrompts,
} from '../test/sandbox-business.js'
import { Refusal } from './agent.js'
import { liveKeys, lockCreatedIn } from './keys.js'
import { limitTry, prepareSandboxBusiness } from './setup.js'

describe("the business's side, when the agent writes to .avow", () => {
  it('stands on a mandate the chain holds, and asks nothing', async () => {
    const b = await enrolledBusiness()
    const chain = fakeChain({
      factory: MODERATO_FACTORY,
      account: b.root.address,
      lock: LOCK,
      lockBlock: LOCK_BLOCK,
      latest: LOCK_BLOCK + 10n,
      keys: [{ key: b.agentKey, block: LOCK_BLOCK + 5n, witness: b.witness }],
    })
    const { asked, prompts } = recordingPrompts()
    const prepared = await prepareSandboxBusiness({
      config,
      prompts,
      store: b.store,
      deployment,
      client: chain.client,
      session: null,
      log: () => {},
    })
    expect(prepared).toMatchObject({ signed: false, authority: 500, lock: LOCK })
    expect(asked).toEqual([])
    expect(chain.writes).toEqual([])
  })

  it("won't set the business up again from an edited record without a yes that says what it replaces", async () => {
    const b = await enrolledBusiness()
    // The agent points the business's record at another lock, as if setup had never finished.
    const edited = JSON.parse((await b.store.read('business')) as string)
    edited.business.lock = '0x000000000000000000000000000000000000beef'
    await b.store.write('business', JSON.stringify(edited))
    const before = await b.store.read('business')
    const chain = fakeChain({
      factory: MODERATO_FACTORY,
      account: b.root.address,
      lock: LOCK,
      lockBlock: LOCK_BLOCK,
      latest: LOCK_BLOCK + 10n,
      keys: [{ key: b.agentKey, block: LOCK_BLOCK + 5n, witness: b.witness }],
    })
    const { asked, prompts } = recordingPrompts(false)
    await expect(
      prepareSandboxBusiness({
        config,
        prompts,
        store: b.store,
        deployment,
        client: chain.client,
        session: null,
        log: () => {},
      }),
    ).rejects.toThrow('Nothing changed')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain(`Your business's lock is on chain at ${LOCK}`)
    expect(asked[0]).toContain('replaces the record in .avow/business.json')
    expect(asked[0]).toContain('revokes every other key on the account')
    // Declined, it never asked for the passphrase, sent nothing and wrote nothing.
    expect(chain.writes).toEqual([])
    expect(await b.store.read('business')).toBe(before)
  })

  it("asks for a new mandate when the agent's file names a key the chain revoked", async () => {
    const b = await enrolledBusiness()
    // The file's mandate matches business.ts exactly, but the chain revoked its key, as it does
    // to every key a newer mandate replaced. An older mandate put back reads the same way.
    const chain = fakeChain({
      factory: MODERATO_FACTORY,
      account: b.root.address,
      lock: LOCK,
      lockBlock: LOCK_BLOCK,
      latest: LOCK_BLOCK + 10n,
      keys: [{ key: b.agentKey, block: LOCK_BLOCK + 5n, witness: b.witness, revoked: true }],
    })
    const lines: string[] = []
    const { asked, prompts } = recordingPrompts(false)
    await expect(
      prepareSandboxBusiness({
        config,
        prompts,
        store: b.store,
        deployment,
        client: chain.client,
        session: null,
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow('No mandate was signed')
    expect(lines.join('\n')).toContain("doesn't name a key the chain shows live under its mandate")
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(
      /^Sign a new mandate as Starter Test Co\? \$500 held at once, .* It revokes every other key/,
    )
    expect(chain.writes).toEqual([])
  })

  it("asks for a new mandate when the agent's file names a mandate its key wasn't authorized for", async () => {
    const b = await enrolledBusiness()
    const chain = fakeChain({
      factory: MODERATO_FACTORY,
      account: b.root.address,
      lock: LOCK,
      lockBlock: LOCK_BLOCK,
      latest: LOCK_BLOCK + 10n,
      keys: [{ key: b.agentKey, block: LOCK_BLOCK + 5n, witness: `0x${'cd'.repeat(32)}` }],
    })
    const { asked, prompts } = recordingPrompts(false)
    await expect(
      prepareSandboxBusiness({
        config,
        prompts,
        store: b.store,
        deployment,
        client: chain.client,
        session: null,
        log: () => {},
      }),
    ).rejects.toThrow('No mandate was signed')
    expect(asked[0]).toMatch(/^Sign a new mandate/)
  })
})

describe('the business as a supplier of jobs', () => {
  /** A business whose mandate the chain holds, so setup asks nothing of its own. */
  async function standing() {
    const b = await enrolledBusiness()
    const chain = fakeChain({
      factory: MODERATO_FACTORY,
      account: b.root.address,
      lock: LOCK,
      lockBlock: LOCK_BLOCK,
      latest: LOCK_BLOCK + 10n,
      keys: [{ key: b.agentKey, block: LOCK_BLOCK + 5n, witness: b.witness }],
    })
    const held = JSON.parse((await b.store.read('supplier')) as string)
    // A profile reads addresses in lower case.
    return { b, chain, signingKey: (held.profile.signingKey as string).toLowerCase() as Address }
  }

  it('is left alone unless the job chapter asks for it', async () => {
    const { b, chain } = await standing()
    const prepared = await prepareSandboxBusiness({
      config,
      prompts: recordingPrompts().prompts,
      store: b.store,
      deployment,
      client: chain.client,
      session: null,
      log: () => {},
    })
    expect(prepared.supplier).toBeNull()
    expect(chain.feeReads).toEqual([])
  })

  it('names the signing key it holds, and checks that key still has its fees', async () => {
    const { b, chain, signingKey } = await standing()
    const prepared = await prepareSandboxBusiness({
      config,
      prompts: recordingPrompts().prompts,
      store: b.store,
      deployment,
      client: chain.client,
      session: null,
      supplier: true,
      log: () => {},
    })
    expect(prepared.supplier).toEqual({ ok: true, signingKey })
    expect(chain.feeReads.map((a) => a.toLowerCase())).toEqual([signingKey])
  })

  it('finishes setting up the business when Avow refuses the registration, and says why', async () => {
    const { b, chain } = await standing()
    // The supplier's file is gone, and Avow holds another signing key for the account.
    await b.store.write('supplier', '{}')
    const refusing = (async () =>
      new Response(
        JSON.stringify({ error: { reason: 'sandbox.taken', message: 'That account is taken' } }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    const prepared = await prepareSandboxBusiness({
      config,
      prompts: recordingPrompts().prompts,
      store: b.store,
      deployment,
      client: chain.client,
      session: null,
      supplier: true,
      log: () => {},
      fetch: refusing,
    })
    expect(prepared).toMatchObject({ lock: LOCK, authority: 500, signed: false })
    expect(prepared.supplier).toEqual({
      ok: false,
      why: expect.stringContaining(
        "Avow already holds another signing key for your business as a supplier, and .avow/supplier.json doesn't hold that key",
      ),
    })
    expect(await b.store.read('supplier')).toBe('{}')
    expect(chain.writes).toEqual([])
  })
})

describe('the keys the runner revokes', () => {
  it('start where the factory created the lock, read back from the latest block', async () => {
    const account = Account.fromSecp256k1(generatePrivateKey()).address
    const latest = LOCK_BLOCK + 200_000n
    const chain = fakeChain({
      factory: MODERATO_FACTORY,
      account,
      lock: LOCK,
      lockBlock: LOCK_BLOCK,
      latest,
    })
    expect(
      await lockCreatedIn({ client: chain.client, factory: MODERATO_FACTORY, account, lock: LOCK }),
    ).toBe(LOCK_BLOCK)
    expect(chain.ranges[0]?.[1]).toBe(latest)
    // A lock the factory never made for the account has no start, so nothing is revoked from a guess.
    await expect(
      lockCreatedIn({
        client: chain.client,
        factory: MODERATO_FACTORY,
        account,
        lock: '0x000000000000000000000000000000000000beef',
      }),
    ).rejects.toThrow('never created')
  })

  it('include every admin key and access key still live, and never the root', async () => {
    const account = Account.fromSecp256k1(generatePrivateKey()).address
    const key = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
    const chain = fakeChain({
      factory: MODERATO_FACTORY,
      account,
      lock: LOCK,
      lockBlock: LOCK_BLOCK,
      latest: LOCK_BLOCK + 100n,
      keys: [
        { key: key(1), block: LOCK_BLOCK + 1n },
        { key: key(2), block: LOCK_BLOCK + 2n, revoked: true },
        { key: key(3), block: LOCK_BLOCK + 3n, admin: true },
        { key: account, block: LOCK_BLOCK + 4n },
      ],
    })
    expect(await liveKeys(chain.client, account, LOCK_BLOCK)).toEqual([key(1), key(3)])
  })
})

describe("a first setup's try past the limit", () => {
  const authority = 500_000_000n
  const amounts = {
    needed: 501_000_000n,
    left: authority,
    authority,
    capPerCommitment: authority,
    dailyLimit: null,
    dailyLeft: null,
  }

  it('asks for a dollar more than the agent may hold, and says who refused it', async () => {
    const asked: number[] = []
    const said = await limitTry(authority, async (reserve) => {
      asked.push(reserve)
      throw new Refusal({ code: 'mandate.over_commitment_cap', layer: 'avow', amounts })
    })
    expect(asked).toEqual([501])
    expect(said).toBe('It asked to hold $501, and Avow refused, so no money moved.')
  })

  it("says nothing when the try couldn't run, and says so loudly if nothing refused it", async () => {
    expect(
      await limitTry(authority, async () => {
        throw new Error('the supplier never answered')
      }),
    ).toBeNull()
    expect(await limitTry(authority, async () => {})).toContain('which should never happen')
  })
})
