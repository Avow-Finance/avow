import {
  type Approval,
  type AvowDomain,
  approvalTypedData,
  SIDE_CODES,
  type Side,
  type Signed,
} from '@avow-finance/spec'
import { FACTORY_ABI, type LockedBacking } from '@avow-finance/verifier'
import { type Address, encodeFunctionData, type Hex, toFunctionSelector } from 'viem'
import { Abis } from 'viem/tempo'

/**
 * The lock function an agent's key calls to fund a reserve, as the testnet lock declares it. The
 * lock is unaudited testnet code, and a new factory can change this interface. Knowing it grants
 * nothing, since on each call the lock checks Avow's signature over every field of the approval,
 * the calling account and key, the supplier, the caps and the expiry.
 */
export const RESERVE_ABI = [
  {
    type: 'function',
    name: 'reserve',
    inputs: [
      {
        name: 'a',
        type: 'tuple',
        components: [
          { name: 'commitmentId', type: 'bytes32' },
          { name: 'side', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'supplier', type: 'address' },
          { name: 'supplierSigner', type: 'address' },
          { name: 'payee', type: 'address' },
          { name: 'freeCancelBy', type: 'uint64' },
          { name: 'acceptBy', type: 'uint64' },
          { name: 'chargeDeadline', type: 'uint64' },
          { name: 'releaseDate', type: 'uint64' },
          { name: 'contestWindow', type: 'uint64' },
          {
            name: 'charges',
            type: 'tuple[]',
            components: [
              { name: 'kind', type: 'uint8' },
              { name: 'most', type: 'uint256' },
              { name: 'earliest', type: 'uint64' },
            ],
          },
          { name: 'day90SupplierShareBps', type: 'uint16' },
          { name: 'arbiter', type: 'address' },
          { name: 'termsHash', type: 'bytes32' },
          { name: 'mandateHash', type: 'bytes32' },
          { name: 'capPerCommitment', type: 'uint256' },
          { name: 'capOpenReserves', type: 'uint256' },
          { name: 'fundingKey', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expiry', type: 'uint64' },
        ],
      },
      { name: 'avowSignature', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/**
 * The selector of `reserve`, the only lock function an agent's key may call. `agentKeyTerms`
 * takes it as the key's one lock selector.
 */
export const RESERVE_SELECTOR: Hex = toFunctionSelector(RESERVE_ABI[0])

/**
 * The calls a business account's root key makes on its own lock and on the factory, as the testnet
 * contracts declare them. Approving a supplier lets an agent reserve for it, and only the account's
 * root key can do it. Cancelling before free cancellation ends takes a reserve back in full.
 */
export const ADMINISTRATOR_ABI = [
  {
    type: 'function',
    name: 'approveSupplier',
    inputs: [{ name: 'supplier', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancelFree',
    inputs: [
      { name: 'commitmentId', type: 'bytes32' },
      { name: 'side', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/**
 * The lock factory's functions. The verifier defines them once, and the SDK passes the same
 * definition on, so an agent and a supplier never read the factory through two different ABIs.
 */
export { FACTORY_ABI }

/** One call in a Tempo transaction. */
export interface Call {
  to: Address
  data: Hex
}

/**
 * The two calls that fund a reserve in one transaction. The first approves the lock to pull the
 * approval's amount of its token, and the second calls `reserve` with Avow's approval and
 * signature.
 */
export function reserveCalls(approval: Signed<Approval>, d: AvowDomain): Call[] {
  const a = approval.message
  return [
    {
      to: a.token,
      data: encodeFunctionData({
        abi: Abis.tip20,
        functionName: 'approve',
        args: [d.verifyingContract, a.amount],
      }),
    },
    {
      to: d.verifyingContract,
      data: encodeFunctionData({
        abi: RESERVE_ABI,
        functionName: 'reserve',
        args: [approvalTypedData(a, d).message, approval.signature],
      }),
    },
  ]
}

/** The call that creates a business account's lock from the factory. */
export function createLockCall(factory: Address, account: Address): Call {
  return {
    to: factory,
    data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createLock', args: [account] }),
  }
}

/** The call, from the business account's root key, that lets its agents reserve for a supplier. */
export function approveSupplierCall(lock: Address, supplier: Address): Call {
  return {
    to: lock,
    data: encodeFunctionData({
      abi: ADMINISTRATOR_ABI,
      functionName: 'approveSupplier',
      args: [supplier],
    }),
  }
}

/**
 * The call, from the business account's root key, that cancels a commitment on the lock before
 * free cancellation ends and gives the whole reserve back. It cancels the buyer's side, the only
 * side a lock holds a reserve for in this release. Until then Avow refuses to record a
 * cancellation, with `commitment.cancel_on_lock`, since the business cancels on the lock without
 * anyone else's signature.
 */
export function cancelFreeCall(lock: Address, commitmentId: Hex): Call {
  return {
    to: lock,
    data: encodeFunctionData({
      abi: ADMINISTRATOR_ABI,
      functionName: 'cancelFree',
      args: [commitmentId, SIDE_CODES.buyer],
    }),
  }
}

/**
 * Whether the lock takes `cancelFreeCall` for a commitment at `now`, by the chain's clock. It takes
 * it for a reserve the supplier hasn't accepted, or one accepted with no report standing, until
 * free cancellation ends, whatever the agent's mandate permits.
 */
export function cancelsFree(held: LockedBacking, now: bigint): boolean {
  const open = held.state === 'reserved' || (held.state === 'accepted' && !held.hasReport)
  return open && now < held.freeCancelBy
}

/**
 * The lock's `trigger`, as the testnet lock declares it, with the error it reverts with when no
 * step is due. It takes whichever step is due for one side of a commitment once a deadline has
 * passed. It returns a reserve the supplier never accepted, releases a kept reserve at its release
 * date, times out a charge report Avow didn't confirm or refer in time, pays a confirmed charge
 * once its contest window closes and applies a posted ruling once its delay has passed. At day 90
 * it resolves a paused charge nobody ruled on, paying a confirmed charge at the day-90 share and
 * returning an unconfirmed one to the business in full. Anyone can send it, since the lock pays
 * only the parties it recorded.
 */
export const TRIGGER_ABI = [
  {
    type: 'function',
    name: 'trigger',
    inputs: [
      { name: 'commitmentId', type: 'bytes32' },
      { name: 'side', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'error', name: 'NothingDue', inputs: [] },
] as const

/** The call that takes the step due for one side of a commitment, from any account. */
export function triggerCall(lock: Address, commitmentId: Hex, side: Side): Call {
  return {
    to: lock,
    data: encodeFunctionData({
      abi: TRIGGER_ABI,
      functionName: 'trigger',
      args: [commitmentId, SIDE_CODES[side]],
    }),
  }
}
