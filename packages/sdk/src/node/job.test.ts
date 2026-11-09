import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DECISIVE_SENTENCE } from '@avow-finance/spec'
import { lookOf, Rail } from '@avow-finance/terminal'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryStore } from '../sandbox/store.js'
import { fixtureWorld } from '../session/fixture-world.js'
import { deployment } from '../test/sandbox-business.js'
import { readJobFlags, runJobSession } from './job.js'
import { terminalInput } from './session-input.js'

const ENTRY = pathToFileURL(resolve(import.meta.dirname, '../../dist/service-entry.js')).href
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function serviceFolder(bookCompute: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'avow-job-test-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'service.mjs'),
    `import { defineService, dontStart, start } from '${ENTRY}'
export default defineService({
  computeBudgetPerGpuHour: 3,
  bookCompute: ${bookCompute},
  async checkBeforeWork(job, avow) {
    const check = await avow.verifyCommitment(job)
    return check.ok ? start(check) : dontStart(check)
  },
})
`,
  )
  return dir
}

/** One job in the terminal, scripted, against the fixture world, drawn into a string. */
async function oneJob(bookCompute = true) {
  let drawn = ''
  const write = (text: string) => {
    drawn += text
  }
  const look = lookOf({ isTTY: false, columns: 100 }, { NO_COLOR: '1' })
  let run = 0
  const code = await runJobSession({
    mode: 'one',
    flags: { provider: null, model: null, scripted: true, details: true },
    rail: new Rail(look, write),
    look,
    store: memoryStore(),
    deployment,
    dir: '',
    session: { id: '0'.repeat(32) },
    nextRun: () => ++run,
    prompts: { passphrase: async () => 'unused', confirm: async () => false },
    input: null,
    world: fixtureWorld(),
    write,
    service: { file: 'service.mjs', cwd: serviceFolder(bookCompute) },
  })
  return { code, drawn }
}

describe('a first run', () => {
  it('shows the job as two commitments with nothing prepaid, then breaks the chain between them', async () => {
    let drawn = ''
    const write = (text: string) => {
      drawn += text
    }
    const look = lookOf({ isTTY: false, columns: 100 }, { NO_COLOR: '1' })
    const typed = ['job']
    let run = 0
    const code = await runJobSession({
      mode: 'interactive',
      firstRun: true,
      flags: { provider: null, model: null, scripted: true, details: false },
      rail: new Rail(look, write),
      look,
      store: memoryStore(),
      deployment,
      dir: '',
      session: { id: '0'.repeat(32) },
      nextRun: () => ++run,
      prompts: { passphrase: async () => 'unused', confirm: async () => false },
      input: { inFlight: () => {}, next: async () => typed.shift() ?? null },
      world: fixtureWorld(),
      write,
      service: { file: 'service.mjs', cwd: serviceFolder(true) },
    })
    expect(code).toBe(0)
    const at = (text: string) => drawn.indexOf(text)
    const inOrder = (...texts: string[]) => {
      for (const [i, text] of texts.entries()) {
        expect(at(text), text).toBeGreaterThan(i === 0 ? -1 : at(texts[i - 1] as string))
      }
    }
    // Step 3 draws the compute booking's card, then the job's, then says nothing was prepaid.
    inOrder(
      '3/4  Two commitments, nothing prepaid',
      'COMPUTE  Your business → avow-demo-gpu  ● accepted in the fixture world',
      "JOB  Avow's test customer → your business  ● accepted in the fixture world",
      'Pay $40 on delivery, with nothing prepaid, for fine-tuning due by',
      "$10 reserved in the customer's lock, for your business",
      'Your compute commitment, which the customer says it checked at block',
      DECISIVE_SENTENCE.split(' and ')[0] as string,
      '✓  3/4  Delivered, and paid $40 on delivery with nothing prepaid. The $10 and $40 set aside never',
    )
    // Step 4 takes one more order with the compute booking held off, and the customer refuses it.
    inOrder(
      '4/4  Break the chain',
      'For this order your agent books no compute',
      'Your code quoted the job without naming any compute booking.',
      'The customer refused your quote.',
      '✓  4/4  The customer refused. Its commitment depends on your compute commitment',
      "You're set up.",
    )
    // The switch in service.ts never changed, so nothing says it did.
    expect(drawn).not.toContain('service.ts changed')
    // A brief view leaves the tool calls and the receipts to the details and the screen.
    expect(drawn).not.toContain('↳ read_order')
    expect(drawn).not.toContain('In the fixture world at block')
    expect(drawn).not.toContain('#verify=')
    expect(drawn).not.toContain('Type job to take the next order')
    // A first job and a second order, each checked by service.ts in a child process of its own.
  }, 30_000)
})

describe('npm run job', () => {
  it('reads its flags from the command line, over the environment', () => {
    expect(
      readJobFlags(['--provider', 'anthropic', '--model=claude-sonnet-5-5'], {
        AVOW_MODEL_PROVIDER: 'local',
      }),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      scripted: false,
      details: false,
    })
    expect(readJobFlags([], { AVOW_MODEL_PROVIDER: 'local', AVOW_MODEL: 'qwen3:8b' })).toEqual({
      provider: 'local',
      model: 'qwen3:8b',
      scripted: false,
      details: false,
    })
    expect(readJobFlags(['--scripted'], {})).toMatchObject({ scripted: true })
    expect(readJobFlags(['--details'], {})).toMatchObject({ details: true })
    expect(readJobFlags(['--provider'], {})).toEqual({ error: '--provider needs a value' })
    expect(readJobFlags(['--fast'], {})).toEqual({ error: "There's no option --fast here." })
  })

  it('draws the model and who pays, then the job to its payment, labelled as the fixture world', async () => {
    const { code, drawn } = await oneJob()
    expect(code).toBe(0)
    expect(drawn).toContain('scripted decisions, the same every run, with no model and no charge')
    expect(drawn).toContain('The fixture world, in memory, for tests and the eval.')
    expect(drawn).toContain('In the fixture world at block')
    expect(drawn).not.toMatch(/^.*At block \d+/m)
    expect(drawn.replace(/[▌│]/g, '').replace(/\s+/g, ' ')).toContain(DECISIVE_SENTENCE)
    expect(drawn).toContain('The GPUs and the training are simulated.')
    expect(drawn).toContain('The job is done and paid.')
  })

  it('ends with the customer’s refusal when the compute switch is off', async () => {
    const { code, drawn } = await oneJob(false)
    expect(code).toBe(1)
    expect(drawn).toContain(
      'The customer refused the quote with dependency.required, so no work started.',
    )
  })
})

describe('typing to the agent', () => {
  it('queues a line typed while busy, and says typing can’t undo what’s in flight', async () => {
    let typed: (line: string) => void = () => {}
    const quiet: string[] = []
    const input = terminalInput(
      { ask: () => new Promise(() => {}), onLine: (listener) => (typed = listener) },
      { quiet: (line: string) => quiet.push(line), settle: () => {}, you: 'you › ' },
    )
    input.inFlight('the compute booking being sent')
    typed('why that offer?')
    input.inFlight(null)
    expect(quiet).toEqual([
      "Typing can't undo the compute booking being sent. What you typed applies once it's done.",
    ])
    expect(await input.next()).toBe('why that offer?')
  })
})
