#!/usr/bin/env node
import {
  accountSigner,
  agentKeyTerms,
  agentRequestKey,
  approveSupplierCall,
  BookingError,
  createAgent,
  createLockCall,
  enrollAgent,
  FACTORY_ABI,
  httpAvowApi,
  RESERVE_SELECTOR,
  sendOwn,
  signMandate,
} from '@avow-finance/sdk'
import {
  type AvowDomain,
  gpuReservationTerms,
  type Mandate,
  mandateJson,
  parseSigned,
  type RailToken,
  type Signed,
  TEMPO_MODERATO,
  TESTNET_DEMO_PROFILE,
  toWire,
} from '@avow-finance/spec'
import { createClient, type Hex, http, publicActions } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Account, Actions } from 'viem/tempo'
import { quickstartBooking, quickstartMandate } from './plan.js'
import { ALPHA_USD, baseSettings, bookSettings, enrollSettings, initSettings } from './settings.js'
import { BuyerStore } from './store.js'
import { httpSupplier } from './supplier.js'

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

function clientFor(rpcUrl: string) {
  return createClient({
    chain: tempoModerato.extend({ feeToken: ALPHA_USD }),
    transport: http(rpcUrl, { retryCount: 3 }),
  }).extend(publicActions)
}

function keysOf(store: BuyerStore) {
  const keys = store.keys()
  if (!keys) throw new Error(`No keys in ${store.dir}. Run init first.`)
  const root = Account.fromSecp256k1(keys.rootKey)
  // The agent's key acts for the business account, which is all it needs to know of the root.
  const agentKey = Account.fromSecp256k1(keys.agentKey, { access: root.address })
  return { root, agentKey }
}

function lockOf(store: BuyerStore) {
  const { lock } = store.setup()
  if (!lock) throw new Error('No lock yet. Run init first.')
  return lock
}

/** Makes the business's keys, funds the account's fees from the faucet and creates its lock. */
async function init() {
  const settings = initSettings(process.env)
  const store = new BuyerStore(settings.stateDir)
  if (!store.keys()) store.makeKeys()
  const { root } = keysOf(store)
  const client = clientFor(settings.rpcUrl)
  log(`funding the business account ${root.address} from Moderato's faucet, for fees`)
  await Actions.faucet.fundSync(client, { account: root.address, timeout: 60_000 })
  const lock = await client.readContract({
    address: settings.factory,
    abi: FACTORY_ABI,
    functionName: 'lockAddress',
    args: [root.address],
  })
  if ((await client.getCode({ address: lock })) === undefined) {
    log('creating the business lock')
    await sendOwn({
      client,
      account: root,
      calls: [createLockCall(settings.factory, root.address)],
    })
  }
  store.saveSetup({ lock })
  log(`keys are in ${settings.stateDir}/keys.json. Keep that file safe and out of version control.`)
  console.log(JSON.stringify({ account: root.address, lock }, null, 2))
  log('Send Avow the account and the lock, with the business name and country, to be registered.')
  log('On testnet Avow then sends the account test tUSD to reserve with.')
}

/**
 * Signs the agent's mandate as the administrator, puts the agent's key on the account with the
 * mandate's hash, approves the supplier on the lock, and enrolls the agent with Avow.
 */
async function enroll() {
  const settings = enrollSettings(process.env)
  const store = new BuyerStore(settings.stateDir)
  const { root, agentKey } = keysOf(store)
  const lock = lockOf(store)
  const client = clientFor(settings.rpcUrl)
  const d: AvowDomain = { chainId: TEMPO_MODERATO, verifyingContract: lock }
  let setup = store.setup()
  if (!setup.keyAuthorizedIn || !setup.mandate) {
    const supplier = await httpSupplier(settings.supplierUrl)
    const mandate = quickstartMandate({
      businessId: settings.businessId,
      agentId: settings.agentId,
      account: root.address,
      agentKey: agentKey.accessKeyAddress,
      supplier: supplier.profile,
      token: settings.token,
      reserve: settings.reserve,
      open: settings.open,
      now: BigInt(Math.floor(Date.now() / 1000)),
    })
    const signed = await signMandate(mandate, d, accountSigner(root.address, root))
    const keyAuthorization = await Account.signKeyAuthorization(root, {
      key: agentKey,
      chainId: BigInt(TEMPO_MODERATO),
      ...agentKeyTerms(mandate, d, { lock, lockSelectors: [RESERVE_SELECTOR] }),
    })
    log(`putting the agent's key on the account and approving ${supplier.profile.businessId}`)
    const receipt = await sendOwn({
      client,
      account: root,
      calls: [approveSupplierCall(lock, supplier.profile.account)],
      keyAuthorization,
    })
    setup = store.saveSetup({ mandate: toWire(signed), keyAuthorizedIn: receipt.transactionHash })
  }
  const mandate = readMandate(setup.mandate, d)
  const enrollment = await enrollAgent(
    { baseUrl: settings.apiUrl, key: agentRequestKey(agentKey) },
    { mandate, keyAuthorizedIn: setup.keyAuthorizedIn as Hex },
  )
  store.saveSetup({ enrollment: toWire(enrollment) })
  log(`Avow enrolled ${enrollment.agentId} for ${enrollment.businessId}`)
}

