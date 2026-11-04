import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/**
 * Builds what the sandbox's host serves for the starter. `create-avow-agent.tgz` is the command
 * `npx` runs, with the template it copies. `avow-finance-sdk.tgz` is the SDK the new folder depends
 * on until the SDK is on npm, with the spec and the verifier inside it, so npm fetches nothing
 * else from the host. Every package inside stays private, so neither tarball can be published.
 */

/** The host the tarballs are served from by default, the sandbox's screen. */
export const DEFAULT_HOST = 'https://try.testnet.avow.finance'

export const TARBALLS = { create: 'create-avow-agent.tgz', sdk: 'avow-finance-sdk.tgz' } as const

const STARTER = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(STARTER, '..', '..', 'packages')

/** One file in a tarball, at its path under `package/`. */
export interface TarEntry {
  path: string
  data: Buffer
  mode?: number
}

/** The time npm stamps on every file it packs, so the same files make the same tarball. */
const MTIME = 499162500

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

/** One ustar header, with a long path split into its prefix and name. */
function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(512)
  let name = entry.path
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155)
    prefix = name.slice(0, cut)
    name = name.slice(cut + 1)
    if (cut <= 0 || Buffer.byteLength(name) > 100) throw new RangeError(`${entry.path} is too long`)
  }
  block.write(name, 0, 100, 'utf8')
  block.write(octal(entry.mode ?? 0o644, 8), 100, 8, 'ascii')
  block.write(octal(0, 8), 108, 8, 'ascii')
  block.write(octal(0, 8), 116, 8, 'ascii')
  block.write(octal(entry.data.length, 12), 124, 12, 'ascii')
  block.write(octal(MTIME, 12), 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write('0', 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

/** A gzipped tarball in the ustar form npm reads, with every file under `package/`. */
export function tarball(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    blocks.push(header({ ...entry, path: `package/${entry.path}` }), entry.data)
    const pad = (512 - (entry.data.length % 512)) % 512
    if (pad > 0) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

type Manifest = Record<string, unknown> & {
  name: string
  version: string
  files?: string[]
  dependencies?: Record<string, string>
}

const readManifest = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

/** Every file under a path, at its path relative to `base` with forward slashes. */
function filesUnder(path: string, base: string, at: string): TarEntry[] {
  if (statSync(path).isFile()) {
    return [{ path: `${at}${relative(base, path).split(sep).join('/')}`, data: readFileSync(path) }]
  }
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name), base, at))
}

/** A package's published files, as npm packs them: its `files`, with its README and license. */
function published(dir: string, manifest: Manifest, at: string): TarEntry[] {
  const listed = manifest.files ?? []
  for (const f of listed) {
    if (!statSync(join(dir, f), { throwIfNoEntry: false })) {
      throw new Error(`${manifest.name} has no ${f}. Run pnpm build first.`)
    }
  }
  const readme = statSync(join(dir, 'README.md'), { throwIfNoEntry: false }) ? ['README.md'] : []
  // Each package is under the repository's license, which sits at the root.
  const license = join(PACKAGES, '..', 'LICENSE')
  return [
    ...[...listed, ...readme].flatMap((f) => filesUnder(join(dir, f), dir, at)),
    { path: `${at}LICENSE`, data: readFileSync(license) },
  ]
}

/** A manifest as it ships, without what only the repository's own build reads. */
function shipped(m: Manifest, dependencies: Record<string, string>): Manifest {
  const { scripts: _scripts, devDependencies: _dev, ...rest } = m
  return { ...rest, private: true, dependencies }
}

/** The SDK, with the spec and the verifier bundled inside it. */
export function sdkTarball(): Buffer {
  const dirs = { sdk: 'sdk', spec: 'spec', verifier: 'verifier' } as const
  const at = (name: keyof typeof dirs) => join(PACKAGES, dirs[name])
  const sdk = readManifest(at('sdk'))
  const spec = readManifest(at('spec'))
  const verifier = readManifest(at('verifier'))
  const bundled = { [spec.name]: spec.version, [verifier.name]: verifier.version }
  // Every outside dependency goes on the SDK too, so npm installs it where the bundled packages
  // find it. Two packages pinning one dependency to different versions would break that.
  const outside: Record<string, string> = {}
  for (const m of [sdk, spec, verifier]) {
    for (const [name, version] of Object.entries(m.dependencies ?? {})) {
      if (name in bundled) continue
      if (version.startsWith('workspace:'))
        throw new Error(`${m.name} depends on ${name} in the workspace`)
      if (outside[name] && outside[name] !== version) {
        throw new Error(`${name} is pinned to both ${outside[name]} and ${version}`)
      }
      outside[name] = version
    }
  }
  const only = (m: Manifest) =>
    Object.fromEntries(
      Object.keys(m.dependencies ?? {}).map((name) => [
        name,
        bundled[name] ?? (outside[name] as string),
      ]),
    )
  const sorted = Object.fromEntries(Object.entries({ ...outside, ...bundled }).sort())
  return tarball([
    {
      path: 'package.json',
      data: json({ ...shipped(sdk, sorted), bundleDependencies: Object.keys(bundled) }),
    },
    ...published(at('sdk'), sdk, ''),
    ...[spec, verifier].flatMap((m, i) => {
      const dir = at(i === 0 ? 'spec' : 'verifier')
      const where = `node_modules/${m.name}/`
      return [
        { path: `${where}package.json`, data: json(shipped(m, only(m))) },
        ...published(dir, m, where),
      ]
    }),
  ])
}

/** The command `npx` runs, with the template it copies, depending on the SDK at `host`. */
export function createTarball(host: string = DEFAULT_HOST): Buffer {
  const origin = new URL(host).origin
  const starter = readManifest(STARTER)
  const template = join(STARTER, 'template')
  const folder = readManifest(template)
  const manifest = {
    name: 'create-avow-agent',
    version: starter.version,
    private: true,
    description: starter.description,
    license: starter.license,
    type: 'module',
    bin: { 'create-avow-agent': 'dist/bin.js' },
    engines: { node: '>=20' },
  }
  const dependencies = { ...folder.dependencies, '@avow-finance/sdk': `${origin}/${TARBALLS.sdk}` }
  const file = (path: string) => readFileSync(join(STARTER, path))
  return tarball([
    { path: 'package.json', data: json(manifest) },
    { path: 'dist/bin.js', data: file('dist/bin.js'), mode: 0o755 },
    { path: 'dist/create.js', data: file('dist/create.js') },
    ...['agent.ts', 'README.md', 'tsconfig.json', 'gitignore'].map((f) => ({
      path: `template/${f}`,
      data: file(`template/${f}`),
    })),
    { path: 'template/package.json', data: json({ ...folder, dependencies }) },
  ])
}

/** Writes both tarballs into `out`, and gives their paths. */
export function packStarter(out: string, host: string = DEFAULT_HOST): string[] {
  mkdirSync(out, { recursive: true })
  const written = [
    [TARBALLS.create, createTarball(host)],
    [TARBALLS.sdk, sdkTarball()],
  ] as const
  return written.map(([name, data]) => {
    const path = join(out, name)
    writeFileSync(path, data)
    return path
  })
}

const flag = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = flag('--host') ?? DEFAULT_HOST
  for (const path of packStarter(resolve(flag('--out') ?? join(STARTER, 'host')), host)) {
    console.log(`${relative(process.cwd(), path)}  ${(statSync(path).size / 1024).toFixed(0)} KB`)
  }
  console.log(`Serve both from the root of ${new URL(host).origin}.`)
}
