import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What a new agent folder starts with, which travels beside this script in the tarball. */
export const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'template')

/**
 * The template's files and the names they take in the new folder. The ignore file travels as
 * `gitignore`, since npm leaves a file named `.gitignore` out of a package.
 */
const COPIED: Record<string, string> = {
  'agent.ts': 'agent.ts',
  'business.ts': 'business.ts',
  'README.md': 'README.md',
  'tsconfig.json': 'tsconfig.json',
  gitignore: '.gitignore',
}

/** The folder's name as npm takes a package name: lower case, with no spaces. */
export function packageName(folder: string): string {
  const name = basename(resolve(folder))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 214)
  return name || 'my-agent'
}

/**
 * Makes the agent's folder from the template. It refuses a folder that already holds anything, so
 * it never writes over someone's work.
 */
export function createAgentFolder(folder: string, template: string = TEMPLATE_DIR): string {
  const target = resolve(folder)
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`${folder} already exists and isn't empty. Pick another name.`)
  }
  mkdirSync(target, { recursive: true })
  for (const [from, to] of Object.entries(COPIED))
    copyFileSync(join(template, from), join(target, to))
  const manifest = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8')) as object
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify({ ...manifest, name: packageName(folder) }, null, 2)}\n`,
  )
  return target
}

/** Runs `npm install` in the folder, with the npm that started this command when there is one. */
export function install(target: string): boolean {
  const args = ['install', '--no-audit', '--no-fund']
  const npm = process.env.npm_execpath
  const result =
    npm && /npm-cli\.[cm]?js$/.test(npm)
      ? spawnSync(process.execPath, [npm, ...args], { cwd: target, stdio: 'inherit' })
      : spawnSync('npm', args, {
          cwd: target,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        })
  return result.status === 0
}

/** `create-avow-agent [folder] [--no-install]` */
export function main(args: readonly string[]): number {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) {
    console.error(`The starter needs Node 20 or later, and this is Node ${process.versions.node}.`)
    return 1
  }
  const folder = args.find((a) => !a.startsWith('-')) ?? 'my-agent'
  let target: string
  try {
    target = createAgentFolder(folder)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  console.log(`Made ${folder}, with business.ts, agent.ts and a README.`)
  if (!args.includes('--no-install')) {
    console.log('Installing its packages.\n')
    if (!install(target)) {
      console.error(`\nnpm install didn't finish. Run it in ${folder}, then npm start.`)
      return 1
    }
  }
  console.log(`\nStart it with\n\n  cd ${folder}\n  npm start\n`)
  return 0
}
