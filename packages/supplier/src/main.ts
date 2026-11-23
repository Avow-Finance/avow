#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AvowResend,
  type Call,
  factoriesToRead,
  moderatoClient,
  moderatoUsdToken,
  type OnSent,
  requestSupplierAuthorization,
  sendOwn,
} from '@avow-finance/sdk'
import {
  MemoryReplayGuard,
  type SupplierProfile,
  TEMPO_MODERATO,
  TESTNET_DEMO_PROFILE,
} from '@avow-finance/spec'
import { readBacking, tempoChainReader } from '@avow-finance/verifier'
import type { Address } from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { Actions } from 'viem/tempo'
import { type AcceptDeps, bookingPoller } from './accept.js'
import { agentServer } from './agents.js'
import { localHostnames, localServer } from './local.js'
import { reportArgs, reportCharge } from './report.js'
import { baseSettings, envKeys, reportSettings, serveSettings } from './settings.js'
import { makeWebhookSecret } from './signature.js'
import { type Booking, SupplierStore } from './store.js'
import { bookingEvent, fetchPost, Outbox, reconcile, webhookSender } from './webhook.js'

type Client = ReturnType<typeof moderatoClient>

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)
const clock = () => BigInt(Math.floor(Date.now() / 1000))

/** Sends a call from the signing key, which pays its own fee, as acceptances and reports go. */
const sendFrom = (client: Client, signingKey: PrivateKeyAccount) => (call: Call, onSent: OnSent) =>
  sendOwn({ client, account: signingKey, calls: [call], onSent })

/** The latest finalized block's time, after which a transaction that expired can't land. */
const finalizedTimeOf = (client: Client) => async () =>
  (await client.getBlock({ blockTag: 'finalized' })).timestamp

/** The keys the state directory's keys file holds, which `init` made. */
function fileKeys(store: SupplierStore) {
  const keys = store.keys()
  if (!keys) throw new Error(`No keys in ${store.dir}. Run init first.`)
  return {
    account: privateKeyToAccount(keys.accountKey).address,
    signingKey: privateKeyToAccount(keys.signingKey),
  }
}

/**
 * The account's address and the signing key, from the environment when it holds them and from the
 * keys file otherwise. A host keeps the signing key in a secret store this way, and the account key
 * never reaches the machine that serves agents.
 */
function keysOf(store: SupplierStore): { account: Address; signingKey: PrivateKeyAccount } {
  const fromEnv = envKeys(process.env)
  if (!fromEnv) return fileKeys(store)
  return { account: fromEnv.account, signingKey: privateKeyToAccount(fromEnv.signingKey) }
}

/** Makes the supplier's keys and has the faucet fund the signing key, which pays for acceptances. */
async function init() {
  const { stateDir, rpcUrl } = baseSettings(process.env)
  const store = new SupplierStore(stateDir)
  if (!store.keys()) store.makeKeys()
  const { account, signingKey } = fileKeys(store)
  log(`funding the signing key ${signingKey.address} from Moderato's faucet`)
  await Actions.faucet.fundSync(moderatoClient(rpcUrl), {
    account: signingKey.address,
    timeout: 60_000,
  })
  log(`keys are in ${stateDir}/keys.json. Keep that file safe and out of version control.`)
  console.log(JSON.stringify({ account, payee: account, signingKey: signingKey.address }, null, 2))
  log('Send Avow these three addresses to be registered as a supplier, then run serve.')
}

