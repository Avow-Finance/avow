// Writes vectors/api-request-v1.json from the built package, so another implementation can check
// its body encoding, body hash, EIP-712 digest, signature and Authorization header against this
// one. Run `pnpm --filter @avow-finance/spec build` first. The vectors test fails if this file and
// the code disagree. The key is made from a public label, so it holds nothing.
import { writeFileSync } from 'node:fs'
import { keccak256, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeApiBody, signApiRequest } from '../dist/index.js'

const account = privateKeyToAccount(keccak256(stringToHex('avow api request vector key')))
const key = { address: account.address, signDigest: (hash) => account.sign({ hash }) }
const domain = { chainId: 42431, verifyingContract: '0x00000000000000000000000000000000000010c4' }
const audience = 'https://api.testnet.avow.finance'
const expiry = 1_800_000_120n

async function vector(name, method, path, value) {
  const body = value === undefined ? new Uint8Array() : encodeApiBody(value)
  const requestId = keccak256(stringToHex(`api request vector ${name}`))
  const signed = await signApiRequest({
    key,
    domain,
    audience,
    method,
    path,
    body,
    requestId,
    expiry,
  })
  return {
    name,
    audience,
    chainId: domain.chainId,
    lock: domain.verifyingContract,
    method,
    path,
    body: new TextDecoder().decode(body),
    bodyHash: signed.request.message.bodyHash,
    signer: account.address.toLowerCase(),
    requestId,
    expiry: expiry.toString(),
    digest: signed.digest,
    signature: signed.request.signature,
    authorization: signed.authorization,
  }
}

const vectors = [
  await vector('sponsorship', 'POST', '/v1/sponsorships', { transaction: '0x76f8ab' }),
  // Keys out of order, an amount as a bigint, an array, a boolean and non-ASCII text, which an
  // implementation that skips sorting, writes numbers for amounts or escapes text would encode
  // differently.
  await vector('nested body', 'POST', '/v1/reserve-approvals', {
    salt: `0x${'44'.repeat(32)}`,
    fundedBy: 'agent',
    request: { supplier: 'biz_supplier', amount: 500_000_000n, regions: ['us-east', 'São Paulo'] },
    flags: { testData: true },
  }),
  await vector(
    'no body',
    'GET',
    `/v1/commitments/0x${'ab'.repeat(32)}/supplier-authorizations`,
    undefined,
  ),
]

writeFileSync(
  new URL('../vectors/api-request-v1.json', import.meta.url),
  `${JSON.stringify({ version: 1, vectors }, null, 2)}\n`,
)
