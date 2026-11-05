import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newSessionId, toWire, verifyApiRequest } from '@avow-finance/spec'
import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { MODERATO_FACTORY } from '../moderato.js'
import { prepareSandboxBusiness } from '../sandbox/setup.js'
import { fakeChain } from '../test/fake-chain.js'
import {
  config,
  deployment,
  enrolledBusiness,
  LOCK,
  LOCK_BLOCK,
  recordingPrompts,
} from '../test/sandbox-business.js'
import { takeRun } from './platform.js'
import { keepSession, SESSION_MARGIN, sessionForNextRun } from './runner-session.js'

const NOW = BigInt(Math.floor(Date.now() / 1000))
const API = deployment.apiUrl

const json = (body: unknown) =>
  new Response(JSON.stringify(toWire(body)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

interface Kept {
  account: Address
  endsAt: bigint
  runs: number[]
}

/**
 * A stand-in for Avow's relay. Its events route answers for the sessions it holds as the hosted API
 * does, and it records every event posted.
 */
function fakeRelay(sessions: Record<string, Kept>) {
  const posts: { path: string; authorization: string; body: Uint8Array }[] = []
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url))
    const id = /^\/v1\/sandbox\/sessions\/([0-9a-f]{32})\/events$/.exec(u.pathname)?.[1]
    if (!id) throw new Error(`The fake relay doesn't serve ${u.pathname}`)
    if (init.method === 'POST') {
      posts.push({
        path: u.pathname,
        authorization: new Headers(init.headers).get('authorization') ?? '',
        body: init.body as Uint8Array,
      })
      return json({ sequence: posts.length })
    }
    const s = sessions[id]
    const after = Number(u.searchParams.get('after'))
    return json({
      business: s
        ? {
            businessId: 'sandbox-business',
            name: 'Starter Test Co',
            account: s.account,
            lock: LOCK,
          }
        : null,
      events: (s?.runs ?? [])
        .map((run, i) => ({
          sequence: i + 1,
          event: { type: 'run_started', run, source: 'script', tool: null },
        }))
        .filter((e) => e.sequence > after),
      expiresAt: s ? s.endsAt.toString() : null,
    })
  }) as typeof fetch
  return { fetcher, posts }
}

/** A sandbox folder whose business kept a session from an earlier start. */
function folderWithSession(id: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'avow-session-')), '.avow')
  takeRun(dir, id)
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ id, pid: 1 }))
  return dir
}

async function business(authority = 500) {
  const b = await enrolledBusiness(authority)
  const chain = fakeChain({
    factory: MODERATO_FACTORY,
    account: b.root.address,
    lock: LOCK,
    lockBlock: LOCK_BLOCK,
    latest: LOCK_BLOCK + 10n,
    keys: [{ key: b.agentKey, block: LOCK_BLOCK + 5n, witness: b.witness }],
  })
  return { ...b, chain }
}

