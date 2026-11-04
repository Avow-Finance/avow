import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newSessionId } from '@avow-finance/spec'
import { afterEach, describe, expect, it } from 'vitest'
import { childEnv, readBusinessConfig, runAgent } from './runner.js'

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
})
