import {
  AGENT_LABEL_RULE,
  type AgentRequestStatus,
  accountOfSandboxId,
  agentLabelOf,
  agentLabelProblem,
  approvalHash,
  type Enrollment,
  heldAgentLabelJson,
  pairingCode,
  parseAgentRequestStatus,
  parseEnrollmentRequest,
  parseOpenAgentRequestStatus,
  type RequestKey,
  SANDBOX_PATHS,
  signingHash,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddressEqual } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import type { AgentKey } from '../agent.js'
import { AvowApiError, agentRequestKey, avowRequests, enrollAgent } from '../http.js'
import { moderatoClient } from '../moderato.js'
import { httpSupplier } from '../supplier.js'
import { type AccountLock, accountLocks } from './account-lock.js'
import { platformStore } from './agent.js'
import { loadSandboxDeployment, trustedFactoryAddresses } from './deployment.js'
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

/**
 * The console link that opens this agent's request for review, on a phone or anywhere else. It names
 * the request and grants nothing: the administrator still signs in and signs what it shows.
 */
export const approvalLink = (agentKey: Address): string =>
  `${SANDBOX_CONSOLE_URL}/${approvalHash(agentKey)}`

/**
 * The console link that opens one approval request on its signing page. Like the agent's link, it
 * names the request and grants nothing: the administrator signs in and signs what the page shows.
 */
export const approvalRequestLink = (requestId: string): string =>
  `${SANDBOX_CONSOLE_URL}/${signingHash(requestId)}`

/** What happens while an agent waits for its business to answer. */
export type ConnectEvent =
  /** The agent asked, naming its business, or null when it asked before knowing it, and the name it asked under. */
  | {
      type: 'asked'
      businessId: string | null
      agentKey: Address
      pairingCode: string
      label: string
    }
  | { type: 'waiting'; expiresAt: bigint }
  /** A request that named no business was approved for this one. */
  | { type: 'bound'; businessId: string }
  | { type: 'approved'; agentId: string }
  | { type: 'enrolled'; enrollment: Enrollment }
  | { type: 'supplier'; signingKey: Address }

export interface ConnectOptions {
  /**
   * The business the agent works for, as its console shows it. Left out, the agent asks without
   * one, and the person who opens its link signs in or sets up a business there and approves.
   */
  businessId?: string
  /**
   * The name the administrator sees, such as "Research agent". It's trimmed, and refused before
   * anything is sent unless it holds to `AGENT_LABEL_RULE`, except when it's the name this folder's
   * waiting request was saved with, so a request an earlier version made can still be resumed.
   */
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
  /** The business it asked, or null for a request that named none and isn't bound yet. */
  businessId: string | null
  /** The name the agent asked under, so asking again after a restart keeps it. */
  label?: string
  /** The signing key an agent that sells made, kept with its request. */
  signingKey?: Hex
}

async function loadRequestItem(store: SandboxStore): Promise<RequestItem | null> {
  const text = await store.read('request')
  if (text === null) return null
  const json = readJson(text, 'request')
  return typeof json.agentKey === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(json.agentKey) &&
    (typeof json.businessId === 'string' || json.businessId === null)
    ? {
        agentKey: json.agentKey as Hex,
        businessId: json.businessId,
        ...(typeof json.label === 'string' ? { label: json.label } : {}),
        ...(typeof json.signingKey === 'string' && /^0x[0-9a-fA-F]{64}$/.test(json.signingKey)
          ? { signingKey: json.signingKey as Hex }
          : {}),
      }
    : null
}

/**
 * The business this folder's agent last asked for authority, and the name it asked under, while it
 * has no agent item yet. It gives nothing of the agent's key.
 */
