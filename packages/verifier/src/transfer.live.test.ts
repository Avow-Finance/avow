import type { PaymentReference } from '@avow-finance/spec'
import {
  type Address,
  createClient,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseEventLogs,
  publicActions,
  stringToHex,
  walletActions,
  zeroAddress,
} from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account, Actions, tempoActions } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { verifyPaymentReference } from './references.js'
import { readTransfer, tempoChainReader } from './tempo.js'

/**
 * On Moderato, a payment with a memo is checked against the chain: the token's own
 * TransferWithMemo event at its log index, in a finalized, successful transaction. Every key is
 * generated for the run, the faucet pays for it, and nothing is saved. Runs when
 * AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const RPC = 'https://rpc.moderato.tempo.xyz'
const ALPHA: Address = '0x20c0000000000000000000000000000000000001' // AlphaUSD, also the fee token
const BETA: Address = '0x20c0000000000000000000000000000000000002'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!live)('a payment with a memo, on Moderato', () => {
  it("counts only as the token's TransferWithMemo event, with every field the chain shows", async () => {
    const chain = tempoModerato.extend({ feeToken: ALPHA })
    const transport = http(RPC, { retryCount: 6, retryDelay: 500 })
    const pub = createClient({ chain, transport }).extend(publicActions).extend(tempoActions())
    const payer = Account.fromSecp256k1(generatePrivateKey())
    const payee = Account.fromSecp256k1(generatePrivateKey()).address
    const wallet = createClient({ account: payer, chain, transport })
      .extend(publicActions)
      .extend(walletActions)
      .extend(tempoActions())
    await Actions.faucet.fundSync(pub, { account: payer.address, timeout: 30_000 })

    const memo = keccak256(stringToHex(`live payment ${Date.now()}`))
    const amount = 1_234_567n
    // Sign locally and track the hash, since the public RPC can fail after a transaction lands.
    const request = await wallet.prepareTransactionRequest({
      calls: [
        {
          to: ALPHA,
          data: encodeFunctionData({
            abi: Abis.tip20,
            functionName: 'transferWithMemo',
            args: [payee, amount, memo],
          }),
        },
      ],
    })
    const signed = await wallet.signTransaction(request as never)
    const hash: Hex = keccak256(signed)
    try {
      await pub.request({ method: 'eth_sendRawTransaction', params: [signed] })
    } catch (e) {
      await sleep(2000)
      if (!(await pub.getTransaction({ hash }).catch(() => null))) throw e
    }
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
    expect(receipt.status).toBe('success')

    const events = parseEventLogs({ abi: Abis.tip20, logs: receipt.logs })
    const withMemo = events.find(
      (e) => e.eventName === 'TransferWithMemo' && e.address.toLowerCase() === ALPHA,
    )
    if (!withMemo || withMemo.logIndex === null) throw new Error('no TransferWithMemo event')
    const ref: PaymentReference = {
      kind: 'payment',
      chainId: chain.id,
      transactionHash: hash,
      logIndex: withMemo.logIndex,
      token: ALPHA,
      from: payer.address,
      to: payee,
      amount,
      memo,
    }

    // Tempo finalizes blocks at once, so this waits only for a node a block behind.
    for (let i = 0; i < 10; i++) {
      if ((await readTransfer(pub, chain.id, hash, ref.logIndex))?.finalized) break
      await sleep(1000)
    }
    const reader = tempoChainReader(pub, { factory: zeroAddress, chainId: chain.id })
    expect(await verifyPaymentReference(ref, reader)).toEqual({ ok: true })

    const refused = async (change: Partial<PaymentReference>) =>
      verifyPaymentReference({ ...ref, ...change }, reader)
    expect(await refused({ amount: amount + 1n })).toEqual({
      ok: false,
      reason: 'payment.amount_mismatch',
    })
    expect(await refused({ memo: keccak256(stringToHex('another commitment')) })).toEqual({
      ok: false,
      reason: 'payment.memo_mismatch',
    })
    expect(await refused({ token: BETA })).toEqual({ ok: false, reason: 'payment.token_mismatch' })
    expect(await refused({ to: payer.address })).toEqual({
      ok: false,
      reason: 'payment.recipient_mismatch',
    })
    expect(await refused({ logIndex: 9_999 })).toEqual({ ok: false, reason: 'payment.not_found' })

    // TIP-20 logs a plain Transfer beside the TransferWithMemo, and that log never counts.
    const plain = events.find(
      (e) => e.eventName === 'Transfer' && e.address.toLowerCase() === ALPHA && e.args.to === payee,
    )
    if (!plain || plain.logIndex === null) throw new Error('no plain Transfer beside the memo')
    expect(await refused({ logIndex: plain.logIndex })).toEqual({
      ok: false,
      reason: 'payment.not_memo_transfer',
    })
  }, 180_000)
})
