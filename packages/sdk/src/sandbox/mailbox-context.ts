import {
  type JobBuyer,
  type SandboxDeployment,
  type SupplierProfile,
  TESTNET_DEMO_PROFILE,
} from '@avow-finance/spec'
import { type ChainReader, type LockedBacking, readBacking } from '@avow-finance/verifier'
import { type Address, type Hex, parseAbi } from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { type AgentKey, createAgent, type QuoteResult, type SignedQuote } from '../agent.js'
import {
  AvowApiError,
  agentRequestKey,
  avowRequests,
  httpAvowApi,
  requestSupplierAuthorization,
  signingRequestKey,
} from '../http.js'
import { type AcceptableQuote, acceptJob } from '../job/accept.js'
import { moderatoClient, moderatoUsdToken } from '../moderato.js'
import { sendOwn, sendSponsored } from '../send.js'
import { platformStore } from './agent.js'
import { pause } from './connect.js'
import { loadSandboxDeployment } from './deployment.js'
import { fundFees } from './fees.js'
import { SANDBOX_SCREEN_URL } from './session.js'
import { type AgentItem, loadAgentItem, type SandboxStore } from './store.js'
import { loadSupplierItem, type SupplierItem } from './supplier-key.js'
import { sandboxSupplierProfile } from './supplier-profile.js'
import { trustedChainReader, trustedLockReaders } from './trusted-readers.js'

/**
 * What every kind of order through the sandbox mailbox needs from the agent in a folder: its keys,
 * its business, the deployment, and the three things each kind does the same way. A buyer funds a
 * quote under its mandate, tells the mailbox its reserve landed, and a supplier accepts on the
 * buyer's lock with its own signing key. A job order and a service order differ in what they carry
 * and check, and share all of this.
 */

const APPROVAL_KEY_ABI = parseAbi(['function approvalKey() view returns (address)'])
export const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

export interface MailboxOptions {
  store?: SandboxStore
  screenUrl?: string
  fetch?: typeof fetch
}

type Requests = ReturnType<typeof avowRequests>

export interface MailboxContext {
  send: typeof fetch
  store: SandboxStore
  item: AgentItem
  deployment: SandboxDeployment
  domain: { chainId: number; verifyingContract: Address }
  /** Sends Avow a request the agent's key signs. */
  asAgent: Requests
  /** A sandbox supplier as Avow registered it. */
  supplierProfile(businessId: string): Promise<SupplierProfile>
  /** What the business's own lock holds for a commitment it made, or null when it holds nothing. */
  held(commitmentId: Hex): Promise<LockedBacking | null>
  /** Commits to a supplier's signed quote under the agent's mandate, and funds its reserve. */
  commit(quote: SignedQuote): Promise<QuoteResult>
  /**
   * Tells the mailbox a reserve landed, and answers with the order as the mailbox then holds it.
   * A node that lags can hide a reserve that landed for a few seconds, so Avow is asked again.
   */
  reportReserved<Order>(
    path: string,
    fundedIn: Hex | null,
    read: (json: unknown) => { ok: true; value: Order } | { ok: false; reason: 'message.invalid' },
    signal?: AbortSignal,
  ): Promise<Order>
  /** The supplier's side of the folder, which throws when the agent was connected without `--sell`. */
  needSupplier(): { asSupplier: Requests; signing: PrivateKeyAccount; supplier: SupplierItem }
  /**
   * Accepts a buyer's funded commitment on the buyer's lock, with the supplier's own signing key,
   * after Avow authorizes it and the verifier's checks pass. It answers with the acceptance's
   * transaction, or null when an earlier run's acceptance was already on the lock. A refusal throws.
   */
  accept(customer: JobBuyer, quote: AcceptableQuote): Promise<Hex | null>
}

