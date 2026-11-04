import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AvowDomain, dollars, mandateHash, newSessionId } from '@avow-finance/spec'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { MODERATO_FACTORY } from '../moderato.js'
import { saveBusinessItem } from '../sandbox/business-store.js'
import { sandboxMandate } from '../sandbox/mandate.js'
import { saveAgentItem } from '../sandbox/store.js'
import { sealKey } from '../sandbox/vault.js'
import { accountSigner, signMandate } from '../sign.js'
import { fileStore } from './platform.js'
import { runAgent } from './runner.js'

// The SDK as the agent's process loads it, from the build.
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')
const PASSPHRASE = 'correct horse battery staple'
const TOKEN = '0x20c00000000000000000000058fbf8a39a171185'
const LOCK = '0x00000000000000000000000000000000000010c4'
const supplier = { id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }
const deployment = {
  chainId: 42431,
  rpcUrl: 'https://rpc.moderato.tempo.xyz',
  apiUrl: 'https://api.testnet.avow.finance',
  supplierUrl: supplier.url,
  factory: MODERATO_FACTORY.toLowerCase(),
  token: TOKEN,
  arbiter: '0x7b7b7e93b9de1b9cba5123f0570b56eb66c53173',
  day90SupplierShareBps: 5000,
}

/** An agent file that tries every way to the business's authority it can find. */
const HOSTILE = `import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
const narrow = await import(${JSON.stringify(join(DIST, 'node-agent.js'))})
const vault = await import(${JSON.stringify(join(DIST, 'sandbox', 'vault.js'))})
const full = await import(${JSON.stringify(join(DIST, 'node.js'))})
const raw = readFileSync('.avow/business.json', 'utf8')
const business = JSON.parse(raw)
const opened = []
for (const guess of ['', 'password', 'passphrase', 'avow-sandbox', 'starter test co']) {
  try { await vault.openKey(business.key, guess, business.account); opened.push(guess) } catch {}
}
// A node that answers for the business's lock as Moderato would, so nothing here needs the network.
const word = (hex) => hex.slice(2).toLowerCase().padStart(64, '0')
const node = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const asked = JSON.parse(body)
    const answer = ({ id, method }) => ({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0xa5bf' : method === 'eth_getCode' ? '0x6080' : '0x' + word(business.business.lock) })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(Array.isArray(asked) ? asked.map(answer) : answer(asked)))
  })
})
await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve))
let authority
try {
  await full.prepareSandboxBusiness({
    config: { name: 'Starter Test Co', authority: 1000000, suppliers: [${JSON.stringify(supplier)}] },
    prompts: { newPassphrase: async () => 'x'.repeat(12), passphrase: async () => 'a guess at it', confirm: async () => true },
    deployment: { ...${JSON.stringify(deployment)}, rpcUrl: 'http://127.0.0.1:' + node.address().port },
    session: null,
    log: () => {},
  })
  authority = 'signed'
} catch (error) { authority = error.message }
node.close()
process.stdout.write(JSON.stringify({
  exports: Object.keys(narrow).sort(),
  sandbox: Object.keys(narrow.sandbox).sort(),
  env: process.env,
  raw,
  opened,
  authority,
}))
`

describe("the agent's process", () => {
  it("can't reach the business's key, its passphrase or any call that changes the authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avow-isolation-'))
    const store = fileStore(join(dir, '.avow'))
    const rootKey = generatePrivateKey()
    const root = Account.fromSecp256k1(rootKey)
    const agentKey = generatePrivateKey()
    const agent = Account.fromSecp256k1(agentKey, { access: root.address })
    const business = {
      chainId: deployment.chainId,
      apiUrl: deployment.apiUrl,
      factory: deployment.factory as `0x${string}`,
      token: TOKEN,
      account: root.address,
      lock: LOCK,
      businessId: 'sandbox-business',
    } as const
    await saveBusinessItem(store, {
      account: root.address,
      key: await sealKey(rootKey, PASSPHRASE, root.address),
      business,
    })
    const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: LOCK }
    const message = sandboxMandate({
      businessId: business.businessId,
      agentId: 'agt_test',
      account: root.address,
      agentKey: agent.accessKeyAddress,
      suppliers: [supplier.id],
      token: TOKEN,
      capPerCommitment: dollars(500),
      capOpenReserves: dollars(500),
      expiry: BigInt(Math.floor(Date.now() / 1000)) + 86_400n,
    })
    await saveAgentItem(store, {
      agentKey,
      business,
      mandate: await signMandate(message, domain, accountSigner(root.address, root)),
      mandateHash: mandateHash(message, domain),
      keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
      suppliers: [supplier],
    })
    writeFileSync(join(dir, 'agent.mjs'), HOSTILE)

    const { code, output } = await runAgent(
      'agent.mjs',
      { id: newSessionId(), run: 1 },
      { cwd: dir, capture: true },
    )
    expect(code).toBe(0)
    const seen = JSON.parse(output) as {
      exports: string[]
      sandbox: string[]
      env: Record<string, string>
      raw: string
      opened: string[]
      authority: string
    }
    // The agent's entry point has the agent and its refusals, and nothing of the business's.
    expect(seen.exports).toEqual(['Refusal', 'sandbox'])
    expect(seen.sandbox).toEqual(['agent'])
    // Nothing in its environment is the key or the passphrase.
    const secret = rootKey.slice(2).toLowerCase()
    for (const value of Object.values(seen.env)) {
      expect(value.toLowerCase()).not.toContain(secret)
      expect(value).not.toContain(PASSPHRASE)
    }
    expect(
      Object.keys(seen.env)
        .filter((k) => k.startsWith('AVOW_'))
        .sort(),
    ).toEqual(['AVOW_SANDBOX_RUN', 'AVOW_SANDBOX_SESSION'])
    // The business's file holds the key only sealed, and no guess opens it.
    expect(seen.raw.toLowerCase()).not.toContain(secret)
    expect(seen.opened).toEqual([])
    // A call that would change the authority stops at the passphrase it doesn't have.
    expect(seen.authority).toMatch(/doesn't open the business's key/)
  }, 60_000)
})
