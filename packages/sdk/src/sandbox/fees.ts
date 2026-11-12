import {
  type Address,
  type Chain,
  erc20Abi,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem'
import { Actions } from 'viem/tempo'
import { MODERATO_FEE_TOKEN } from '../moderato.js'

/** The client an account in the sandbox reads the chain and sends its own transactions through. */
export type SandboxClient = PublicClient<Transport, Chain>

/** Enough of the fee token for every fee an account pays in the sandbox, many times over. */
const ENOUGH_FOR_FEES = 1_000_000n

/** The account's balance of a token, in base units. */
export const balanceOf = (client: SandboxClient, token: Address, account: Address) =>
  client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] })

/**
 * Has Moderato's faucet fund an account's fees when it holds less than enough for them, and gives
 * the faucet's transactions, none when it held enough already.
 */
export async function fundFees(client: SandboxClient, account: Address): Promise<Hex[]> {
  if ((await balanceOf(client, MODERATO_FEE_TOKEN, account)) >= ENOUGH_FOR_FEES) return []
  const receipts = await Actions.faucet.fundSync(client, { account, timeout: 60_000 })
  return receipts.map((r) => r.transactionHash)
}
