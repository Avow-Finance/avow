import {
  parseSandboxRegistrationAnswer,
  SANDBOX_PATHS,
  type SandboxDeployment,
  signBusinessRegistration,
} from '@avow-finance/spec'
import {
  type Address,
  type Chain,
  erc20Abi,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem'
import { Actions, type Account as TempoAccount } from 'viem/tempo'
import { AvowApiError, avowRequests, rootRequestKey } from '../http.js'
import { createLockCall, FACTORY_ABI } from '../lock.js'
import { MODERATO_FEE_TOKEN } from '../moderato.js'
import { sendOwn } from '../send.js'

/** The client a sandbox business reads the chain and sends its own transactions through. */
export type SandboxClient = PublicClient<Transport, Chain>

/** How long a registration the root key signs stays valid, well inside the API's five minutes. */
const REGISTRATION_VALIDITY = 120n
/** Enough of the fee token for every fee a sandbox business pays, many times over. */
const ENOUGH_FOR_FEES = 1_000_000n
/** How long to wait for the sandbox's test dollars to land, by default. */
const PAYOUT_WAIT_MS = 4 * 60_000

/** One step of making a sandbox business, as it happens. */
export type SandboxBusinessStep =
  | { step: 'fees'; hashes: Hex[] }
  | { step: 'lock'; lock: Address; createdIn: Hex | null }
  | { step: 'registered'; businessId: string; payout: Hex; amount: bigint }
  | { step: 'funded'; balance: bigint }

/** A sandbox business, registered and paid its test dollars. */
export interface SandboxBusiness {
  account: Address
  lock: Address
  businessId: string
  /** The faucet transactions that funded the account's fees, empty when it held enough already. */
  feeHashes: Hex[]
  /** The transaction that created the lock, or null when the lock was there already. */
  lockCreatedIn: Hex | null
  payout: { transactionHash: Hex; amount: bigint }
  balance: bigint
}

export interface SandboxBusinessDeps {
  deployment: Pick<SandboxDeployment, 'chainId' | 'apiUrl' | 'factory' | 'token'>
  client: SandboxClient
  /** The business account's root key, made where the business runs and kept there. */
  root: TempoAccount.RootAccount
  legalName: string
  /** Two capital letters, such as `US`. */
  country: string
  onStep?: (step: SandboxBusinessStep) => void
  /** The clock, in unix seconds. */
  now?: () => bigint
  /** Milliseconds to wait for the test dollars before giving up, four minutes by default. */
  payoutWait?: number
  sleep?: (ms: number) => Promise<void>
  fetch?: typeof fetch
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const systemClock = () => BigInt(Math.floor(Date.now() / 1000))

/** The account's balance of a token, in base units. */
export const balanceOf = (client: SandboxClient, token: Address, account: Address) =>
  client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] })

/**
 * Makes a sandbox business from its root key and registers it, in a browser or in Node.
 * Moderato's faucet funds the account's fees, the root key creates the lock from Avow's factory,
 * and then signs the sandbox registration, which has Avow's sandbox faucet pay the account its
 * test dollars. Every step is safe to run again. An account that holds fees isn't funded twice, a
 * lock that exists isn't created again, and Avow answers a second registration of the same account
 * with the first one's answer and pays nothing more.
 */
export async function createSandboxBusiness(deps: SandboxBusinessDeps): Promise<SandboxBusiness> {
  const { deployment, client, root } = deps
  const onStep = deps.onStep ?? (() => {})
  const sleep = deps.sleep ?? pause
  const now = deps.now ?? systemClock
  const account = root.address

  let feeHashes: Hex[] = []
  if ((await balanceOf(client, MODERATO_FEE_TOKEN, account)) < ENOUGH_FOR_FEES) {
    const receipts = await Actions.faucet.fundSync(client, { account, timeout: 60_000 })
    feeHashes = receipts.map((r) => r.transactionHash)
  }
  onStep({ step: 'fees', hashes: feeHashes })

  const lock = await client.readContract({
    address: deployment.factory,
    abi: FACTORY_ABI,
    functionName: 'lockAddress',
    args: [account],
  })
  let lockCreatedIn: Hex | null = null
  if ((await client.getCode({ address: lock })) === undefined) {
    const receipt = await sendOwn({
      client,
      account: root,
      calls: [createLockCall(deployment.factory, account)],
    })
    lockCreatedIn = receipt.transactionHash
  }
  onStep({ step: 'lock', lock, createdIn: lockCreatedIn })

  const body = await signBusinessRegistration({
    chainId: deployment.chainId,
    factory: deployment.factory,
    audience: deployment.apiUrl,
    account,
    lock,
    legalName: deps.legalName,
    country: deps.country,
    now: now(),
    validity: REGISTRATION_VALIDITY,
    rootKey: root,
  })
  const registered = await avowRequests({
    baseUrl: deployment.apiUrl,
    key: rootRequestKey(root),
    retryFor: 120n,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  })({
    domain: { chainId: deployment.chainId, verifyingContract: lock },
    path: SANDBOX_PATHS.businesses,
    body,
    read: parseSandboxRegistrationAnswer,
  }).catch((error: unknown) => {
    if (!(error instanceof AvowApiError)) throw error
    throw new Error(
      `Avow's sandbox didn't register the business (${error.reason ?? 'no answer'}): ${error.message}. The lock is ready, so the next run picks up from registering.`,
      { cause: error },
    )
  })
  const payout = registered.payout
  onStep({
    step: 'registered',
    businessId: registered.businessId,
    payout: payout.transactionHash,
    amount: payout.amount,
  })

  const deadline = Date.now() + (deps.payoutWait ?? PAYOUT_WAIT_MS)
  for (;;) {
    const balance = await balanceOf(client, deployment.token, account).catch(() => null)
    if (balance !== null && balance >= payout.amount) {
      onStep({ step: 'funded', balance })
      return {
        account,
        lock,
        businessId: registered.businessId,
        feeHashes,
        lockCreatedIn,
        payout,
        balance,
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Avow registered the business, but its test dollars haven't arrived. Look up ${payout.transactionHash} on the explorer, and try again in a few minutes.`,
      )
    }
    await sleep(3000)
  }
}
