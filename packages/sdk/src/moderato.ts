import { type RailToken, TEMPO_MODERATO } from '@avow-finance/spec'
import {
  type Address,
  type Chain,
  createClient,
  type Hex,
  type HttpTransport,
  http,
  type PublicClient,
  publicActions,
} from 'viem'
import { tempoModerato } from 'viem/chains'

/** Moderato's public RPC. Moderato is Tempo's testnet, where every Avow deployment so far runs. */
export const MODERATO_RPC_URL = 'https://rpc.moderato.tempo.xyz'

/** A lock factory the SDK trusts, with the block it was created in, the first with its code. */
export interface TrustedFactory {
  address: Address
  createdIn: bigint
}

/**
 * Avow's lock factories on Moderato, oldest first. The SDK trusts a lock as Avow's only when one
 * of these made it, whatever a deployment's published settings say. A deployment names the one
 * new businesses get their lock from, and locks from an earlier one stay checkable.
 */
export const MODERATO_FACTORIES: readonly TrustedFactory[] = Object.freeze(
  [
    { address: '0x8fa7177c84BE069df2a51F096ED28d5D661B8283', createdIn: 41_801_818n },
    // The factory whose locks also take suppliers from the supplier registry.
    { address: '0xEeC6E0C0a212868D4BB7C5857338DE57E4Ca8b91', createdIn: 45_516_423n },
    // The factory whose locks refuse a supplier or open-cap change once the lock has moved on from
    // the state an approval named, and report their version.
    { address: '0x1fC36829ce3f907ac103512a7DeC87fA3aF67a97', createdIn: 46_037_634n },
  ].map((f) => Object.freeze(f as TrustedFactory)),
)

/** The first factory on Moderato, which the earliest sandbox businesses' locks came from. */
export const MODERATO_FACTORY: Address = (MODERATO_FACTORIES[0] as TrustedFactory).address

/** The block the first factory was created in, so no lock it made is older. */
export const MODERATO_FACTORY_CREATED_IN = (MODERATO_FACTORIES[0] as TrustedFactory).createdIn

/** A transaction's page in Moderato's explorer. */
export const moderatoTransactionUrl = (hash: Hex): string =>
  `${tempoModerato.blockExplorers.default.url}/tx/${hash}`

/** AlphaUSD, which pays Moderato's fees and comes from its faucet. */
export const MODERATO_FEE_TOKEN: Address = '0x20C0000000000000000000000000000000000001'

/**
 * A client for Moderato that pays fees in AlphaUSD, as `createAgent`, `sendOwn` and the
 * verifier's `tempoChainReader` take it. It reads through `rpcUrl`, the public RPC by default, and
 * tries a failed request three more times.
 */
export function moderatoClient(
  rpcUrl: string = MODERATO_RPC_URL,
): PublicClient<HttpTransport, Chain> {
  // Tempo's formatters and serializers travel on the chain object, whatever its static type.
  const chain: Chain = tempoModerato.extend({ feeToken: MODERATO_FEE_TOKEN })
  return createClient({ chain, transport: http(rpcUrl, { retryCount: 3 }) }).extend(publicActions)
}

/**
 * A USD token on Moderato as a `RailToken`, the form the SDK and the verifier take a reserve token
 * in. A USD token on Tempo has 6 decimals, so its base units equal the micros terms count in.
 */
export function moderatoUsdToken(token: Address): RailToken {
  return { rail: 'tempo', chainId: TEMPO_MODERATO, token, currency: 'USD', decimals: 6 }
}
