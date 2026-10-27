import { dollars, type Mandate } from '@avow-finance/spec'
import { readAgentKey } from '@avow-finance/verifier'
import {
  type Address,
  createClient,
  type Hex,
  http,
  keccak256,
  publicActions,
  stringToHex,
  toFunctionSelector,
  walletActions,
  zeroAddress,
} from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account, Actions, Addresses, tempoActions } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { agentKeyTerms } from './agent-key.js'

/**
 * Step 2.1 on Moderato. A business account authorizes an agent key from a mandate, and Tempo
 * stores the mandate's limit, expiry and hash with it. Every key is generated for the run, the
 * faucet pays for it, and nothing is saved. Runs when AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const RPC = 'https://rpc.moderato.tempo.xyz'
const ALPHA: Address = '0x20c0000000000000000000000000000000000001' // AlphaUSD, also the fee token
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!live)('an agent key from a mandate, on Moderato', () => {
  it("carries the mandate's limit, expiry and hash, and the verifier reads them back", async () => {
    const chain = tempoModerato.extend({ feeToken: ALPHA })
    const transport = http(RPC, { retryCount: 6, retryDelay: 500 })
    const pub = createClient({ chain, transport }).extend(publicActions).extend(tempoActions())
    const root = Account.fromSecp256k1(generatePrivateKey())
    const rootClient = createClient({ account: root, chain, transport })
      .extend(publicActions)
      .extend(walletActions)
      .extend(tempoActions())
    await Actions.faucet.fundSync(pub, { account: root.address, timeout: 30_000 })

    const agent = Account.fromSecp256k1(generatePrivateKey(), { access: root })
    const lock: Address = Account.fromSecp256k1(generatePrivateKey()).address // stands in for a lock
    const now = BigInt(Math.floor(Date.now() / 1000))
    const mandate: Mandate = {
      mandateId: keccak256(stringToHex(`live mandate ${now}`)),
      businessId: 'biz_live_check',
      agentId: 'agt_live_check',
      account: root.address,
      agentKey: agent.accessKeyAddress,
      actions: ['reserve'],
      currency: 'USD',
      capPerCommitment: dollars(500),
      capOpenReserves: dollars(500),
      suppliers: [],
      categories: ['compute'],
      paymentLimits: [{ token: ALPHA, amount: dollars(500), period: 86_400n }],
      approvalRule: { kind: 'never' },
      expiry: now + 3600n,
      nonce: 1n,
    }
    const terms = agentKeyTerms(
      mandate,
      { chainId: chain.id, verifyingContract: lock },
      { lock, lockSelectors: [toFunctionSelector('reserve(bytes)')] },
    )
    const keyAuthorization = await Account.signKeyAuthorization(root, {
      key: agent,
      chainId: BigInt(chain.id),
      ...terms,
    })

    // Sign locally and track the hash, since the public RPC can fail after a transaction lands.
    const request = await rootClient.prepareTransactionRequest({
      calls: [{ to: zeroAddress, data: '0x' }],
      keyAuthorization,
    })
    const signed = await rootClient.signTransaction(request as never)
    const hash: Hex = keccak256(signed)
    try {
      await pub.request({ method: 'eth_sendRawTransaction', params: [signed] })
    } catch (e) {
      await sleep(2000)
      if (!(await pub.getTransaction({ hash }).catch(() => null))) throw e
    }
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
    expect(receipt.status).toBe('success')

    expect(await readAgentKey(pub, root.address, agent.accessKeyAddress, hash)).toEqual({
      active: true,
      expiry: BigInt(terms.expiry),
      witness: terms.witness,
    })
    const [remaining] = await pub.readContract({
      address: Addresses.accountKeychain,
      abi: Abis.accountKeychain,
      functionName: 'getRemainingLimitWithPeriod',
      args: [root.address, agent.accessKeyAddress, ALPHA],
    })
    expect(remaining).toBe(dollars(500))
    // A key the account never authorized reads as nothing.
    const stranger = Account.fromSecp256k1(generatePrivateKey()).address
    expect(await readAgentKey(pub, root.address, stranger, hash)).toBeNull()
  }, 180_000)
})
