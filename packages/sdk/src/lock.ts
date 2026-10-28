import { type Approval, type AvowDomain, approvalTypedData, type Signed } from '@avow-finance/spec'
import { type Address, encodeFunctionData, type Hex, toFunctionSelector } from 'viem'
import { Abis } from 'viem/tempo'

/**
 * The lock function an agent's key calls to fund a reserve, as the testnet lock declares it. The
 * lock is unaudited testnet code, and a new factory can change this interface. Knowing it grants
 * nothing, since the lock checks Avow's signature, the calling key and every field of the approval
 * on each call.
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
