import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as sdk from '../node.js'
import { fileStore } from './platform.js'

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'))

describe("the SDK's node export", () => {
  it('gives a service the same folder store the sandbox keeps `.avow` with', () => {
    expect(sdk.fileStore).toBe(fileStore)
  })

  it('types Node imports from the node entry, so what it adds reaches TypeScript too', () => {
    // Node and TypeScript take the first condition they match, so `node` comes before `types`.
    expect(Object.keys(manifest.exports['.'])).toEqual(['node', 'types', 'default'])
    expect(manifest.exports['.'].node).toEqual({
      types: './dist/node.d.ts',
      default: './dist/node.js',
    })
  })
})
