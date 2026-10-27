import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  keccak256,
  stringToHex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { readAgentKey } from './tempo.js'

// A node stand-in that answers getKey and returns one receipt with the logs a test gives it.
const id = (label: string): Hex => keccak256(stringToHex(label))
const newAddress = () => privateKeyToAccount(generatePrivateKey()).address
const TX = id('the transaction')
const MAX_U64 = 2n ** 64n - 1n

type KeychainLog = { event: 'KeyAuthorized'; key: Address } | { event: 'Witness'; witness: Hex }

function node(account: Address, entries: KeychainLog[], revoked = false) {
  const logs = entries.map((e, i) => {
    const base = {
      address: Addresses.accountKeychain,
      blockHash: id('block'),
      blockNumber: '0x1',
      logIndex: `0x${i.toString(16)}`,
      transactionHash: TX,
      transactionIndex: '0x0',
      removed: false,
    }
    return e.event === 'KeyAuthorized'
      ? {
          ...base,
          topics: encodeEventTopics({
            abi: Abis.accountKeychain,
            eventName: 'KeyAuthorized',
            args: { account, publicKey: e.key },
          }),
          data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint64' }], [0, MAX_U64]),
        }
      : {
          ...base,
          topics: encodeEventTopics({
            abi: Abis.accountKeychain,
            eventName: 'KeyAuthorizationWitness',
            args: { account, witness: e.witness },
          }),
          data: '0x',
        }
  })
  return createClient({
    transport: custom({
      async request({ method, params }) {
        if (method === 'eth_call') {
          const { args } = decodeFunctionData({ abi: Abis.accountKeychain, data: params[0].data })
          return encodeFunctionResult({
            abi: Abis.accountKeychain,
            functionName: 'getKey',
            result: {
              signatureType: 0,
              keyId: args?.[1] as Address,
              expiry: MAX_U64,
              enforceLimits: true,
              isRevoked: revoked,
            },
          })
        }
        if (method === 'eth_getTransactionReceipt') {
          return {
            transactionHash: TX,
            blockHash: id('block'),
            blockNumber: '0x1',
            transactionIndex: '0x0',
            from: account,
            to: null,
            cumulativeGasUsed: '0x1',
            gasUsed: '0x1',
            effectiveGasPrice: '0x1',
            contractAddress: null,
            logs,
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            type: '0x2',
          }
        }
        throw new Error(`unexpected ${method}`)
      },
    }),
  })
}

describe('readAgentKey', () => {
  const account = newAddress()
  const key = newAddress()
  const mandate = id('mandate')

  it('reads the mandate hash from the transaction that authorized the key', async () => {
    const client = node(account, [
      { event: 'KeyAuthorized', key },
      { event: 'Witness', witness: mandate },
    ])
    expect(await readAgentKey(client, account, key, TX)).toEqual({
      active: true,
      expiry: null,
      witness: mandate,
    })
  })

  it('reads a revoked key as inactive', async () => {
    const client = node(
      account,
      [
        { event: 'KeyAuthorized', key },
        { event: 'Witness', witness: mandate },
      ],
      true,
    )
    expect((await readAgentKey(client, account, key, TX))?.active).toBe(false)
  })

  it("won't credit a mandate to a key when the transaction authorized two keys", async () => {
    const other = newAddress()
    const client = node(account, [
      { event: 'KeyAuthorized', key: other },
      { event: 'Witness', witness: mandate },
      { event: 'KeyAuthorized', key },
    ])
    expect((await readAgentKey(client, account, key, TX))?.witness).toBeNull()
    expect((await readAgentKey(client, account, other, TX))?.witness).toBeNull()
  })

  it('finds no mandate when the transaction authorized another key or carries no witness', async () => {
    const elsewhere = node(account, [
      { event: 'KeyAuthorized', key: newAddress() },
      { event: 'Witness', witness: mandate },
    ])
    expect((await readAgentKey(elsewhere, account, key, TX))?.witness).toBeNull()
    const unwitnessed = node(account, [{ event: 'KeyAuthorized', key }])
    expect((await readAgentKey(unwitnessed, account, key, TX))?.witness).toBeNull()
  })
})
