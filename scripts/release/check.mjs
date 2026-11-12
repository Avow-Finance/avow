import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { publicPackages, tarballOf } from './packages.mjs'

// Installs the packed packages into an empty project, the way a developer gets them from npm, and
// checks that the command runs and every entry point loads. A dependency left out of a manifest
// shows up here, where the workspace would have hidden it.
const dir = resolve(process.argv[2] ?? 'packed')

// npm checks each package's repository against the provenance GitHub signs, letter for letter, and
// refuses the publish when they differ. In a workflow, GitHub names the repository it runs in.
const repository = process.env.GITHUB_REPOSITORY
if (repository) {
  const expected = `git+https://github.com/${repository}.git`
  for (const { manifest } of publicPackages()) {
    if (manifest.repository?.url !== expected) {
      throw new Error(
        `${manifest.name} names ${manifest.repository?.url}, and npm expects ${expected}`,
      )
    }
  }
  console.log(`Every package names ${repository}`)
}
const tarballs = publicPackages().map(({ manifest }) => join(dir, tarballOf(manifest)))
const project = mkdtempSync(join(tmpdir(), 'avow-packages-'))
writeFileSync(join(project, 'package.json'), '{ "private": true, "type": "module" }\n')

const run = (command, args) =>
  execFileSync(command, args, {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })

run('npm', ['install', '--no-audit', '--no-fund', ...tarballs])

const help = run('npx', ['--no-install', 'avow-sandbox', 'help'])
if (!help.includes('connect')) {
  throw new Error(`npx avow-sandbox help didn't list connect:\n${help}`)
}
console.log('npx avow-sandbox help lists connect')

run('node', [
  '--input-type=module',
  '-e',
  [
    "await import('@avow-finance/spec')",
    "await import('@avow-finance/verifier')",
    "await import('@avow-finance/sdk')",
    "await import('@avow-finance/sdk/agent')",
    "await import('@avow-finance/sdk/service')",
  ].join(';'),
])
console.log('Every entry point loads')

// The MCP server waits on its input, so it gets none and a few seconds to show it can load.
const mcp = spawnSync(join(project, 'node_modules', '.bin', 'avow-sandbox-mcp'), [], {
  cwd: project,
  input: '',
  timeout: 5000,
  encoding: 'utf8',
})
if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(`${mcp.stderr}${mcp.stdout}`)) {
  throw new Error(`avow-sandbox-mcp couldn't load:\n${mcp.stderr}`)
}
console.log('avow-sandbox-mcp loads')
