import {
  type AuthorityLimits,
  type Mandate,
  type MandateChain,
  mandateChainProblem,
  type Signed,
  type Slice,
  type SliceChain,
  TESTNET_DEMO_PROFILE,
  tempoKeychainCheck,
  type WorkerSlicesAnswer,
} from '@avow-finance/spec'
import { type Address, type Hex, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createAgent } from '../agent.js'
import { AvowApiError, agentRequestKey, httpAvowApi } from '../http.js'
import { moderatoClient, moderatoUsdToken } from '../moderato.js'
import { sendSponsored } from '../send.js'
import { sliceApi } from '../slices/client.js'
import { handOutSlice, narrowSlice, revokeWorker } from '../slices/hand-out.js'
import { createParentSigner, type ParentSigner } from '../slices/parent-signer.js'
import { agentContext, type SandboxAgentOptions } from './agent.js'
import { heldMandates } from './mandates.js'
import { loadWorkerItem, type SandboxStore, saveWorkerItem } from './store.js'
import { micros } from './terms.js'

/** Where an agent keeps its workers' folders, one store for each worker by its id. */
export interface WorkerFolders {
  store(id: string): SandboxStore
  ids(): Promise<string[]>
}

/** What an agent asks to hand a worker, in dollars and days, each left out to keep the agent's own. */
export interface WorkerLimitsAsk {
  /** The most one commitment may reserve. */
  perCommitment?: number
  /** The most the worker and the workers below it may hold at once. */
  atOnce?: number
  /** The suppliers the worker may commit to, from the agent's own. */
  suppliers?: readonly string[]
  /** How many days the slice lasts, never past the agent's mandate. */
  days?: number
}

/**
 * A worker's limits from what an agent asks, each one the agent's own mandate's unless asked
 * narrower. `handOutSlice` refuses anything wider, so asking for more than the agent holds refuses
 * the slice and signs nothing.
 */
export function workerLimits(mandate: Mandate, ask: WorkerLimitsAsk, now: bigint): AuthorityLimits {
  const expiry =
    ask.days === undefined
      ? mandate.expiry
      : (() => {
          const end = now + BigInt(Math.round(ask.days * 86_400))
          return end < mandate.expiry ? end : mandate.expiry
        })()
  return {
    actions: mandate.actions,
    currency: mandate.currency,
    capPerCommitment:
      ask.perCommitment === undefined
        ? mandate.capPerCommitment
        : micros(ask.perCommitment, 'the most per commitment'),
    capOpenReserves:
      ask.atOnce === undefined ? mandate.capOpenReserves : micros(ask.atOnce, 'the most at once'),
    ...(mandate.priceCapPerCommitment === undefined
      ? {}
      : { priceCapPerCommitment: mandate.priceCapPerCommitment }),
    suppliers: ask.suppliers ?? mandate.suppliers,
    categories: mandate.categories,
    paymentLimits: mandate.paymentLimits,
    approvalRule: mandate.approvalRule,
    expiry,
  }
}

/** One worker as the agent knows it: its folder's id, its label and key, and what Avow holds. */
export interface DelegatedWorker {
  id: string
  label: string | null
  subKey: Address
  /** The worker's slices and holdings as Avow serves them, or why they couldn't be read. */
  held: { ok: true; answer: WorkerSlicesAnswer } | { ok: false; problem: string }
}

const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

/**
 * The agent's side of its workers: handing out, narrowing and ending slices, listing them, and the
 * signer that signs with the agent's key for a worker inside its live slice. Every Avow request is
 * signed by the agent's own key, and a worker's key is made and kept in the worker's own folder
 * under the agent's, on this machine, and never leaves it.
 */
