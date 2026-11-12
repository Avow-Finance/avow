import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createAgentFolder, TEMPLATE_FILES } from './create.js'
import { createTarball, sdkTarball, type TarEntry, tarball } from './pack.js'

const STARTER = join(dirname(fileURLToPath(import.meta.url)), '..')
/** The terminal package's own version, which the command depends on exactly. */
const TERMINAL_VERSION = (
  JSON.parse(
    readFileSync(join(STARTER, '..', '..', 'packages', 'terminal', 'package.json'), 'utf8'),
  ) as {
    version: string
  }
).version

/** Reads back a gzipped ustar tarball's files, as npm's extractor sees them. */
function untar(gz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gz)
  const files = new Map<string, Buffer>()
  for (let at = 0; at + 512 <= tar.length; ) {
    const block = tar.subarray(at, at + 512)
    if (block.every((b) => b === 0)) break
    const text = (start: number, length: number) =>
      block
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const size = Number.parseInt(text(124, 12), 8)
    const prefix = text(345, 155)
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (block[i] as number)
    expect(Number.parseInt(text(148, 8), 8)).toBe(sum)
    files.set(name, tar.subarray(at + 512, at + 512 + size))
    at += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

const manifest = (files: Map<string, Buffer>, path: string) =>
  JSON.parse((files.get(path) as Buffer).toString('utf8'))

describe('tarball', () => {
  it('writes every file under package/, long paths included, the same way each time', () => {
    const long = `${'a'.repeat(90)}/${'b'.repeat(90)}.js`
    const entries: TarEntry[] = [
      { path: 'package.json', data: Buffer.from('{}') },
      { path: long, data: Buffer.alloc(1300, 7) },
    ]
    const files = untar(tarball(entries))
    expect(files.get('package/package.json')?.toString()).toBe('{}')
    expect(files.get(`package/${long}`)).toEqual(Buffer.alloc(1300, 7))
    expect(tarball(entries)).toEqual(tarball([...entries].reverse()))
  })
})

describe('the host tarballs', () => {
  it('packs the command with the template, depending on the SDK at the host', () => {
    const files = untar(createTarball('http://localhost:8080/'))
    const command = manifest(files, 'package/package.json')
    expect(command).toMatchObject({
      name: 'create-avow-agent',
      private: true,
      bin: { 'create-avow-agent': 'dist/bin.js' },
    })
    // The terminal package draws its banner and rail, bundled inside, so npx fetches nothing else.
    expect(command.dependencies).toEqual({ '@avow-finance/terminal': TERMINAL_VERSION })
    expect(command.bundleDependencies).toEqual(['@avow-finance/terminal'])
    const terminal = manifest(files, 'package/node_modules/@avow-finance/terminal/package.json')
    expect(terminal).toMatchObject({ private: true, dependencies: {} })
    expect(files.has('package/node_modules/@avow-finance/terminal/dist/index.js')).toBe(true)
    expect(files.has('package/dist/bin.js') && files.has('package/dist/create.js')).toBe(true)
    expect(files.get('package/template/agent.ts')).toEqual(
      readFileSync(join(STARTER, 'template', 'agent.ts')),
    )
    expect(files.has('package/template/gitignore')).toBe(true)
    expect(files.has('package/template/business.ts')).toBe(true)
    expect(manifest(files, 'package/template/package.json').dependencies['@avow-finance/sdk']).toBe(
      'http://localhost:8080/avow-finance-sdk.tgz',
    )
  })

  it('carries every template file, so a folder made from the tarball is whole', () => {
    const files = untar(createTarball('http://localhost:8080/'))
    for (const f of TEMPLATE_FILES) expect(files.has(`package/template/${f}`), f).toBe(true)
    // The folder is made from the unpacked tarball, as npx runs it, not from this repo's template.
    const dir = mkdtempSync(join(tmpdir(), 'avow-pack-'))
    try {
      for (const [path, data] of files) {
        if (!path.startsWith('package/template/')) continue
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), data)
      }
      const made = createAgentFolder(join(dir, 'my-agent'), join(dir, 'package', 'template'))
      for (const f of [
        'agent.ts',
        'service.ts',
        'bypass.ts',
        'business.ts',
        'package.json',
        '.gitignore',
      ]) {
        expect(existsSync(join(made, f)), f).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('packs the SDK with the spec, the verifier and the terminal inside, every package private', () => {
    const files = untar(sdkTarball())
    const sdk = manifest(files, 'package/package.json')
    const spec = manifest(files, 'package/node_modules/@avow-finance/spec/package.json')
    const verifier = manifest(files, 'package/node_modules/@avow-finance/verifier/package.json')
    const terminal = manifest(files, 'package/node_modules/@avow-finance/terminal/package.json')
    expect(sdk.bundleDependencies).toEqual([
      '@avow-finance/spec',
      '@avow-finance/verifier',
      '@avow-finance/terminal',
    ])
    expect(sdk.bin['avow-sandbox']).toBe('./dist/node/cli.js')
    for (const m of [sdk, spec, verifier, terminal]) {
      expect(m.private).toBe(true)
      expect(m.scripts).toBeUndefined()
      expect(JSON.stringify(m.dependencies)).not.toContain('workspace:')
    }
    // What the bundled packages need from npm is on the SDK, so npm installs it where they look.
    for (const [name, version] of Object.entries({
      ...spec.dependencies,
      ...verifier.dependencies,
    })) {
      expect(sdk.dependencies[name]).toBe(version)
    }
    for (const path of [
      'package/dist/node.js',
      'package/dist/node/cli.js',
      'package/LICENSE',
      'package/node_modules/@avow-finance/spec/dist/index.js',
      'package/node_modules/@avow-finance/verifier/dist/index.js',
      'package/node_modules/@avow-finance/terminal/dist/index.js',
    ]) {
      expect(files.has(path), path).toBe(true)
    }
    expect([...files.keys()].some((p) => p.endsWith('.test.js'))).toBe(false)
    // Only what the sources make ships, so a stale file in a build never reaches the tarball.
    for (const path of files.keys()) {
      const module =
        /^package\/(?:node_modules\/@avow-finance\/(\w+)\/)?dist\/(.+?)(?:\.d)?\.(?:js|ts)(?:\.map)?$/.exec(
          path,
        )
      if (!module) continue
      const pkg = module[1] ?? 'sdk'
      expect(
        existsSync(join(STARTER, '..', '..', 'packages', pkg, 'src', `${module[2]}.ts`)),
        path,
      ).toBe(true)
    }
  })
})
