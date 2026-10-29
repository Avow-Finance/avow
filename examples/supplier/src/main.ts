#!/usr/bin/env node
import { requestSupplierAuthorization, sendOwn } from '@avow-finance/sdk'
import {
  MemoryReplayGuard,
  type SupplierProfile,
  TEMPO_MODERATO,
  TESTNET_DEMO_PROFILE,
} from '@avow-finance/spec'
import { readBacking, tempoChainReader } from '@avow-finance/verifier'
import { createClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'
import { type AcceptDeps, advanceAll } from './accept.js'
import { agentServer } from './agents.js'
import { ALPHA_USD, baseSettings, serveSettings } from './settings.js'
import { SupplierStore } from './store.js'

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)
const clock = () => BigInt(Math.floor(Date.now() / 1000))

function clientFor(rpcUrl: string) {
  return createClient({
    chain: tempoModerato.extend({ feeToken: ALPHA_USD }),
    transport: http(rpcUrl, { retryCount: 3 }),
  }).extend(publicActions)
}

function keysOf(store: SupplierStore) {
  const keys = store.keys()
  if (!keys) throw new Error(`No keys in ${store.dir}. Run init first.`)
  const account = privateKeyToAccount(keys.accountKey)
  const signingKey = privateKeyToAccount(keys.signingKey)
  return { account, signingKey }
}

/** Makes the supplier's keys and has the faucet fund the signing key, which pays for acceptances. */
async function init() {
  const { stateDir, rpcUrl } = baseSettings(process.env)
  const store = new SupplierStore(stateDir)
  if (!store.keys()) store.makeKeys()
  const { account, signingKey } = keysOf(store)
  log(`funding the signing key ${signingKey.address} from Moderato's faucet`)
  await Actions.faucet.fundSync(clientFor(rpcUrl), {
    account: signingKey.address,
    timeout: 60_000,
  })
  log(`keys are in ${stateDir}/keys.json. Keep that file safe and out of version control.`)
  console.log(
    JSON.stringify(
      { account: account.address, payee: account.address, signingKey: signingKey.address },
      null,
      2,
    ),
  )
  log('Send Avow these three addresses to be registered as a supplier, then run serve.')
}

/** Serves agents and accepts each reserve Avow authorizes, until it's stopped. */
async function serve() {
  const settings = serveSettings(process.env)
  const store = new SupplierStore(settings.stateDir)
  const { account, signingKey } = keysOf(store)
  const client = clientFor(settings.rpcUrl)
  const chain = tempoChainReader(client, { factory: settings.factory, chainId: TEMPO_MODERATO })
  const profile: SupplierProfile = {
    businessId: settings.businessId,
    account: account.address,
    payee: account.address,
    signingKey: signingKey.address,
  }
  const server = agentServer({
    profile,
    rules: {
      chainId: TEMPO_MODERATO,
      businessId: settings.businessId,
      maxReserve: settings.maxReserve,
      profile: TESTNET_DEMO_PROFILE,
      minTimeToAccept: 60n,
    },
    store,
    signingKey,
    isLock: async (lock) => (await chain.lock(lock))?.fromFactory === true,
    now: clock,
    log,
  }).listen(settings.port)
  log(`serving agents on port ${settings.port} as ${settings.businessId}`)

  const requests = {
    baseUrl: settings.apiUrl,
    key: {
      address: signingKey.address,
      signDigest: (hash: `0x${string}`) => signingKey.sign({ hash }),
    },
  }
  const deps: AcceptDeps = {
    store,
    config: {
      chainId: TEMPO_MODERATO,
      avowKeys: settings.approvalKeys,
      businessId: settings.businessId,
      payee: account.address,
      acceptedTokens: [
        {
          rail: 'tempo',
          chainId: TEMPO_MODERATO,
          token: settings.token,
          currency: 'USD',
          decimals: 6,
        },
      ],
      profile: TESTNET_DEMO_PROFILE,
      acceptTestData: true,
      account: account.address,
      signingKey: signingKey.address,
    },
    chain,
    replay: new MemoryReplayGuard(),
    authorize: (c) => requestSupplierAuthorization(requests, c),
    signingKey,
    send: (call, onSent) => sendOwn({ client, account: signingKey, calls: [call], onSent }),
    lockState: async (lock, commitmentId) =>
      (await readBacking(client, lock, commitmentId, 'buyer'))?.state ?? null,
    finalizedTime: async () => (await client.getBlock({ blockTag: 'finalized' })).timestamp,
    now: clock,
    log,
  }
  let stopping = false
  const stop = () => {
    stopping = true
    server.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  while (!stopping) {
    await advanceAll(deps)
    for (let waited = 0; waited < settings.pollSeconds * 1000 && !stopping; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

function profile() {
  const { stateDir } = baseSettings(process.env)
  const { account, signingKey } = keysOf(new SupplierStore(stateDir))
  console.log(
    JSON.stringify(
      { account: account.address, payee: account.address, signingKey: signingKey.address },
      null,
      2,
    ),
  )
}

const commands: Record<string, () => Promise<void> | void> = { init, serve, profile }
const command = commands[process.argv[2] ?? '']
if (!command) {
  console.error('Usage: avow-supplier init | profile | serve')
  process.exit(2)
}
Promise.resolve(command()).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
