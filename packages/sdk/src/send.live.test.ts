import { type Address, createClient, encodeFunctionData, http, publicActions } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account, Actions, Relay } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { sendSponsored } from './send.js'

/**
 * On Moderato, a key with no fee token sends a transaction through `sendSponsored`, and a relay
 * built from viem's fee payer co-signs it, as Avow's relay does. Every key is generated for the
 * run, the faucet pays the relay, and nothing is saved. Runs when AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const ALPHA: Address = '0x20c0000000000000000000000000000000000001' // AlphaUSD, also the fee token

describe.skipIf(!live)('a sponsored transaction on Moderato', () => {
  it('lands with the relay paying the fee for a sender that holds no fee token', async () => {
    const chain = tempoModerato.extend({ feeToken: ALPHA })
    const transport = http('https://rpc.moderato.tempo.xyz', { retryCount: 6, retryDelay: 500 })
    const client = createClient({ chain, transport }).extend(publicActions)
    const relayKey = privateKeyToAccount(generatePrivateKey())
    const sender = Account.fromSecp256k1(generatePrivateKey())
    await Actions.faucet.fundSync(client, { account: relayKey.address, timeout: 30_000 })

    const senders: Address[] = []
    const relay = Relay.create({
      client,
      plugins: [
        Relay.feePayer({
          account: relayKey,
          validate: async (tx) => {
            if (tx.from) senders.push(tx.from)
            return true
          },
        }),
      ],
    })
    const hashes: string[] = []
    const receipt = await sendSponsored({
      client,
      account: sender,
      calls: [
        {
          to: ALPHA,
          data: encodeFunctionData({
            abi: Abis.tip20,
            functionName: 'approve',
            args: [relayKey.address, 1n],
          }),
        },
      ],
      sponsor: (transaction) =>
        relay.request(
          { method: 'eth_signRawTransaction', params: [transaction] },
          { chainId: chain.id },
        ) as Promise<`0x${string}`>,
      onSent: (hash) => hashes.push(hash),
    })
    expect(receipt.status).toBe('success')
    expect(hashes).toContain(receipt.transactionHash)
    expect(senders.map((a) => a.toLowerCase())).toContain(sender.address.toLowerCase())
    expect(String((receipt as { feePayer?: string }).feePayer).toLowerCase()).toBe(
      relayKey.address.toLowerCase(),
    )
    const allowance = await client.readContract({
      address: ALPHA,
      abi: Abis.tip20,
      functionName: 'allowance',
      args: [sender.address, relayKey.address],
    })
    expect(allowance).toBe(1n)
  }, 180_000)
})
