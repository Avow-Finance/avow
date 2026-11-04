import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newSessionId } from '@avow-finance/spec'
import { afterEach, describe, expect, it } from 'vitest'
import { fileStore, nodePlatform, RUNNER_ENV } from './platform.js'

afterEach(() => {
  for (const name of Object.values(RUNNER_ENV)) delete process.env[name]
})

describe('fileStore', () => {
  it('keeps each item in a file only its owner reads, in a folder git ignores', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'avow-store-')), '.avow')
    const store = fileStore(dir)
    expect(await store.read('keys')).toBeNull()
    await store.write('keys', '{"a":1}')
    await store.write('keys', '{"a":2}')
    expect(await store.read('keys')).toBe('{"a":2}')
    expect(statSync(join(dir, 'keys.json')).mode & 0o777).toBe(0o600)
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
