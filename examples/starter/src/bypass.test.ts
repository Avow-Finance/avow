import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAgent } from '../template/bypass.js'
import { TEMPLATE_DIR } from './create.js'

const manifest = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }

describe('npm run bypass', () => {
  it('reads the agent key and the business from the item npm start stores', () => {
    const account = `0x${'a1'.repeat(20)}`
    const token = `0x${'b2'.repeat(20)}`
    const lock = `0x${'c3'.repeat(20)}`
    const key = `0x${'d4'.repeat(32)}`
    const item = {
      agentKey: key,
      business: { account, token, lock, businessId: 'biz' },
      suppliers: [],
    }
    expect(readAgent(JSON.stringify(item))).toEqual({ key, account, token, lock })
  })

  it('says to run npm start when there is no agent yet, or the item holds no key', () => {
    expect(() => readAgent(null)).toThrow('Run npm start first.')
    expect(() => readAgent(JSON.stringify({ business: {} }))).toThrow('Run npm start again.')
    expect(() => readAgent(JSON.stringify({ agentKey: '0x12', business: {} }))).toThrow(
      'Run npm start again.',
    )
  })

  it('installs the viem the SDK was built on, so the folder holds one copy of it', () => {
    const template = manifest(join(TEMPLATE_DIR, 'package.json'))
    const sdk = manifest(join(TEMPLATE_DIR, '..', '..', '..', 'packages', 'sdk', 'package.json'))
    expect(template.dependencies.viem).toBe(sdk.dependencies.viem)
  })
})
