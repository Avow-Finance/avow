import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The runner as npm starts it, from the build.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'node', 'cli.js')

/** An agent file that prints what the runner told it. */
const AGENT = `const e = process.env
console.log('agent ran: prepare=' + (e.AVOW_SANDBOX_PREPARE ?? '') + ' session=' + (e.AVOW_SANDBOX_SESSION ?? '') + ' run=' + (e.AVOW_SANDBOX_RUN ?? ''))
`

describe('avow-sandbox', () => {
  it('sets up once, opens a session, and runs the agent at each press of Enter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avow-runner-'))
    writeFileSync(join(dir, 'agent.mjs'), AGENT)
    const child = spawn(process.execPath, [CLI, 'agent.mjs'], {
      cwd: dir,
      env: { ...process.env, AVOW_SANDBOX_NO_OPEN: '1', AVOW_SANDBOX_SESSION: 'stale' },
    })
    let out = ''
    const prompts = () => out.split('Press Enter').length - 1
    const waitFor = (n: number) =>
      new Promise<void>((resolve) => {
        const check = () => (prompts() >= n ? resolve() : setTimeout(check, 20))
        check()
      })
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    await waitFor(1)
    child.stdin.write('\n')
    await waitFor(2)
    child.stdin.write('\n')
    await waitFor(3)
    child.stdin.end()
    expect(await exited).toBe(0)

    const session = /#session=([0-9a-f]{32})/.exec(out)?.[1]
    expect(session).toBeDefined()
    expect(out).toContain('agent ran: prepare=1 session= run=')
    expect(out).toContain(`agent ran: prepare= session=${session} run=1`)
    expect(out).toContain(`agent ran: prepare= session=${session} run=2`)
    expect(out).toContain(`https://try.testnet.avow.finance/#session=${session}`)
  }, 30_000)

  it('stops when there is no agent file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avow-runner-'))
    const child = spawn(process.execPath, [CLI, 'agent.ts'], { cwd: dir })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    expect(await new Promise((resolve) => child.on('exit', resolve))).toBe(1)
    expect(err).toContain("There's no agent.ts")
  })
})
