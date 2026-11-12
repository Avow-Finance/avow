import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { publicPackages, tarballOf } from './packages.mjs'

// Publishes each packed package that npm doesn't have yet, dependencies first, so a release that
// stopped part way can run again and finish. npm signs each with this workflow's identity, which
// is what the provenance on the package page points to.
const dir = resolve(process.argv[2] ?? 'packed')
for (const { manifest } of publicPackages()) {
  const id = `${manifest.name}@${manifest.version}`
  const seen = spawnSync('npm', ['view', id, 'version'], { encoding: 'utf8' })
  if (seen.status === 0 && seen.stdout.trim() === manifest.version) {
    console.log(`${id} is already on npm`)
    continue
  }
  execFileSync('npm', ['publish', join(dir, tarballOf(manifest)), '--access', 'public'], {
    stdio: 'inherit',
  })
  console.log(`Published ${id}`)
}
