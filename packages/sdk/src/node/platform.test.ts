import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newSessionId } from '@avow-finance/spec'
import { afterEach, describe, expect, it } from 'vitest'
import { inTurn } from '../sandbox/store.js'
import { fileStore, latestRun, nodePlatform, RUNNER_ENV, takeRun } from './platform.js'

describe('takeRun', () => {
  it('gives each run in a session its own number, whichever process takes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avow-runs-'))
    const session = newSessionId()
    expect(latestRun(dir, session)).toBe(0)
    expect([takeRun(dir, session), takeRun(dir, session)]).toEqual([1, 2])
    // Another process, such as the MCP server, takes run 3.
    writeFileSync(join(dir, 'runs', session, '3'), '', { flag: 'wx' })
    expect(takeRun(dir, session)).toBe(4)
    expect(latestRun(dir, session)).toBe(4)
    expect(takeRun(dir, newSessionId())).toBe(1)
    expect(() => takeRun(dir, '../elsewhere')).toThrow(RangeError)
  })
})

afterEach(() => {
  for (const name of Object.values(RUNNER_ENV)) delete process.env[name]
})

describe('fileStore', () => {
  it('takes the changes of two stores over the same folder in one turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avow-turn-'))
    // Two calls of fileStore, as sandboxServices and sandboxMailbox each make in one process.
    const a = fileStore(dir)
    const b = fileStore(join(dir, '.', ''))
    expect(a).not.toBe(b)
    const said: string[] = []
    let release = () => {}
    const first = inTurn(a, async () => {
      said.push('first starts')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      said.push('first ends')
    })
    const second = inTurn(b, async () => {
      said.push('second')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(said).toEqual(['first starts'])
    release()
    await Promise.all([first, second])
    expect(said).toEqual(['first starts', 'first ends', 'second'])
  })

  it('doesn’t hold a store over another folder back', async () => {
    const a = fileStore(mkdtempSync(join(tmpdir(), 'avow-turn-')))
    const b = fileStore(mkdtempSync(join(tmpdir(), 'avow-turn-')))
    let release = () => {}
    const first = inTurn(a, () => new Promise<void>((resolve) => (release = resolve)))
    await expect(inTurn(b, async () => 'done')).resolves.toBe('done')
    release()
    await first
  })

  it('keeps each item in a file only its owner reads, in a folder git ignores', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'avow-store-')), '.avow')
    const store = fileStore(dir)
    expect(await store.read('business')).toBeNull()
    await store.write('business', '{"a":1}')
    await store.write('business', '{"a":2}')
    expect(await store.read('business')).toBe('{"a":2}')
    expect(statSync(join(dir, 'business.json')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toMatch(/^\*$/m)
  })
})

describe('nodePlatform', () => {
  it('reports to the session the runner passes, and to none otherwise', () => {
    expect(nodePlatform.session?.()).toBeNull()
    const id = newSessionId()
    process.env[RUNNER_ENV.session] = id
    process.env[RUNNER_ENV.run] = '3'
    expect(nodePlatform.session?.()).toEqual({ id, run: 3 })
    process.env[RUNNER_ENV.run] = '0'
    expect(nodePlatform.session?.()).toBeNull()
    process.env[RUNNER_ENV.session] = 'not-a-session'
    process.env[RUNNER_ENV.run] = '1'
    expect(nodePlatform.session?.()).toBeNull()
  })
})
