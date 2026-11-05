import { type Address, encodeFunctionData, getAddress, keccak256, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Abis, Account, Addresses } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { moderatoClient } from '../moderato.js'
import { sendOwn } from '../send.js'
import { loadBusinessItem } from './business-store.js'
import { liveKeys, lockCreatedIn } from './keys.js'
import { prepareSandboxBusiness } from './setup.js'
import { loadAgentItem, memoryStore } from './store.js'
import { openKey } from './vault.js'

/**
 * Lowering the authority on Moderato, for a business Avow's sandbox registers for the run. The
 * business has added an admin key of its own, and the new mandate revokes it with the old agent
 * key, so only the new agent key is left. Runs when AVOW_LIVE_TEMPO=1.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'
const supplier = { id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }
const PASSPHRASE = 'a passphrase made for this run'
const KEYCHAIN = Addresses.accountKeychain as Address

describe.skipIf(!live)('revocation on Moderato', () => {
  it(
    'revokes the old agent key and an admin key when the authority goes down',
    async () => {
      const store = memoryStore()
      const asked: string[] = []
      const prompts = {
        newPassphrase: async () => PASSPHRASE,
        passphrase: async () => PASSPHRASE,
        confirm: async (question: string, details: readonly string[] = []) => {
          asked.push([question, ...details].join(' '))
          return true
        },
      }
      const business = (authority: number) =>
        prepareSandboxBusiness({
          config: {
            name: 'Revocation Live Test',
            authority,
            dailyLimit: 1000,
            suppliers: [supplier],
          },
          prompts,
          store,
          session: null,
          log: () => {},
        })
      expect((await business(500)).signed).toBe(true)
      const before = await loadAgentItem(store)
      const item = await loadBusinessItem(store)
      if (!before || !item?.business) throw new Error('The business has no agent')
      const client = moderatoClient()
      const root = Account.fromSecp256k1(await openKey(item.key, PASSPHRASE, item.account))
      const admin = privateKeyToAccount(generatePrivateKey()).address
      const isAdmin = () =>
        client.readContract({
          address: KEYCHAIN,
          abi: Abis.accountKeychain,
          functionName: 'isAdminKey',
          args: [root.address, admin],
        })
      await sendOwn({
        client,
        account: root,
        calls: [
          {
            to: KEYCHAIN,
            data: encodeFunctionData({
              abi: Abis.accountKeychain,
              functionName: 'authorizeAdminKey',
              args: [admin, 0, keccak256(toHex('revocation-live-test'))],
            }),
          },
        ],
      })
      expect(await isAdmin()).toBe(true)

      expect((await business(100)).signed).toBe(true)
      expect(asked.at(-1)).toMatch(
        /^Sign a new mandate .* It revokes every other key on the account/,
      )
      const after = await loadAgentItem(store)
      if (!after) throw new Error('The business has no agent after the change')
      expect(await isAdmin()).toBe(false)
      const old = await client.readContract({
        address: KEYCHAIN,
        abi: Abis.accountKeychain,
        functionName: 'getKey',
        args: [root.address, before.mandate.message.agentKey],
      })
      expect(old.isRevoked).toBe(true)
      const since = await lockCreatedIn({
        client,
        factory: item.business.factory,
        account: root.address,
        lock: item.business.lock,
      })
      expect(await liveKeys(client, root.address, since)).toEqual([
        getAddress(after.mandate.message.agentKey),
      ])
    },
    15 * 60_000,
  )
})