describe("the runner's session", () => {
  it('stays the same across a restart while the relay takes its events, with nothing asked', async () => {
    const b = await business()
    const id = newSessionId()
    const dir = folderWithSession(id)
    const relay = fakeRelay({
      [id]: { account: b.root.address, endsAt: NOW + 7200n, runs: [1, 2, 5] },
    })
    const session = await keepSession({
      dir,
      apiUrl: API,
      account: b.root.address,
      fetch: relay.fetcher,
      now: () => NOW,
    })
    expect(session).toEqual({ id, fresh: false, endsAt: NOW + 7200n })
    // Runs go on from the last one the relay holds, and the MCP server finds the runner by its pid.
    expect(takeRun(dir, id)).toBe(6)
    expect(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))).toEqual({
      id,
      pid: process.pid,
    })
    const { asked, prompts } = recordingPrompts()
    const prepared = await prepareSandboxBusiness({
      config,
      prompts,
      store: b.store,
      deployment,
      client: b.chain.client,
      fetch: relay.fetcher,
      session: { id: session.id, run: 7 },
      announce: session.fresh,
      log: () => {},
    })
    expect(prepared).toMatchObject({ signed: false, announced: false })
    expect(asked).toEqual([])
    expect(relay.posts).toEqual([])
  })

  it("announces the authority again, signed by the business's key, once the relay closed the session", async () => {
    const b = await business()
    const id = newSessionId()
    const dir = folderWithSession(id)
    const relay = fakeRelay({ [id]: { account: b.root.address, endsAt: NOW - 1n, runs: [3] } })
    const session = await keepSession({
      dir,
      apiUrl: API,
      account: b.root.address,
      fetch: relay.fetcher,
      now: () => NOW,
    })
    expect(session.id).not.toBe(id)
    expect(session.fresh).toBe(true)
    expect(takeRun(dir, session.id)).toBe(1)

    const lines: string[] = []
    const { asked, prompts } = recordingPrompts()
    const prepared = await prepareSandboxBusiness({
      config,
      prompts,
      store: b.store,
      deployment,
      client: b.chain.client,
      fetch: relay.fetcher,
      session: { id: session.id, run: 1 },
      announce: session.fresh,
      log: (line) => lines.push(line),
    })
    expect(prepared).toMatchObject({ signed: false, announced: true })
    // The passphrase is asked once, after the runner says why.
    expect(asked).toEqual(['passphrase'])
    expect(lines.join('\n')).toContain(
      "Your screen has a new session, so your business's key signs your agent's current authority for it.",
    )
    expect(relay.posts).toHaveLength(1)
    const post = relay.posts[0] as (typeof relay.posts)[number]
    expect(post.path).toBe(`/v1/sandbox/sessions/${session.id}/events`)
    expect(JSON.parse(new TextDecoder().decode(post.body))).toEqual({
      event: {
        type: 'authority_changed',
        run: 1,
        source: 'business',
        authority: '500000000',
        previous: null,
        suppliers: ['avow-demo-gpu'],
        mandateHash: b.witness,
      },
    })
    const verified = verifyApiRequest({
      audience: API,
      chainId: deployment.chainId,
      method: 'POST',
      path: post.path,
      body: post.body,
      authorization: post.authorization,
    })
    expect(verified.ok && verified.value.credentials.signer).toBe(b.root.address.toLowerCase())
  })

  it("signs the hash of the mandate the chain holds, whatever hash the agent's file names", async () => {
    // The business lowered the authority from $500 to $100. The agent writes the $500 mandate's
    // hash into its file and deletes the kept session, so the next start announces again.
    const b = await business(100)
    const before = await enrolledBusiness(500)
    const file = JSON.parse((await b.store.read('agent')) as string)
    file.mandateHash = before.witness
    await b.store.write('agent', JSON.stringify(file))
    const dir = join(mkdtempSync(join(tmpdir(), 'avow-session-')), '.avow')
    const relay = fakeRelay({})
    const session = await keepSession({
      dir,
      apiUrl: API,
      account: b.root.address,
      fetch: relay.fetcher,
      now: () => NOW,
    })
    expect(session.fresh).toBe(true)
    const { asked, prompts } = recordingPrompts()
    const prepared = await prepareSandboxBusiness({
      config: { ...config, authority: 100 },
      prompts,
      store: b.store,
      deployment,
      client: b.chain.client,
      fetch: relay.fetcher,
      session: { id: session.id, run: 1 },
      announce: session.fresh,
      log: () => {},
    })
    expect(asked).toEqual(['passphrase'])
    expect(prepared).toMatchObject({ announced: true, authority: 100, mandateHash: b.witness })
    const post = relay.posts[0] as (typeof relay.posts)[number]
    const { event } = JSON.parse(new TextDecoder().decode(post.body))
    expect(event).toMatchObject({ authority: '100000000', mandateHash: b.witness })
    expect(event.mandateHash).not.toBe(before.witness)
  })

  it('never keeps a session another business holds, or one no event reached', async () => {
    const b = await business()
    const other = newSessionId()
    const unseen = newSessionId()
    const relay = fakeRelay({
      [other]: {
        account: '0x000000000000000000000000000000000000dead',
        endsAt: NOW + 7200n,
        runs: [],
      },
    })
    for (const id of [other, unseen]) {
      const session = await keepSession({
        dir: folderWithSession(id),
        apiUrl: API,
        account: b.root.address,
        fetch: relay.fetcher,
        now: () => NOW,
      })
      expect(session.id).not.toBe(id)
      expect(session.fresh).toBe(true)
    }
  })

  it('moves to a new session when the relay is about to close the one it has', async () => {
    const dir = folderWithSession(newSessionId())
    const relay = fakeRelay({})
    const ending = { id: newSessionId(), fresh: false, endsAt: NOW + SESSION_MARGIN - 1n }
    const next = await sessionForNextRun(ending, {
      dir,
      apiUrl: API,
      fetch: relay.fetcher,
      now: () => NOW,
    })
    expect(next.id).not.toBe(ending.id)
    expect(next.fresh).toBe(true)
    const open = { id: newSessionId(), fresh: false, endsAt: NOW + 7200n }
    expect(
      await sessionForNextRun(open, { dir, apiUrl: API, fetch: relay.fetcher, now: () => NOW }),
    ).toEqual(open)
  })
})
