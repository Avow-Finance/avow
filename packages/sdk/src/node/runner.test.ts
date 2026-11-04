import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { newSessionId } from '@avow-finance/spec'
import { afterEach, describe, expect, it } from 'vitest'
import {
  childEnv,
  childrenAlive,
  ensureChildrenGone,
  readBusinessConfig,
  runAgent,
  terminalPrompts,
} from './runner.js'

afterEach(() => {
  delete process.env.AVOW_ANYTHING
})

describe('the runner', () => {
  it("gives a child the runner's environment with every AVOW_ variable taken out", () => {
    process.env.AVOW_ANYTHING = 'secret'
    const session = { id: newSessionId(), run: 2 }
    const env = childEnv(session)
    expect(
      Object.keys(env)
        .filter((k) => k.startsWith('AVOW_'))
        .sort(),
    ).toEqual(['AVOW_SANDBOX_RUN', 'AVOW_SANDBOX_SESSION'])
    expect(env.AVOW_SANDBOX_SESSION).toBe(session.id)
    expect(env.AVOW_SANDBOX_RUN).toBe('2')
    expect(Object.keys(childEnv(null)).some((k) => k.startsWith('AVOW_'))).toBe(false)
  })

  it('runs the agent in its own process, with no input from the terminal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avow-runner-'))
    writeFileSync(
      join(dir, 'agent.mjs'),
      'process.stdout.write(JSON.stringify({ run: process.env.AVOW_SANDBOX_RUN, stdin: process.stdin.isTTY ?? null }))\n',
    )
    const { code, output } = await runAgent(
      'agent.mjs',
      { id: newSessionId(), run: 3 },
      { cwd: dir, capture: true },
    )
    expect(code).toBe(0)
    expect(JSON.parse(output)).toEqual({ run: '3', stdin: null })
  })

  it("reads the business's config from its file's default export, in a process of its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avow-runner-'))
    writeFileSync(
      join(dir, 'business.mjs'),
      "export default { name: 'Starter Test Co', authority: 500, suppliers: [], pid: process.pid }\n",
    )
    const config = (await readBusinessConfig('business.mjs', dir)) as unknown as Record<
      string,
      unknown
    >
    expect(config).toMatchObject({ name: 'Starter Test Co', authority: 500 })
    expect(config.pid).not.toBe(process.pid)
    writeFileSync(join(dir, 'none.mjs'), 'export const x = 1\n')
    await expect(readBusinessConfig('none.mjs', dir)).rejects.toThrow(/default export/)
  })

  it.skipIf(process.platform !== 'linux')(
    'runs the agent in a session of its own, with no terminal to read the passphrase from',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'avow-runner-'))
      writeFileSync(
        join(dir, 'agent.mjs'),
        `import { openSync, readFileSync } from 'node:fs'
const stat = readFileSync('/proc/self/stat', 'utf8')
const [, , , session, tty] = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
let terminal = 'opened'
try { openSync('/dev/tty', 'r') } catch (error) { terminal = error.code }
process.stdout.write(JSON.stringify({ pid: process.pid, session: Number(session), tty: Number(tty), terminal }))
`,
      )
      const { output } = await runAgent('agent.mjs', null, { cwd: dir, capture: true })
      const seen = JSON.parse(output) as {
        pid: number
        session: number
        tty: number
        terminal: string
      }
      expect(seen.session).toBe(seen.pid)
      expect(seen.tty).toBe(0)
      expect(seen.terminal).not.toBe('opened')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'ends everything the agent started once it exits, and waits for that before any passphrase',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'avow-runner-'))
      writeFileSync(
        join(dir, 'agent.mjs'),
        `import { spawn } from 'node:child_process'
const left = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
process.stdout.write(String(left.pid))
setTimeout(() => process.exit(0), 300)
`,
      )
      const running = runAgent('agent.mjs', null, { cwd: dir, capture: true })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(childrenAlive()).toBe(true)
      const { output } = await running
      const leftover = Number(output)
      await ensureChildrenGone()
      expect(childrenAlive()).toBe(false)
      expect(() => process.kill(leftover, 0)).toThrow()
    },
  )

  it('takes a passphrase without showing it, and keeps no line to bring back', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let shown = ''
    output.on('data', (chunk: Buffer) => {
      shown += chunk.toString()
    })
    const prompts = terminalPrompts(input, output, true)
    const asked = prompts.ask('Passphrase: ', true)
    input.write('correct horse battery staple\r')
    expect(await asked).toBe('correct horse battery staple')
    const next = prompts.ask('Sign? ')
    input.write('y\r')
    expect(await next).toBe('y')
    expect(shown).not.toContain('correct horse')
    expect(prompts.history()).toEqual([])
  })
})
