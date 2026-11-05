import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSandboxDeployment } from '../sandbox/deployment.js'
import { prepareSandboxBusiness } from '../sandbox/setup.js'
import { fileStore } from './platform.js'
import { keepSession } from './runner-session.js'

/**
 * A restart against Avow's hosted relay, for a business Avow's sandbox registers for the run. The
 * first start signs the mandate into a new session, and the next keeps that session. Runs when
 * AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const PASSPHRASE = 'a passphrase made for this run'

describe.skipIf(!live)('the runner session on the hosted relay', () => {
  it(
    'keeps the session across a restart once it holds the authority',
    async () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'avow-session-live-')), '.avow')
      const store = fileStore(dir)
      const deployment = await loadSandboxDeployment()
      const first = await keepSession({ dir, apiUrl: deployment.apiUrl, account: null })
      expect(first.fresh).toBe(true)
      const prepared = await prepareSandboxBusiness({
        config: {
          name: 'Session Live Test',
          authority: 500,
          suppliers: [{ id: 'avow-demo-gpu', url: deployment.supplierUrl }],
        },
        prompts: {
          newPassphrase: async () => PASSPHRASE,
          passphrase: async () => PASSPHRASE,
          confirm: async () => true,
        },
        store,
        deployment,
        session: { id: first.id, run: 1 },
        announce: first.fresh,
        log: () => {},
      })
      expect(prepared).toMatchObject({ signed: true, announced: true })
      const restarted = await keepSession({
        dir,
        apiUrl: deployment.apiUrl,
        account: prepared.account,
      })
      expect(restarted.id).toBe(first.id)
      expect(restarted.fresh).toBe(false)
      expect(restarted.endsAt).not.toBeNull()
    },
    15 * 60_000,
  )
})
