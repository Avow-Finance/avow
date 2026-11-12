import {
  type CommitmentReference,
  type Mandate,
  mandateJson,
  parseReference,
  parseSigned,
  type Signed,
  toWire,
} from '@avow-finance/spec'
import { type Address, type Hex, isAddress } from 'viem'

/**
 * What a sandbox keeps, each item apart. `business` holds the business's root key sealed under its
 * passphrase, which only the runner opens. `agent` holds the agent's own key and the mandate it acts
 * under. `supplier` holds the signing key the business quotes and accepts jobs with, and its
 * registration as a sandbox supplier. Those two are all a job process reads. `state` holds the
 * commitments the agent made. `request` holds the key of an agent that asked a business for
 * authority and is waiting for the answer, so asking again after a restart keeps the same key.
 */
export type SandboxStoreItem = 'business' | 'agent' | 'supplier' | 'state' | 'request' | 'mailbox'

/**
 * Where a sandbox keeps its items, as text. In Node it's the `.avow` folder of the working
 * directory unless you pass a store, and that folder ignores itself in git.
 */
export interface SandboxStore {
  read(item: SandboxStoreItem): Promise<string | null>
  write(item: SandboxStoreItem, text: string): Promise<void>
}

/** A store held in memory, for a test or a page that shouldn't keep anything. */
export function memoryStore(): SandboxStore {
  const items = new Map<SandboxStoreItem, string>()
  return {
    read: async (item) => items.get(item) ?? null,
    write: async (item, text) => {
      items.set(item, text)
    },
  }
}

/** A supplier the agent may book: its business id, and the URL of its adapter. */
export interface SandboxSupplier {
  id: string
  url: string
}

/** A sandbox business as Avow registered it, on the deployment it was made on. */
export interface StoredBusiness {
  chainId: number
  apiUrl: string
  factory: Address
  token: Address
  account: Address
  lock: Address
  businessId: string
}

/** The agent's item: its own key, and the mandate the business signed for it. */
export interface AgentItem {
  agentKey: Hex
  business: StoredBusiness
  mandate: Signed<Mandate>
  mandateHash: Hex
  keyAuthorizedIn: Hex
  suppliers: SandboxSupplier[]
}

/** A commitment the agent made, with the mandate it was made under. */
export interface StoredCommitment {
  reference: CommitmentReference
  /** The reserve, in micros. */
  amount: bigint
  supplier: string
  mandateHash: Hex
  /** Unix seconds. */
  madeAt: bigint
}

const isKey = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v)
export const isAddressText = (v: unknown): v is Address => typeof v === 'string' && isAddress(v)
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function readJson(text: string, item: SandboxStoreItem): Record<string, unknown> {
  try {
    const json: unknown = JSON.parse(text)
    if (isRecord(json)) return json
  } catch {
    // Reported below, without the text.
  }
  throw new Error(
    `The sandbox's ${item} file isn't readable. Move the .avow folder aside to start over.`,
  )
}

export const write = (store: SandboxStore, item: SandboxStoreItem, value: object) =>
  store.write(item, `${JSON.stringify(toWire({ version: 1, ...value }), null, 2)}\n`)

export function readBusiness(json: unknown): StoredBusiness | null {
  if (!isRecord(json)) return null
  const ok =
    typeof json.chainId === 'number' &&
    typeof json.apiUrl === 'string' &&
    typeof json.businessId === 'string' &&
    isAddressText(json.factory) &&
    isAddressText(json.token) &&
    isAddressText(json.account) &&
    isAddressText(json.lock)
  return ok ? (json as unknown as StoredBusiness) : null
}

function readSuppliers(json: unknown): SandboxSupplier[] | null {
  if (!Array.isArray(json)) return null
  const suppliers = json.filter(
    (s): s is SandboxSupplier =>
      isRecord(s) && typeof s.id === 'string' && typeof s.url === 'string',
  )
  return suppliers.length === json.length ? suppliers.map((s) => ({ id: s.id, url: s.url })) : null
}

/** The agent's item, or null when the business hasn't enrolled an agent. */
export async function loadAgentItem(store: SandboxStore): Promise<AgentItem | null> {
  const text = await store.read('agent')
  if (text === null) return null
  const json = readJson(text, 'agent')
  const business = readBusiness(json.business)
  const suppliers = readSuppliers(json.suppliers)
  if (
    !business ||
    !suppliers ||
    !isKey(json.agentKey) ||
    !isKey(json.mandateHash) ||
    !isKey(json.keyAuthorizedIn)
  ) {
    return null
  }
  const mandate = parseSigned(json.mandate, 'Mandate', mandateJson, {
    chainId: business.chainId,
    lock: business.lock,
  })
  if (!mandate.ok) return null
  return {
    agentKey: json.agentKey,
    business,
    mandate: mandate.value as Signed<Mandate>,
    mandateHash: json.mandateHash,
    keyAuthorizedIn: json.keyAuthorizedIn,
    suppliers,
  }
}

export const saveAgentItem = (store: SandboxStore, item: AgentItem) => write(store, 'agent', item)

/** The commitments the agent made, as far as each still parses. */
export async function loadCommitments(store: SandboxStore): Promise<StoredCommitment[]> {
  const text = await store.read('state')
  if (text === null) return []
  const json = readJson(text, 'state')
  if (!Array.isArray(json.commitments)) return []
  return json.commitments.flatMap((c: unknown): StoredCommitment[] => {
    if (!isRecord(c)) return []
    const reference = parseReference(c.reference)
    if (
      !reference.ok ||
      reference.value.kind !== 'commitment' ||
      typeof c.amount !== 'string' ||
      !/^[0-9]+$/.test(c.amount) ||
      typeof c.supplier !== 'string' ||
      !isKey(c.mandateHash) ||
      typeof c.madeAt !== 'string' ||
      !/^[0-9]+$/.test(c.madeAt)
    ) {
      return []
    }
    return [
      {
        reference: reference.value,
        amount: BigInt(c.amount),
        supplier: c.supplier,
        mandateHash: c.mandateHash,
        madeAt: BigInt(c.madeAt),
      },
    ]
  })
}

export const saveCommitments = (store: SandboxStore, commitments: readonly StoredCommitment[]) =>
  write(store, 'state', { commitments })

/** Adds one commitment, reading the list again first so another process's addition isn't lost. */
export async function addCommitment(store: SandboxStore, c: StoredCommitment): Promise<void> {
  await saveCommitments(store, [...(await loadCommitments(store)), c])
}
