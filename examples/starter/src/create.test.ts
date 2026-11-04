import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentFolder, packageName, TEMPLATE_DIR } from './create.js'

const temporary = () => mkdtempSync(join(tmpdir(), 'avow-create-'))

describe('create-avow-agent', () => {
  it('makes a folder holding agent.ts and a README, with keys kept out of git', () => {
    const target = createAgentFolder(join(temporary(), 'My Agent'))
    const read = (f: string) => readFileSync(join(target, f), 'utf8')
    expect(read('agent.ts')).toBe(readFileSync(join(TEMPLATE_DIR, 'agent.ts'), 'utf8'))
    expect(read('README.md')).toContain('npm start')
    expect(read('.gitignore')).toMatch(/^\.avow\/$/m)
    const manifest = JSON.parse(read('package.json'))
    expect(manifest.name).toBe('my-agent')
    expect(manifest.scripts.start).toBe('avow-sandbox agent.ts')
    expect(manifest.dependencies['@avow-finance/sdk']).toBe(
      'https://try.testnet.avow.finance/avow-finance-sdk.tgz',
    )
  })

  it("won't write into a folder that holds anything", () => {
    const target = join(temporary(), 'busy')
    mkdirSync(target)
    writeFileSync(join(target, 'notes.txt'), 'mine')
    expect(() => createAgentFolder(target)).toThrow(/isn't empty/)
    expect(readFileSync(join(target, 'notes.txt'), 'utf8')).toBe('mine')
  })

  it('names the package after the folder, as npm takes a name', () => {
    expect(packageName('My Agent!')).toBe('my-agent-')
    expect(packageName('/tmp/agents/.hidden')).toBe('hidden')
    expect(packageName('___')).toBe('my-agent')
  })
})