export async function agentDelegation(
  options: Pick<SandboxAgentOptions, 'fetch' | 'store' | 'screenUrl' | 'deployment'> & {
    workers: WorkerFolders
    now?: () => bigint
  },
) {
  const { send, item, deployment, agentKey, domain } = await agentContext(options)
  const now = options.now ?? systemClock
  const client = moderatoClient(deployment.rpcUrl)
  const token = moderatoUsdToken(deployment.token)
  const agentReq = agentRequestKey(agentKey)
  const api = sliceApi({ baseUrl: deployment.apiUrl, domain, fetch: send })
  const avow = httpAvowApi({ baseUrl: deployment.apiUrl, key: agentReq, domain, fetch: send })
  const isAccountSignature = tempoKeychainCheck(client)

  /** The agent's mandates as Avow serves them, or the one it enrolled with where Avow serves none. */
  async function mandates(): Promise<MandateChain> {
    const held = await heldMandates({
      apiUrl: deployment.apiUrl,
      client,
      agentKey,
      account: item.business.account,
      keyAuthorizedIn: item.keyAuthorizedIn,
      domain,
      send,
      isAccountSignature,
    })
    if (held) return held
    const own = mandateChainProblem(
      { current: item.mandate, earlier: [] },
      { domain, agentKey: agentKey.accessKeyAddress, witness: item.mandateHash },
    )
    if (!own.ok) throw new Error(`The agent's own mandate doesn't check (${own.reason})`)
    return own.value
  }

  const read = (subKey: Address, excluding: Hex | null = null) =>
    api.read(agentReq, subKey, excluding).catch((error: unknown) => {
      if (error instanceof AvowApiError && error.definite && error.status === 404) return null
      throw error
    })
  const workerOf = (chain: SliceChain) => {
    const last = chain.levels[chain.levels.length - 1]
    if (!last) throw new Error('A chain of slices has at least one level')
    return last.slice.subKey
  }
  // The agent's own funding, which `reconcile` reads the lock with after a send that failed.
  const ownAgent = createAgent({
    client,
    key: agentKey,
    mandate: item.mandate,
    token,
    profile: TESTNET_DEMO_PROFILE,
    avow,
  })

  const signer: ParentSigner = createParentSigner({
    key: agentKey,
    domain,
    token,
    profile: TESTNET_DEMO_PROFILE,
    now,
    mandates,
    workerSlices: async (subKey) => (await read(subKey))?.slices ?? null,
    holdings: async (chain, excluding) => {
      const answer = await read(workerOf(chain), excluding)
      if (!answer) throw new Error("Avow holds no slices for the worker it's counting")
      return answer.holdings
    },
    isAccountSignature,
    send: async (calls) => {
      const receipt = await sendSponsored({
        client,
        account: agentKey,
        calls,
        sponsor: (transaction) => avow.sponsor(transaction),
      })
      return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber }
    },
    reconcile: (approval, hashes) =>
      ownAgent.reconcile({ commitmentId: approval.message.commitmentId, approval }, hashes),
  })

  /** The worker a folder holds, or an error naming the id. */
  async function workerIn(id: string) {
    const held = await loadWorkerItem(options.workers.store(id))
    if (!held) throw new Error(`No worker has the id ${id}`)
    return { held, subKey: privateKeyToAccount(held.workerKey).address }
  }

  return {
    signer,
    /** The chain and lock every slice and request names. */
    where: { chainId: domain.chainId, lock: domain.verifyingContract },
    /**
     * Hands a new worker a slice of the agent's mandate. It makes the worker's key in the worker's
     * own folder, signs the slice with the agent's key once it's no wider than the mandate, and
     * posts it to Avow, which takes it only once it fits. Nothing is kept when Avow refuses it.
     */
    async delegate(ask: WorkerLimitsAsk & { label?: string | null }) {
      const chain = await mandates()
      const mandate = chain.current.proof.message
      const workerKey = generatePrivateKey()
      const subKey = privateKeyToAccount(workerKey).address
      const slice = await handOutSlice({
        issuer: agentReq,
        domain,
        mandate: { message: mandate, hash: chain.current.hash },
        parent: null,
        subKey,
        limits: workerLimits(mandate, ask, now()),
      })
      const answer = await api.post(agentReq, slice)
      const id = toHex(crypto.getRandomValues(new Uint8Array(6))).slice(2)
      await saveWorkerItem(options.workers.store(id), {
        workerKey,
        business: item.business,
        agentKey: agentKey.accessKeyAddress,
        mandate: chain.current.proof,
        sliceId: slice.message.sliceId,
        label: ask.label ?? null,
        suppliers: item.suppliers,
      })
      return { id, subKey, slice, answer }
    },
    /** Narrows a worker's slice. Wider limits are refused before anything is signed. */
    async narrow(id: string, ask: WorkerLimitsAsk) {
      const { subKey } = await workerIn(id)
      const answer = await read(subKey)
      const current = answer?.slices.levels[answer.slices.levels.length - 1]?.current
      if (!current) throw new Error(`Avow holds no slice for worker ${id}`)
      const mandate = (await mandates()).current.proof.message
      const narrowed: Signed<Slice> = await narrowSlice({
        issuer: agentReq,
        domain,
        current: current.message,
        limits: workerLimits(mandate, ask, now()),
      })
      return api.post(agentReq, narrowed)
    },
    /** Ends a worker's key, its slice and every slice below it, for good. */
    async end(id: string) {
      const { subKey } = await workerIn(id)
      const mandate = (await mandates()).current.proof.message
      const revocation = await revokeWorker({ by: agentReq, domain, mandate, subKey })
      return api.revoke(agentReq, revocation)
    },
    /** Every worker in the agent's folder, with what Avow holds for each. */
    async workers(): Promise<DelegatedWorker[]> {
      const ids = await options.workers.ids()
      return Promise.all(
        ids.map(async (id) => {
          const { held, subKey } = await workerIn(id)
          const answer = await read(subKey).then(
            (a) =>
              a
                ? ({ ok: true, answer: a } as const)
                : ({ ok: false, problem: 'Avow holds no slice for it' } as const),
            (error: unknown) => ({
              ok: false as const,
              problem: error instanceof Error ? error.message : String(error),
            }),
          )
          return { id, label: held.label, subKey, held: answer }
        }),
      )
    },
  }
}

export type AgentDelegation = Awaited<ReturnType<typeof agentDelegation>>
