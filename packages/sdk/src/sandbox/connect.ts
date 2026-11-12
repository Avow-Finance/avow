import {
  type AgentRequestStatus,
  accountOfSandboxId,
  type Enrollment,
  pairingCode,
  parseAgentRequestStatus,
  parseEnrollmentRequest,
  SANDBOX_PATHS,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import type { AgentKey } from '../agent.js'
import { AvowApiError, agentRequestKey, avowRequests, enrollAgent } from '../http.js'
import { FACTORY_ABI } from '../lock.js'
import { moderatoClient } from '../moderato.js'
import { httpSupplier } from '../supplier.js'
import { platformStore } from './agent.js'
import { loadSandboxDeployment } from './deployment.js'
import { SANDBOX_SCREEN_URL } from './session.js'
import {
  type AgentItem,
  loadAgentItem,
  readJson,
  type SandboxStore,
  type StoredBusiness,
  saveAgentItem,
  write,
} from './store.js'
import { completeSupplierRegistration } from './supplier-key.js'

/** Where a business's administrator approves an agent on the testnet. */
export const SANDBOX_CONSOLE_URL = 'https://testnet.avow.finance'

/** What happens while an agent waits for its business to answer. */
export type ConnectEvent =
  | { type: 'asked'; businessId: string; agentKey: Address; pairingCode: string }
  | { type: 'waiting'; expiresAt: bigint }
  | { type: 'approved'; agentId: string }
  | { type: 'enrolled'; enrollment: Enrollment }
  | { type: 'supplier'; signingKey: Address }

export interface ConnectOptions {
  /** The business the agent works for, as its console shows it. */
  businessId: string
  /** The name the administrator sees, such as "Research agent". */
  label: string
  /**
   * Whether the agent sells as well as buys. It then makes a signing key of its own to quote and
   * accept jobs with, and once approved registers it as the business's supplier key.
   */
  sell?: boolean
  /** Where the agent's key and mandate are kept. In Node it's the working directory's `.avow`. */
  store?: SandboxStore
  screenUrl?: string
  fetch?: typeof fetch
  /** Hears each step, so a terminal can print the pairing code and what it's waiting for. */
  onEvent?: (event: ConnectEvent) => void
  /** Milliseconds between asks while the request waits, five seconds by default. */
  pollEvery?: number
  /** Stops waiting. The request stays with Avow until it lapses, and asking again resumes it. */
  signal?: AbortSignal
}

/** The agent's waiting request, kept so asking again after a restart uses the same key. */
interface RequestItem {
  agentKey: Hex
  businessId: string
  /** The signing key an agent that sells made, kept with its request. */
  signingKey?: Hex
}

async function loadRequestItem(store: SandboxStore): Promise<RequestItem | null> {
  const text = await store.read('request')
  if (text === null) return null
  const json = readJson(text, 'request')
  return typeof json.agentKey === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(json.agentKey) &&
    typeof json.businessId === 'string'
    ? {
        agentKey: json.agentKey as Hex,
        businessId: json.businessId,
        ...(typeof json.signingKey === 'string' && /^0x[0-9a-fA-F]{64}$/.test(json.signingKey)
          ? { signingKey: json.signingKey as Hex }
          : {}),
      }
    : null
}

/** Waits `ms`, or rejects with the signal's reason once it aborts. */
export const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

/**
 * Connects this agent to a business the way any agent connects, with no business key on this
 * machine. It makes the agent's own key and keeps it in the store, asks the business for authority
 * with a request signed by that key, and waits. The administrator approves it in the console,
 * which signs the agent's mandate and puts its key on the account with the passkey. The agent then
 * enrolls with that approval, and keeps its key and mandate as the agent item every SDK and MCP
 * call reads.
 *
 * It refuses when the store already holds an agent, and gives back the agent item once enrolled.
 */
export async function connectToBusiness(o: ConnectOptions): Promise<AgentItem> {
  const send = o.fetch ?? ((input, init) => fetch(input, init))
  const store = o.store ?? platformStore()
  if (!store) throw new Error('Pass a store to keep the agent key in, outside Node.')
  if (await loadAgentItem(store)) {
    throw new Error('This folder already has an agent. Connect a new agent from a fresh folder.')
  }
  const deployment = await loadSandboxDeployment(o.screenUrl ?? SANDBOX_SCREEN_URL, send)

  // The business's account from its id, and its lock from the factory on chain. Avow refuses the
  // ask for a business it doesn't hold at that lock.
  const account = accountOfSandboxId(o.businessId)
  const unknown = `Avow has no sandbox business ${o.businessId}. Copy its ID from the console.`
  if (!account) throw new Error(unknown)
  const client = moderatoClient(deployment.rpcUrl)
  const lock: Address = await client.readContract({
    address: deployment.factory,
    abi: FACTORY_ABI,
    functionName: 'lockAddress',
    args: [account],
  })

  const waiting = await loadRequestItem(store)
  const same = waiting?.businessId === o.businessId ? waiting : null
  const keyHex = same?.agentKey ?? generatePrivateKey()
  const signingHex = o.sell ? (same?.signingKey ?? generatePrivateKey()) : undefined
  await write(store, 'request', {
    agentKey: keyHex,
    businessId: o.businessId,
    ...(signingHex ? { signingKey: signingHex } : {}),
  } satisfies RequestItem)
  const signing = signingHex ? privateKeyToAccount(signingHex) : null
  const agentKey: AgentKey = Account.fromSecp256k1(keyHex, { access: account })
  const code = pairingCode(agentKey.accessKeyAddress)
  o.onEvent?.({
    type: 'asked',
    businessId: o.businessId,
    agentKey: agentKey.accessKeyAddress,
    pairingCode: code,
  })

  const config = {
    baseUrl: deployment.apiUrl,
    key: agentRequestKey(agentKey),
    retryFor: 60n,
    fetch: send,
  }
  const ask = avowRequests(config)
  const domain = { chainId: deployment.chainId, verifyingContract: lock }
  let status: AgentRequestStatus
  for (;;) {
    status = await ask({
      domain,
      path: SANDBOX_PATHS.agentRequests,
      body: {
        businessId: o.businessId,
        label: o.label,
        ...(signing ? { signingKey: signing.address } : {}),
      },
      read: (json) => {
        const read = parseAgentRequestStatus(json)
        return read ? { ok: true, value: read } : { ok: false, reason: 'message.invalid' }
      },
    }).catch((error: unknown) => {
      if (error instanceof AvowApiError && error.reason === 'business.unknown') {
        throw new Error(unknown)
      }
      throw error
    })
    if (status.state === 'approved') break
    o.onEvent?.({ type: 'waiting', expiresAt: BigInt(status.expiresAt) })
    await pause(o.pollEvery ?? 5000, o.signal)
  }

  const approval = parseEnrollmentRequest(status.approval, { chainId: deployment.chainId, lock })
  if (!approval.ok) throw new Error(`The approval Avow holds isn't a mandate: ${approval.reason}`)
  const m = approval.value.mandate.message
  if (!isAddressEqual(m.agentKey, agentKey.accessKeyAddress) || m.businessId !== o.businessId) {
    throw new Error("The approval names another agent or business, so this agent won't use it.")
  }
  o.onEvent?.({ type: 'approved', agentId: m.agentId })
  const enrollment = await enrollAgent({ ...config, retryFor: 180n }, approval.value)
  o.onEvent?.({ type: 'enrolled', enrollment })

  // The suppliers the mandate allows that this deployment can reach, which is its demo supplier.
  const demo = await httpSupplier(deployment.supplierUrl, send).catch(() => null)
  const suppliers =
    demo && m.suppliers.includes(demo.profile.businessId)
      ? [{ id: demo.profile.businessId, url: deployment.supplierUrl }]
      : []

  const business: StoredBusiness = {
    chainId: deployment.chainId,
    apiUrl: deployment.apiUrl,
    factory: deployment.factory,
    token: deployment.token,
    account,
    lock,
    businessId: o.businessId,
  }
  const item: AgentItem = {
    agentKey: keyHex,
    business,
    mandate: approval.value.mandate,
    mandateHash: enrollment.mandateHash,
    keyAuthorizedIn: approval.value.keyAuthorizedIn,
    suppliers,
  }
  await saveAgentItem(store, item)

  // An agent that sells completes its signing key's registration, which the account signed.
  if (signingHex) {
    if (!status.supplierRegistration) {
      throw new Error(
        'The administrator approved this agent to buy only. Connect again without selling, or ask them to approve selling.',
      )
    }
    const supplier = await completeSupplierRegistration({
      store,
      deployment,
      business,
      client,
      signingKey: signingHex,
      partial: status.supplierRegistration,
      fetch: send,
    })
    o.onEvent?.({ type: 'supplier', signingKey: supplier.profile.signingKey })
  }
  return item
}
