import { dollars, encodeApiBody, mandateHash } from '@avow-finance/spec'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { sandboxMandate } from '../sandbox/mandate.js'
import { memoryStore, saveAgentItem, write } from '../sandbox/store.js'
import { accountSigner, signMandate } from '../sign.js'
import { deployment, domain, LOCK, supplier, TOKEN } from './sandbox-business.js'

/** A value as it travels in a signed request's body. */
export const wire = (value: unknown) => JSON.parse(new TextDecoder().decode(encodeApiBody(value)))

/** A JSON answer, as Avow's API gives one. */
export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * A folder holding an enrolled agent, whose mandate names the suppliers and categories given, and
 * for a seller its registered signing key too.
 */
export async function folderWithAgent(
  businessId: string,
  o: {
    sells?: boolean
    suppliers: readonly string[]
    categories: readonly string[]
    /** The mandate's price limit for one commitment, none when left out. */
    priceCap?: bigint
  },
) {
  const store = memoryStore()
  const root = Account.fromSecp256k1(generatePrivateKey())
  const agentKey = generatePrivateKey()
  const message = sandboxMandate({
    businessId,
    agentId: 'agt_test',
    account: root.address,
    agentKey: Account.fromSecp256k1(agentKey, { access: root.address }).accessKeyAddress,
    suppliers: [...o.suppliers],
    categories: [...o.categories],
    token: TOKEN,
    capPerCommitment: dollars(500),
    capOpenReserves: dollars(1000),
    ...(o.priceCap === undefined ? {} : { priceCapPerCommitment: o.priceCap }),
    expiry: 1_900_000_000n,
  })
  const business = { ...deployment, account: root.address, lock: LOCK, businessId }
  await saveAgentItem(store, {
    agentKey,
    business,
    mandate: await signMandate(message, domain, accountSigner(root.address, root)),
    mandateHash: mandateHash(message, domain),
    keyAuthorizedIn: `0x${'ab'.repeat(32)}`,
    suppliers: [supplier],
  })
  if (o.sells) {
    const signingKey = generatePrivateKey()
    await write(store, 'supplier', {
      signingKey,
      profile: {
        businessId,
        account: root.address,
        payee: root.address,
        signingKey: privateKeyToAccount(signingKey).address,
      },
      business,
    })
  }
  return { store, root }
}
