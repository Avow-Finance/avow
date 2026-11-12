import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { publicPackages } from './packages.mjs'

// Packs each public package as npm will receive it, with workspace versions written out, into the
// folder named on the command line. Run it after the build, since each package ships its dist.
const out = resolve(process.argv[2] ?? 'packed')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const { dir, manifest } of publicPackages()) {
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'inherit' })
  console.log(`Packed ${manifest.name}@${manifest.version}`)
}
