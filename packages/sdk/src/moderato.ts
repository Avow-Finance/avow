import { type RailToken, TEMPO_MODERATO } from '@avow-finance/spec'
import {
  type Address,
  type Chain,
  createClient,
  type HttpTransport,
  http,
  type PublicClient,
  publicActions,
} from 'viem'
import { tempoModerato } from 'viem/chains'

/** Moderato's public RPC. Moderato is Tempo's testnet, where every Avow deployment so far runs. */
export const MODERATO_RPC_URL = 'https://rpc.moderato.tempo.xyz'

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