export async function mailboxContext(o: MailboxOptions = {}): Promise<MailboxContext> {
  const send = o.fetch ?? ((input, init) => fetch(input, init))
  const maybeStore = o.store ?? platformStore()
  if (!maybeStore) throw new Error('Pass a store, outside Node.')
  const store: SandboxStore = maybeStore
  const found = await loadAgentItem(store)
  if (!found) throw new Error('This folder has no agent. Run avow-sandbox connect first.')
  const item: AgentItem = found
  const deployment: SandboxDeployment = await loadSandboxDeployment(
    o.screenUrl ?? SANDBOX_SCREEN_URL,
    send,
  )
  const client = moderatoClient(deployment.rpcUrl)
  const { business } = item
  const agentKey: AgentKey = Account.fromSecp256k1(item.agentKey, { access: business.account })
  const domain = { chainId: deployment.chainId, verifyingContract: business.lock }
  // An upstream booking can sit in a lock from any factory the SDK trusts.
  const lockReaders = trustedLockReaders(client, deployment.chainId)
  // The deployment names a trusted factory, so the chain has a trusted reader.
  const trustedReader = trustedChainReader(client, deployment.chainId)
  if (!trustedReader) throw new Error(`The SDK trusts no factory on chain ${deployment.chainId}`)
  const trustedChain: ChainReader = trustedReader
  const asAgent = avowRequests({
    baseUrl: deployment.apiUrl,
    key: agentRequestKey(agentKey),
    retryFor: 120n,
    fetch: send,
  })

  async function supplierProfile(businessId: string): Promise<SupplierProfile> {
    const profile = await sandboxSupplierProfile(deployment.apiUrl, businessId, send)
    if (!profile) throw new Error(`Avow has no sandbox supplier ${businessId}`)
    return profile
  }

  function commit(quote: SignedQuote): Promise<QuoteResult> {
    const avow = httpAvowApi({
      baseUrl: deployment.apiUrl,
      key: agentRequestKey(agentKey),
      domain,
      retryFor: 120n,
      fetch: send,
    })
    return createAgent({
      client,
      key: agentKey,
      mandate: item.mandate,
      token: moderatoUsdToken(deployment.token),
      profile: TESTNET_DEMO_PROFILE,
      avow,
      send: async (calls) => {
        const receipt = await sendSponsored({
          client,
          account: agentKey,
          calls,
          sponsor: (transaction) => avow.sponsor(transaction),
        })
        return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber }
      },
      dependencies: { readers: lockReaders },
    }).commitToQuote(quote)
  }

  async function reportReserved<Order>(
    path: string,
    fundedIn: Hex | null,
    read: (json: unknown) => { ok: true; value: Order } | { ok: false; reason: 'message.invalid' },
    signal?: AbortSignal,
  ): Promise<Order> {
    for (let tries = 0; ; tries++) {
      try {
        return await asAgent({ domain, path, body: { fundedIn }, read })
      } catch (error) {
        const lagging = error instanceof AvowApiError && error.reason === 'chain.reserve_missing'
        if (!lagging || tries >= 12) throw error
        await pause(5000, signal)
      }
    }
  }

  // The supplier's side.

  const supplierItem = await loadSupplierItem(store)
  const signing = supplierItem ? privateKeyToAccount(supplierItem.signingKey) : null
  const asSupplier = signing
    ? avowRequests({
        baseUrl: deployment.apiUrl,
        key: signingRequestKey(signing),
        retryFor: 120n,
        fetch: send,
      })
    : null
  const needSupplier = () => {
    if (!asSupplier || !signing || !supplierItem) {
      throw new Error('This agent has no signing key to sell with. Connect it with --sell.')
    }
    return { asSupplier, signing, supplier: supplierItem }
  }

  async function accept(customer: JobBuyer, quote: AcceptableQuote): Promise<Hex | null> {
    const { signing, supplier } = needSupplier()
    const approvalKey = await client.readContract({
      address: customer.lock,
      abi: APPROVAL_KEY_ABI,
      functionName: 'approvalKey',
    })
    await fundFees(client, signing.address)
    const sender = Account.fromSecp256k1(supplier.signingKey)
    const accepted = await acceptJob(
      {
        config: {
          chainId: deployment.chainId,
          avowKeys: [approvalKey as Address],
          businessId: supplier.profile.businessId,
          payee: supplier.profile.payee,
          acceptedTokens: [moderatoUsdToken(deployment.token)],
          profile: TESTNET_DEMO_PROFILE,
          acceptTestData: true,
          account: supplier.profile.account,
          signingKey: supplier.profile.signingKey,
        },
        // A buyer's lock can come from any factory the SDK trusts.
        chain: trustedChain,
        dependencies: { readers: lockReaders },
        authorize: (commitment) =>
          requestSupplierAuthorization(
            { baseUrl: deployment.apiUrl, key: signingRequestKey(signing), fetch: send },
            commitment,
          ),
        signingKey: signing,
        send: async (call) => {
          const receipt = await sendOwn({ client, account: sender, calls: [call] })
          return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber }
        },
        now: systemClock,
      },
      { customer, quote },
    )
    if (!accepted.ok) throw new Error(`The acceptance was refused: ${accepted.code}`)
    return accepted.sent?.landed.transactionHash ?? null
  }

  return {
    send,
    store,
    item,
    deployment,
    domain,
    asAgent,
    supplierProfile,
    held: (commitmentId) => readBacking(client, business.lock, commitmentId, 'buyer'),
    commit,
    reportReserved,
    needSupplier,
    accept,
  }
}

