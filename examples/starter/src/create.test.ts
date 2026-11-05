import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  businessFile,
  createAgentFolder,
  DEFAULT_NAME,
  packageName,
  parseArgs,
  TEMPLATE_DIR,
} from './create.js'

const temporary = () => mkdtempSync(join(tmpdir(), 'avow-create-'))

describe('create-avow-agent', () => {
  it('makes a folder holding agent.ts and a README, with keys kept out of git', () => {
    const target = createAgentFolder(join(temporary(), 'My Agent'))
    const read = (f: string) => readFileSync(join(target, f), 'utf8')
    expect(read('agent.ts')).toBe(readFileSync(join(TEMPLATE_DIR, 'agent.ts'), 'utf8'))
    expect(read('README.md')).toContain('npm start')
    expect(read('business.ts')).toBe(readFileSync(join(TEMPLATE_DIR, 'business.ts'), 'utf8'))
    expect(read('agent.ts')).toContain("from '@avow-finance/sdk/agent'")
    expect(read('.gitignore')).toMatch(/^\.avow\/$/m)
    expect(read('.gitignore')).toMatch(/^\.avow-\*\/$/m)
    const manifest = JSON.parse(read('package.json'))
    expect(manifest.name).toBe('my-agent')
    expect(manifest.scripts).toEqual({
      start: 'avow-sandbox start',
      fresh: 'avow-sandbox fresh',
      'mcp:claude-code': 'avow-sandbox-mcp add claude-code',
      'mcp:claude-desktop': 'avow-sandbox-mcp add claude-desktop',
    })
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

  it("writes the business's name into business.ts as a string the file can hold", () => {
    const target = createAgentFolder(
      join(temporary(), 'named'),
      TEMPLATE_DIR,
      "  Shaun's \\ Agents ",
    )
    const business = readFileSync(join(target, 'business.ts'), 'utf8')
    expect(business).toContain("  name: 'Shaun\\'s \\\\ Agents',")
    expect(business).not.toContain(DEFAULT_NAME)
    // Only the name changes.
    const template = readFileSync(join(TEMPLATE_DIR, 'business.ts'), 'utf8')
    expect(business.replace("  name: 'Shaun\\'s \\\\ Agents',", `  name: '${DEFAULT_NAME}',`)).toBe(
      template,
    )
  })

  it('refuses an empty name or one with a control character, before it makes the folder', () => {
    expect(() => businessFile(TEMPLATE_DIR, '   ')).toThrow(/can't be empty/)
    expect(() => businessFile(TEMPLATE_DIR, 'two\nlines')).toThrow(/control character/)
    const target = join(temporary(), 'never')
    expect(() => createAgentFolder(target, TEMPLATE_DIR, '\u0007')).toThrow()
    expect(() => readFileSync(join(target, 'business.ts'))).toThrow()
  })

  it('takes the folder, the name and what to skip from the command line', () => {
    expect(parseArgs([])).toEqual({ folder: 'my-agent', name: null, install: true, start: true })
    expect(parseArgs(['acme', '--name', 'Acme Co'])).toMatchObject({
      folder: 'acme',
      name: 'Acme Co',
    })
    expect(parseArgs(['--name=Acme Co', 'acme'])).toMatchObject({ folder: 'acme', name: 'Acme Co' })
    expect(parseArgs(['acme', '--no-start'])).toMatchObject({ install: true, start: false })
    // Setup needs the packages, so skipping the install skips setup too.
    expect(parseArgs(['acme', '--no-install'])).toMatchObject({ install: false, start: false })
  })
})
