import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../../packages/', import.meta.url).pathname

/**
 * The packages a release publishes, which are those not marked private, ordered so each comes
 * after the packages it depends on. npm then never sees a package before what it needs.
 */
export function publicPackages() {
  const all = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(ROOT, e.name)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      return { dir, manifest }
    })
    .filter((p) => !p.manifest.private)
  const names = new Set(all.map((p) => p.manifest.name))
  const ordered = []
  const placed = new Set()
  const place = (p, path = []) => {
    if (placed.has(p.manifest.name)) return
    if (path.includes(p.manifest.name)) throw new Error(`${p.manifest.name} depends on itself`)
    for (const dep of Object.keys(p.manifest.dependencies ?? {})) {
      if (!names.has(dep)) continue
      const needed = all.find((q) => q.manifest.name === dep)
      if (needed) place(needed, [...path, p.manifest.name])
    }
    placed.add(p.manifest.name)
    ordered.push(p)
  }
  for (const p of all) place(p)
  return ordered
}

/** The file `pnpm pack` writes for a package, such as avow-finance-sdk-0.1.0.tgz. */
export const tarballOf = (manifest) =>
  `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`