function readMandate(json: unknown, d: AvowDomain): Signed<Mandate> {
  const parsed = parseSigned(json, 'Mandate', mandateJson, {
    chainId: d.chainId,
    lock: d.verifyingContract,
  })
  if (!parsed.ok) throw new Error(`The saved mandate doesn't parse (${parsed.reason})`)
  return parsed.value as Signed<Mandate>
}

/** The agent books with the supplier, funds the reserve and waits for the supplier to accept. */
async function book() {
  const settings = bookSettings(process.env)
  const untilReleased = process.argv.includes('--until-released')
  const store = new BuyerStore(settings.stateDir)
  const { agentKey } = keysOf(store)
  const lock = lockOf(store)
  const client = clientFor(settings.rpcUrl)
  const d: AvowDomain = { chainId: TEMPO_MODERATO, verifyingContract: lock }
  const token: RailToken = {
    rail: 'tempo',
    chainId: TEMPO_MODERATO,
    token: settings.token,
    currency: 'USD',
    decimals: 6,
  }
  const agent = createAgent({
    client,
    key: agentKey,
    mandate: readMandate(store.setup().mandate, d),
    token,
    profile: TESTNET_DEMO_PROFILE,
    avow: httpAvowApi({ baseUrl: settings.apiUrl, key: agentRequestKey(agentKey), domain: d }),
  })
  const supplier = await httpSupplier(settings.supplierUrl)
  const now = (await client.getBlock({ blockTag: 'latest' })).timestamp
  // The booking's terms, built with the GPU reservation template the booking falls under.
  const terms = gpuReservationTerms(
    quickstartBooking({
      now,
      startsIn: settings.startsIn,
      minutes: settings.minutes,
      reserve: settings.reserve,
      arbiter: settings.arbiter,
      day90SupplierShareBps: settings.day90SupplierShareBps,
    }),
  )
  log(`booking with ${supplier.profile.businessId}`)
  let result: Awaited<ReturnType<typeof agent.book>>
  try {
    result = await agent.book({ supplier, terms, category: 'compute' })
  } catch (e) {
    if (e instanceof BookingError) {
      store.saveBooking(e.commitment.commitmentId, toWire({ ...e.commitment, outcome: e.outcome }))
    }
    throw e
  }
  if (!result.ok) throw new Error(`The booking was refused: ${result.reason}`)
  const c = result.commitment
  store.saveBooking(c.commitmentId, toWire(c))
  log(
    `reserved ${c.commitmentId}, funded in ${c.reservedIn ?? 'a transaction the agent did not send'}`,
  )

  const acceptBy = c.terms.remedies.acceptBy
  const releaseDate = c.terms.backing.releaseDate
  let last = ''
  for (;;) {
    const held = await agent.commitment(c.commitmentId).catch(() => null)
    const state = held?.state ?? 'unread'
    if (state !== last) log(`the lock shows ${c.commitmentId} as ${state}`)
    last = state
    if (state === 'accepted' && !untilReleased) return
    if (['released', 'charged', 'resolved'].includes(state)) return
    const chainNow = (await client.getBlock({ blockTag: 'latest' })).timestamp
    if (state === 'reserved' && chainNow > acceptBy + 120n) {
      throw new Error('The supplier never accepted, so Avow returns the reserve at its deadline')
    }
    if (chainNow > releaseDate + 600n)
      throw new Error('The reserve is still held past its release date')
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

function account() {
  const { stateDir } = baseSettings(process.env)
  const store = new BuyerStore(stateDir)
  const { root, agentKey } = keysOf(store)
  console.log(
    JSON.stringify(
      { account: root.address, lock: store.setup().lock, agentKey: agentKey.accessKeyAddress },
      null,
      2,
    ),
  )
}

const commands: Record<string, () => Promise<void> | void> = { init, enroll, book, account }
const command = commands[process.argv[2] ?? '']
if (!command) {
  console.error('Usage: avow-buyer init | enroll | book [--until-released] | account')
  process.exit(2)
}
Promise.resolve(command()).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
