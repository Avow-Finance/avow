import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it } from 'vitest'
import { prepareSandboxBusiness } from '../sandbox/setup.js'
import { fileStore } from './platform.js'

/**
 * The demo Claude runs, on Moderato through the MCP server: book $200 of GPU compute, then
 * another $400. The business is set up for the run with keys held in a folder made for it. Runs
 * when AVOW_LIVE_TEMPO=1, once Avow's sandbox can pay a new business.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'node', 'mcp.js')
const PASSPHRASE = 'a passphrase made for this run'

describe.skipIf(!live)('the MCP agent on Moderato', () => {
  it(
    'reserves $200 and the supplier accepts, then Avow refuses $400 with $300 left',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'avow-mcp-live-'))
      await prepareSandboxBusiness({
        config: {
          name: 'MCP Live Test',
          authority: 500,
          dailyLimit: 1000,
          suppliers: [{ id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }],
        },
        prompts: {
          newPassphrase: async () => PASSPHRASE,
          passphrase: async () => PASSPHRASE,
          confirm: async () => true,
        },
        store: fileStore(join(dir, '.avow')),
        session: null,
        log: () => {},
      })
      const client = new Client({ name: 'avow-live', version: '0.0.0' })
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [SERVER, '--dir', dir],
          stderr: 'ignore',
        }),
      )
      try {
        const authority = await client.callTool({ name: 'authority', arguments: {} })
        expect(authority.structuredContent).toMatchObject({
          canCommitNow: 500,
          heldAtOnce: { limit: 500, left: 500 },
          movedPerDay: { limit: 1000, left: 1000 },
        })
        const first = await client.callTool({ name: 'book', arguments: { reserve: 200 } })
        expect(first.isError).toBe(false)
        expect(first.structuredContent).toMatchObject({
          status: 'committed',
          reserve: 200,
          accepted: true,
          left: 300,
        })
        const checks = (first.structuredContent as { checks: { passed: boolean }[] }).checks
        expect(checks.every((c) => c.passed)).toBe(true)
        const second = await client.callTool({ name: 'book', arguments: { reserve: 400 } })
        expect(second.structuredContent).toMatchObject({
          status: 'refused',
          code: 'mandate.over_open_reserves_cap',
          layer: 'avow',
          amounts: { needed: 400, left: 300, heldAtOnce: 500 },
        })
        const listed = await client.callTool({ name: 'commitments', arguments: {} })
        expect((listed.structuredContent as { commitments: unknown[] }).commitments).toHaveLength(1)
      } finally {
        await client.close()
      }
    },
    15 * 60_000,
  )
})
