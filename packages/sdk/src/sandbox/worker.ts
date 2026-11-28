import { type AvowDomain, type ReasonCode, TESTNET_DEMO_PROFILE } from '@avow-finance/spec'
import { privateKeyToAccount } from 'viem/accounts'
import { type AgentBuyer, type BookResult, createAgent } from '../agent.js'
import { httpAvowApi } from '../http.js'
import { moderatoClient, moderatoUsdToken } from '../moderato.js'
import type { WorkerKey } from '../slices/worker-request.js'
import type { SandboxAgentOptions, SandboxBooking } from './agent.js'
import { loadSandboxDeployment, madeOn } from './deployment.js'
import { SANDBOX_SCREEN_URL } from './session.js'
import { loadWorkerItem, type SandboxStore } from './store.js'
import { connectSupplier } from './suppliers.js'
import { micros, sandboxTerms } from './terms.js'

/** A worker's booking refused before any money moved, with the reason code. */
export class WorkerBookingRefused extends Error {
  readonly code: ReasonCode
  constructor(code: ReasonCode) {
    super(`The booking was refused (${code}). No money moved.`)
    this.name = 'WorkerBookingRefused'
    this.code = code
  }
}

/**
 * A worker of a sandbox agent, booking under the slice its agent handed it. Its own key signs its
 * requests to Avow, and the agent that started it signs its agreements and funds its reserves with
 * the agent's key, through `buyer`, only inside the worker's slice. It holds no key on the
 * business account and none of the business's. In Node, `sandboxWorkerOnThisMachine` gives it the
 * agent's socket as its buyer.
 */
export async function sandboxWorker(
  options: Pick<SandboxAgentOptions, 'fetch' | 'screenUrl' | 'deployment'> & {
    /** The worker's own folder, which the agent made when it handed the slice out. */
    store: SandboxStore
    /** The buyer that asks the agent to sign for the worker, given the worker's own key. */
    buyer: (key: WorkerKey) => AgentBuyer
  },
) {
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const item = await loadWorkerItem(options.store)
  if (!item) throw new Error('This folder holds no worker. Its agent makes one with delegate.')
  const deployment =
    options.deployment ??
    (await loadSandboxDeployment(options.screenUrl ?? SANDBOX_SCREEN_URL, send))
  if (!madeOn(item.business, deployment)) {
    throw new Error('The sandbox runs a new deployment now, so the agent hands out a new slice.')
  }
  const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: item.business.lock }
  const own = privateKeyToAccount(item.workerKey)
  const avow = httpAvowApi({
    baseUrl: deployment.apiUrl,
    key: { address: own.address, signDigest: (hash) => own.sign({ hash }) },
    domain,
    retryFor: 120n,
    fetch: send,
  })
  const agent = createAgent({
    client: moderatoClient(deployment.rpcUrl),
    key: { address: item.business.account, accessKeyAddress: item.agentKey },
    buyer: options.buyer(own),
    mandate: item.mandate,
    token: moderatoUsdToken(deployment.token),
    profile: TESTNET_DEMO_PROFILE,
    avow,
  })
  return {
    /** The worker's own key, which its slice is handed to. */
    subKey: own.address,
    label: item.label,
    /**
     * Books with one of the agent's suppliers, inside the worker's slice. It resolves with the
     * commitment once the reserve is funded, and throws a `WorkerBookingRefused` when the SDK, the
     * agent's signer or Avow refuses it before any money moves.
     */
    async book(b: SandboxBooking) {
      const supplier = item.suppliers.find((s) => s.id === b.supplier)
      if (!supplier) throw new WorkerBookingRefused('mandate.supplier_not_allowed')
      const reserve = micros(b.reserve, 'reserve')
      const terms = sandboxTerms({
        deployment,
        resource: b.resource,
        reserve,
        now: BigInt(Math.floor(Date.now() / 1000)),
      })
      const booked: BookResult = await agent.book({
        supplier: await connectSupplier(supplier, send),
        terms,
        category: 'compute',
      })
      if (!booked.ok) throw new WorkerBookingRefused(booked.reason)
      return booked.commitment
    },
  }
}

export type SandboxWorker = Awaited<ReturnType<typeof sandboxWorker>>
