import { type AvowDomain, dollars, mandateHash } from '@avow-finance/spec'
import { type Address, getAddress } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { MODERATO_FACTORY, MODERATO_FACTORY_CREATED_IN } from '../moderato.js'
import { saveBusinessItem } from '../sandbox/business-store.js'
import { sandboxMandate } from '../sandbox/mandate.js'
import { memoryStore, saveAgentItem } from '../sandbox/store.js'
import { sealKey } from '../sandbox/vault.js'
import { accountSigner, signMandate } from '../sign.js'

/** A sandbox business enrolled on a stand-in for Moderato, for the business's side's tests. */
export const PASSPHRASE = 'correct horse battery staple'
export const TOKEN: Address = '0x20c00000000000000000000058fbf8a39a171185'
export const LOCK: Address = getAddress('0x00000000000000000000000000000000000010c4')
export const LOCK_BLOCK = MODERATO_FACTORY_CREATED_IN + 1_000n
export const supplier = { id: 'avow-demo-gpu', url: 'https://supplier.testnet.avow.finance' }
export const deployment = {
  chainId: 42431,
  rpcUrl: 'http://127.0.0.1',
  apiUrl: 'https://api.testnet.avow.finance',
  supplierUrl: supplier.url,
  factory: MODERATO_FACTORY,
  token: TOKEN,
  arbiter: '0x7b7b7e93b9de1b9cba5123f0570b56eb66c53173' as Address,
  day90SupplierShareBps: 5000,
}
export const domain: AvowDomain = { chainId: deployment.chainId, verifyingContract: LOCK }

/** A business with its agent enrolled under a mandate, $500 by default, as the runner leaves it. */
export async function enrolledBusiness(authority = 500) {
  const store = memoryStore()
  const rootKey = generatePrivateKey()
  const root = Account.fromSecp256k1(rootKey)
  const agent = Account.fromSecp256k1(generatePrivateKey(), { access: root.address })
  const business = {
    chainId: deployment.chainId,
    apiUrl: deployment.apiUrl,
    factory: deployment.factory,
    token: TOKEN,
    account: root.address,
    lock: LOCK,
    businessId: 'sandbox-business',
  }
  await saveBusinessItem(store, {
    account: root.address,
    key: await sealKey(rootKey, PASSPHRASE, root.address),
    business,
  })
  const message = sandboxMandate({
    businessId: business.businessId,
    agentId: 'agt_test',
    account: root.address,
    agentKey: agent.accessKeyAddress,
    suppliers: [supplier.id],
    token: TOKEN,
    capPerCommitment: dollars(authority),
    capOpenReserves: dollars(authority),
    dailyLimit: dollars(1000),
    expiry: BigInt(Math.floor(Date.now() / 1000)) + 86_400n,
  })
  await saveAgentItem(store, {
    agentKey: generatePrivateKey(),
    business,
    mandate: await signMandate(message, domain, accountSigner(root.address, root)),
    mandateHash: mandateHash(message, domain),
    keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
    suppliers: [supplier],
  })
  return { store, root, agentKey: agent.accessKeyAddress, witness: mandateHash(message, domain) }
}

/** Prompts that answer no and record what they were asked. */
export function recordingPrompts(answer = false) {
  const asked: string[] = []
  return {
    asked,
    prompts: {
      newPassphrase: async () => {
        asked.push('new passphrase')
        return PASSPHRASE
      },
      passphrase: async () => {
        asked.push('passphrase')
        return PASSPHRASE
      },
      confirm: async (question: string) => {
        asked.push(question)
        return answer
      },
    },
  }
}

export const config = {
  name: 'Starter Test Co',
  authority: 500,
  dailyLimit: 1000,
  suppliers: [supplier],
}