export async function savedRequest(
  store: SandboxStore,
): Promise<{ businessId: string | null; label: string | null; sell: boolean } | null> {
  const r = await loadRequestItem(store)
  return r
    ? { businessId: r.businessId, label: r.label ?? null, sell: r.signingKey !== undefined }
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

/** The agent's key as the signer of its open request, which names no account yet. */
function openRequestKey(keyHex: Hex): RequestKey {
  const key = privateKeyToAccount(keyHex)
  return { address: key.address, signDigest: (hash) => key.sign({ hash }) }
}

/**
 * Asks Avow, under the factory, for authority from whichever business approves this key, and asks
 * again until an approval binds the request to one. It answers with that business's id. Avow starts
 * the request afresh when an ask comes after it lapsed, so waiting longer needs nothing more.
 */
async function waitToBeBound(o: {
  deployment: Awaited<ReturnType<typeof loadSandboxDeployment>>
  keyHex: Hex
  label: string
  signingKey: Address | undefined
  send: typeof fetch
  onEvent: ConnectOptions['onEvent']
  pollEvery: number | undefined
  signal: AbortSignal | undefined
}): Promise<string> {
  const ask = avowRequests({
    baseUrl: o.deployment.apiUrl,
    key: openRequestKey(o.keyHex),
    retryFor: 60n,
    fetch: o.send,
  })
  for (;;) {
    const status = await ask({
      domain: { chainId: o.deployment.chainId, verifyingContract: o.deployment.factory },
      path: SANDBOX_PATHS.openAgentRequests,
      body: { label: o.label, ...(o.signingKey ? { signingKey: o.signingKey } : {}) },
      read: (json) => {
        const read = parseOpenAgentRequestStatus(json)
        return read ? { ok: true, value: read } : { ok: false, reason: 'message.invalid' }
      },
    })
    if (status.state === 'bound') return status.businessId
    o.onEvent?.({ type: 'waiting', expiresAt: BigInt(status.expiresAt) })
    await pause(o.pollEvery ?? 5000, o.signal)
  }
}

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
  const waiting = await loadRequestItem(store)
  const asked = o.businessId ?? null
  const same = waiting?.businessId === asked ? waiting : null
  // A request saved with a name from before the rule for new names keeps it, since Avow already
  // holds the request under that name for this key, and asking again changes nothing it shows.
  // It still has to be one Avow reads back, under the rule it was first asked under.
  const resumed = same?.label !== undefined && same.label.trim() === o.label.trim()
  const savedLabel = resumed ? heldAgentLabelJson.safeParse(o.label) : null
  const label = savedLabel?.success ? savedLabel.data : agentLabelOf(o.label)
  if (label === null) {
    throw new RangeError(
      `The name can't be used, since ${agentLabelProblem(o.label) ?? "it isn't plain text"}. ${AGENT_LABEL_RULE}.`,
    )
  }
  const deployment = await loadSandboxDeployment(o.screenUrl ?? SANDBOX_SCREEN_URL, send)

  const keyHex = same?.agentKey ?? generatePrivateKey()
  const signingHex = o.sell ? (same?.signingKey ?? generatePrivateKey()) : undefined
  const signing = signingHex ? privateKeyToAccount(signingHex) : null
  const remember = (businessId: string | null) =>
    write(store, 'request', {
      agentKey: keyHex,
      businessId,
      label,
      ...(signingHex ? { signingKey: signingHex } : {}),
    } satisfies RequestItem)
  await remember(asked)
  const keyAddress = privateKeyToAccount(keyHex).address
  o.onEvent?.({
    type: 'asked',
    businessId: asked,
    agentKey: keyAddress,
    pairingCode: pairingCode(keyAddress),
    label,
  })

  // With no business named, the agent waits until an administrator's approval binds its request
  // to their business, and then asks that business as any agent does, with the same key.
  const businessId =
    asked ??
    (await waitToBeBound({
      deployment,
      keyHex,
      label,
      signingKey: signing?.address,
      send,
      onEvent: o.onEvent,
      pollEvery: o.pollEvery,
      signal: o.signal,
    }))
  if (asked === null) {
    await remember(businessId)
    o.onEvent?.({ type: 'bound', businessId })
  }

  // The business's account from its id. Anyone can create an account's lock at any factory, so
  // the account may have one at more than one trusted factory, and Avow, which holds the business
  // at one of them, refuses the ask at any other. The first lock Avow takes the ask at is the
  // business's.
  const account = accountOfSandboxId(businessId)
  const unknown = `Avow has no sandbox business ${businessId}. Copy its ID from the console.`
  if (!account) throw new Error(unknown)
  const client = moderatoClient(deployment.rpcUrl)
  const agentKey: AgentKey = Account.fromSecp256k1(keyHex, { access: account })

  const config = {
    baseUrl: deployment.apiUrl,
    key: agentRequestKey(agentKey),
    retryFor: 60n,
    fetch: send,
  }
  const ask = avowRequests(config)
  const askAt = (lock: Address) =>
    ask({
      domain: { chainId: deployment.chainId, verifyingContract: lock },
      path: SANDBOX_PATHS.agentRequests,
      body: {
        businessId,
        label,
        ...(signing ? { signingKey: signing.address } : {}),
      },
      read: (json) => {
        const read = parseAgentRequestStatus(json)
        return read ? { ok: true, value: read } : { ok: false, reason: 'message.invalid' }
      },
    })
  const notHeld = (error: unknown) =>
    error instanceof AvowApiError && error.reason === 'business.unknown'

  let held: { at: AccountLock; status: AgentRequestStatus } | null = null
  const factories = trustedFactoryAddresses(deployment.chainId)
  for (const at of await accountLocks({ client, factories, account })) {
    const status = await askAt(at.lock).catch((error: unknown) => {
      if (notHeld(error)) return null
      throw error
    })
    if (status) {
      held = { at, status }
      break
    }
  }
  if (!held) throw new Error(unknown)
  const { lock, factory } = held.at
  let status = held.status
  while (status.state !== 'approved') {
    // Asking again after a lapse starts afresh, so a request that still reads as lapsed is one the
    // business declined, and asking again won't change that for a while.
    if (status.state === 'expired') {
      throw new Error(
        `${businessId} declined this agent's request, or it lapsed. Ask the business's administrator before connecting again.`,
      )
    }
    o.onEvent?.({ type: 'waiting', expiresAt: BigInt(status.expiresAt) })
    await pause(o.pollEvery ?? 5000, o.signal)
    status = await askAt(lock).catch((error: unknown) => {
      if (!notHeld(error)) throw error
      throw new Error(
        `Avow no longer holds the request for ${businessId}, so the business or its request went away. Connect again to ask afresh.`,
      )
    })
  }

  const approval = parseEnrollmentRequest(status.approval, { chainId: deployment.chainId, lock })
  if (!approval.ok) throw new Error(`The approval Avow holds isn't a mandate: ${approval.reason}`)
  const m = approval.value.mandate.message
  if (!isAddressEqual(m.agentKey, agentKey.accessKeyAddress) || m.businessId !== businessId) {
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
    factory,
    token: deployment.token,
    account,
    lock,
    businessId,
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