/** Serves agents and accepts each reserve Avow authorizes, until it's stopped. */
async function serve() {
  const settings = serveSettings(process.env)
  const outbox = settings.webhook ? new Outbox(settings.stateDir, Date.now()) : null
  // A booking is saved before its event is added, and an outbox that fails to add one never stops
  // the booking moving on. The reconciliation at the next start adds what was missed.
  const enqueue = (b: Booking) => {
    try {
      const event = outbox && bookingEvent(b, new Date())
      if (outbox && event) outbox.add(event, Date.now())
    } catch (e) {
      log(
        `webhook: couldn't add the event for ${b.commitmentId} (${e instanceof Error ? e.message : String(e)})`,
      )
    }
  }
  const store = new SupplierStore(settings.stateDir, enqueue)
  if (outbox) {
    const readable = store.commitmentIds().flatMap((id) => {
      try {
        return store.booking(id) ?? []
      } catch {
        // The poll logs a booking file it can't read.
        return []
      }
    })
    const added = reconcile(outbox, readable, new Date())
    if (added > 0) log(`webhook: added ${added} events the outbox was missing`)
  }
  const { account, signingKey } = keysOf(store)
  const client = moderatoClient(settings.rpcUrl)
  // A buyer's lock from any factory the SDK trusts counts, so buyers keep their locks when the
  // sandbox moves to a newer factory, and a factory the SDK doesn't trust stops the adapter here.
  const factories = factoriesToRead(TEMPO_MODERATO, settings.factory)
  const chain = tempoChainReader(client, { factory: factories, chainId: TEMPO_MODERATO })
  const profile: SupplierProfile = {
    businessId: settings.businessId,
    account,
    payee: account,
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
    limits: { perBuyer: settings.maxOpenPerBuyer, total: settings.maxOpenBookings },
    store,
    signingKey,
    isLock: async (lock) => (await chain.lock(lock))?.fromFactory === true,
    now: clock,
    log,
  })
  server.on('error', cannotListen('agents', settings.port))
  server.listen(settings.port)
  log(`serving agents on port ${settings.port} as ${settings.businessId}`)
  const local = localServer({
    store,
    chain,
    payee: account,
    decimals: moderatoUsdToken(settings.token).decimals,
    hostnames: localHostnames(settings.localHost),
    log,
  })
  local.on('error', cannotListen('your own systems', settings.localPort))
  local.listen(settings.localPort, settings.localHost)
  log(`answering checks for your own systems on ${settings.localHost}:${settings.localPort}`)
  if (!localHostnames('127.0.0.1').includes(settings.localHost)) {
    log(
      `LOCAL_HOST is ${settings.localHost}, so other machines can reach the check, which shows your bookings' terms and buyers. Keep that port behind your firewall.`,
    )
  }

  const requests = {
    baseUrl: settings.apiUrl,
    key: {
      address: signingKey.address,
      signDigest: (hash: `0x${string}`) => signingKey.sign({ hash }),
    },
    // The poll asks again on its next pass, so one booking's request never holds it up for long.
    retryFor: 60n,
    onResend: (r: AvowResend) =>
      log(`no definite answer from Avow yet (${r.message}), asking again in ${r.waitMs} ms`),
  }
  const deps: AcceptDeps = {
    store,
    config: {
      chainId: TEMPO_MODERATO,
      avowKeys: settings.approvalKeys,
      businessId: settings.businessId,
      payee: account,
      acceptedTokens: [moderatoUsdToken(settings.token)],
      profile: TESTNET_DEMO_PROFILE,
      acceptTestData: true,
      account,
      signingKey: signingKey.address,
    },
    chain,
    replay: new MemoryReplayGuard(),
    authorize: (c) => requestSupplierAuthorization(requests, c),
    signingKey,
    send: sendFrom(client, signingKey),
    lockState: async (lock, commitmentId) =>
      (await readBacking(client, lock, commitmentId, 'buyer'))?.state ?? null,
    finalizedTime: finalizedTimeOf(client),
    now: clock,
    log,
  }
  const poll = bookingPoller(deps)
  let stopping = false
  const stop = () => {
    stopping = true
    server.close()
    local.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  /** Runs a step, then waits, until the process stops. A step that throws is logged and run again. */
  const every = async (seconds: number, step: () => Promise<void>, what: string) => {
    while (!stopping) {
      try {
        await step()
      } catch (e) {
        log(`${what} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      for (let waited = 0; waited < seconds * 1000 && !stopping; waited += 250) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }
  const loops = [every(settings.pollSeconds, poll, 'the booking poll')]
  // The webhook runs on its own loop, so a slow or unreachable receiver never holds up an
  // acceptance, which may have only a minute before its deadline.
  if (outbox && settings.webhook) {
    const deliver = webhookSender({
      target: settings.webhook,
      outbox,
      post: fetchPost,
      nowMs: Date.now,
      log,
    })
    log(`posting booking events to ${new URL(settings.webhook.url).origin}`)
    loops.push(every(1, deliver, 'the webhook'))
  }
  await Promise.all(loops)
}

/** Stops the process with a sentence when a port can't be opened, such as when it's in use. */
const cannotListen = (what: string, port: number) => (e: Error) => {
  log(`couldn't open port ${port} for ${what} (${e.message})`)
  process.exit(1)
}

/**
 * Reports a late cancellation, or a no-show with `--no-show`, on an accepted booking, then follows
 * the lock until Avow confirms the charge or refers it to a ruling.
 */
async function report() {
  const args = reportArgs(process.argv.slice(3))
  const settings = reportSettings(process.env)
  const store = new SupplierStore(settings.stateDir)
  const { signingKey } = keysOf(store)
  const client = moderatoClient(settings.rpcUrl)
  await reportCharge(
    {
      store,
      config: {
        chainId: TEMPO_MODERATO,
        signingKey: signingKey.address,
        acceptedTokens: [moderatoUsdToken(settings.token)],
      },
      chain: tempoChainReader(client, {
        factory: factoriesToRead(TEMPO_MODERATO, settings.factory),
        chainId: TEMPO_MODERATO,
      }),
      signingKey,
      send: sendFrom(client, signingKey),
      chainTime: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
      finalizedTime: finalizedTimeOf(client),
      wait: () => new Promise((resolve) => setTimeout(resolve, 5000)),
      log,
    },
    args,
  )
}

function profile() {
  const { stateDir } = baseSettings(process.env)
  const { account, signingKey } = keysOf(new SupplierStore(stateDir))
  console.log(JSON.stringify({ account, payee: account, signingKey: signingKey.address }, null, 2))
}

/** Prints a new webhook secret, for `WEBHOOK_SECRET` here and in the system that receives events. */
function secret() {
  console.log(makeWebhookSecret())
}

/** Puts every webhook event the adapter gave up on back to be sent, for a receiver that's back. */
function redeliver() {
  const { stateDir } = baseSettings(process.env)
  if (!existsSync(join(stateDir, 'outbox'))) {
    log(`${stateDir} has no webhook outbox, so there is nothing to send again`)
    return
  }
  const count = new Outbox(stateDir, Date.now()).redeliverFailed(Date.now())
  log(`${count} events will go out again once serve runs`)
}

const commands: Record<string, () => Promise<void> | void> = {
  init,
  serve,
  report,
  profile,
  secret,
  redeliver,
}
const command = commands[process.argv[2] ?? '']
if (!command) {
  console.error(
    'Usage: avow-supplier init | profile | secret | serve | redeliver | report [commitmentId] [--no-show]',
  )
  process.exit(2)
}
Promise.resolve(command()).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