/** What waiting on an order reads of it, whichever kind of order it is. */
type Staged = { orderId: string } & (
  | { status: 'requested' | 'expired' | 'quoted' }
  | { status: 'reserved'; reserve: { acceptBy: bigint } }
  | { status: 'accepted'; acceptedIn: Hex | null }
)

/**
 * Waits for the supplier to accept a funded order, under the lock's rules, reading the order again
 * every so often. Past the lock's deadline the reserve goes back, and the wait ends as missed.
 */
export async function awaitAccepted<Order extends Staged>(
  from: Order,
  read: (orderId: string) => Promise<Order>,
  every: number,
  signal?: AbortSignal,
): Promise<
  | { ok: true; order: Order; acceptedIn: Hex | null }
  | { ok: false; reason: 'acceptance.missed' | 'message.invalid'; order: Order }
> {
  let current = from
  const acceptBy = current.status === 'reserved' ? current.reserve.acceptBy : 0n
  while (current.status === 'reserved') {
    if (systemClock() > acceptBy) return { ok: false, reason: 'acceptance.missed', order: current }
    await pause(every, signal)
    current = await read(current.orderId)
  }
  if (current.status !== 'accepted') return { ok: false, reason: 'message.invalid', order: current }
  return { ok: true, order: current, acceptedIn: current.acceptedIn }
}

/**
 * Reads an inbox every few seconds and takes each order's next step, until the signal stops it. An
 * order the handler declines is left to lapse, and a step that throws goes to `onError` and is
 * tried again on the next read. Nothing wakes this when it isn't running.
 */
export async function listenFor<Order extends Staged, Step>(p: {
  inbox: () => Promise<Order[]>
  sell: (order: Order, onStep: (step: Step) => void) => Promise<void>
  accept?: ((order: Order) => boolean | Promise<boolean>) | undefined
  onStep?: ((order: Order, step: Step) => void) | undefined
  onError?: ((order: Order, error: unknown) => void) | undefined
  every?: number | undefined
  signal?: AbortSignal | undefined
}): Promise<void> {
  for (;;) {
    if (p.signal?.aborted) return
    const orders = await p.inbox().catch(() => [])
    for (const order of orders) {
      if (order.status === 'requested' && p.accept && !(await p.accept(order))) continue
      await p
        .sell(order, (step) => p.onStep?.(order, step))
        .catch((error: unknown) => p.onError?.(order, error))
    }
    await pause(p.every ?? 5000, p.signal).catch(() => {})
  }
}
