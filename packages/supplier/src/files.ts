import { renameSync, writeFileSync } from 'node:fs'

/**
 * Writes a file whole or not at all, readable only by the user running the adapter, so a crash
 * never leaves half a record.
 */
export function writeAtomically(path: string, text: string, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode })
  renameSync(temporary, path)
}
