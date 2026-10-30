#!/usr/bin/env node
import {
  type AvowResend,
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
  moderatoClient,
  moderatoUsdToken,
  RESERVE_SELECTOR,
  sendOwn,
  signMandate,
} from '@avow-finance/sdk'
import {
  type AvowDomain,
  gpuReservationTerms,
  type Mandate,
  type Signed,
  TEMPO_MODERATO,
  TESTNET_DEMO_PROFILE,
} from '@avow-finance/spec'
import type { Address } from 'viem'
import { Account, Actions } from 'viem/tempo'
import { cancelArgs, cancelBooking } from './cancel.js'
import { initBusiness } from './init.js'
import { quickstartBooking, quickstartMandate } from './plan.js'
import {
  baseSettings,
  bookSettings,
  cancelSettings,
  enrollSettings,
  initSettings,
} from './settings.js'
import { type BuyerSetup, BuyerStore } from './store.js'
import { httpSupplier } from './supplier.js'

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

function keysOf(store: BuyerStore) {
  const keys = store.keys()
  if (!keys) throw new Error(`No keys in ${store.dir}. Run init first.`)
  const root = Account.fromSecp256k1(keys.rootKey)
  // The agent's key acts for the business account, which is all it needs to know of the root.
  const agentKey = Account.fromSecp256k1(keys.agentKey, { access: root.address })
  return { root, agentKey }
}

/** Says when Avow's API gives no definite answer, so a run that keeps trying is never silent. */
const logResend = (r: AvowResend) =>
  log(`no definite answer from Avow yet (${r.message}), sending again in ${r.waitMs} ms`)

function lockOf(store: BuyerStore) {
  const { lock } = store.setup()
  if (!lock) throw new Error('No lock yet. Run init first.')
  return lock
}

/**
 * Makes the business's keys, funds the account's fees from the faucet and creates its lock. Once
 * `enroll` has saved a mandate, it keeps that mandate's lock and refuses a factory that gives
 * another one, before it asks the faucet or sends anything.
 */
async function init() {
  const settings = initSettings(process.env)
  const store = new BuyerStore(settings.stateDir)
  if (!store.keys()) store.makeKeys()
  const { root } = keysOf(store)
  const client = moderatoClient(settings.rpcUrl)
  const lock = await initBusiness({
    store,
    account: root.address,
    lockAddress: () =>
      client.readContract({
        address: settings.factory,
        abi: FACTORY_ABI,
        functionName: 'lockAddress',
        args: [root.address],
      }),
    fundFees: async () => {
      await Actions.faucet.fundSync(client, { account: root.address, timeout: 60_000 })
    },
    lockExists: async (address) => (await client.getCode({ address })) !== undefined,
    createLock: async () => {
      await sendOwn({
        client,
        account: root,
        calls: [createLockCall(settings.factory, root.address)],
      })
    },
    log,
  })
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
  const client = moderatoClient(settings.rpcUrl)
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
    setup = store.saveSetup({ mandate: signed, keyAuthorizedIn: receipt.transactionHash })
  }
  const { keyAuthorizedIn } = setup
  if (!keyAuthorizedIn) throw new Error("The agent's key isn't on the account yet")
  const enrollment = await enrollAgent(
    { baseUrl: settings.apiUrl, key: agentRequestKey(agentKey), onResend: logResend },
    { mandate: mandateOf(setup), keyAuthorizedIn },
  )
  store.saveSetup({ enrollment })
  log(`Avow enrolled ${enrollment.agentId} for ${enrollment.businessId}`)
}

/** The mandate the setup holds, which the store checked is signed for the business's lock. */
function mandateOf(setup: BuyerSetup): Signed<Mandate> {
  if (!setup.mandate) throw new Error('No mandate yet. Run enroll first.')
  return setup.mandate
}

/** The business's agent, acting under the mandate the setup holds, through Avow's hosted API. */
function agentOf(
  store: BuyerStore,
  settings: { apiUrl: string; token: Address },
  client: ReturnType<typeof moderatoClient>,
) {
  const { agentKey } = keysOf(store)
  const d: AvowDomain = { chainId: TEMPO_MODERATO, verifyingContract: lockOf(store) }
  return createAgent({
    client,
    key: agentKey,
    mandate: mandateOf(store.setup()),
    token: moderatoUsdToken(settings.token),
    profile: TESTNET_DEMO_PROFILE,
    avow: httpAvowApi({
      baseUrl: settings.apiUrl,
      key: agentRequestKey(agentKey),
      domain: d,
      onResend: logResend,
    }),
  })
}

/** The agent books with the supplier, funds the reserve and waits for the supplier to accept. */
async function book() {
  const settings = bookSettings(process.env)
  const untilReleased = process.argv.includes('--until-released')
  const store = new BuyerStore(settings.stateDir)
  const client = moderatoClient(settings.rpcUrl)
  const agent = agentOf(store, settings, client)
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
    if (e instanceof BookingError) store.saveBooking({ ...e.commitment, outcome: e.outcome })
    throw e
  }
  if (!result.ok) throw new Error(`The booking was refused: ${result.reason}`)
  const c = result.commitment
  store.saveBooking(c)
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

/**
 * Cancels a booking, the one named or the one made last. Avow records a late cancellation, and
 * before free cancellation ends the root key cancels on the lock and gets the whole reserve back.
 */
async function cancel() {
  const { commitmentId } = cancelArgs(process.argv.slice(3))
  const settings = cancelSettings(process.env)
  const store = new BuyerStore(settings.stateDir)
  const { root } = keysOf(store)
  const client = moderatoClient(settings.rpcUrl)
  await cancelBooking(
    {
      store,
      agent: agentOf(store, settings, client),
      chainTime: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
      sendFromRoot: (call) => sendOwn({ client, account: root, calls: [call] }),
      log,
    },
    commitmentId,
  )
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

const commands: Record<string, () => Promise<void> | void> = {
  init,
  enroll,
  book,
  cancel,
  account,
}
const command = commands[process.argv[2] ?? '']
if (!command) {
  console.error(
    'Usage: avow-buyer init | enroll | book [--until-released] | cancel [commitmentId] | account',
  )
  process.exit(2)
}
Promise.resolve(command()).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
