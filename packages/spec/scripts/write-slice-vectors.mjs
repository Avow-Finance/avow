// Writes vectors/slice-v1.json from the built package, so another implementation can check its
// EIP-712 hash of a slice and of a revocation against this one. Run
// `pnpm --filter @avow-finance/spec build` first, and `pnpm format` after, which lays the file out
// as it is pinned. The slice tests fail if this file and the code
// disagree.
import { writeFileSync } from 'node:fs'
import { keccak256, stringToHex } from 'viem'
import { sliceHash, sliceRevocationHash, toWire } from '../dist/index.js'

const id = (label) => keccak256(stringToHex(label))
const domain = { chainId: 42431, verifyingContract: '0x00000000000000000000000000000000000000d4' }
const account = '0x00000000000000000000000000000000000000a1'
const agentKey = '0x00000000000000000000000000000000000000b2'
const workerKey = '0x00000000000000000000000000000000000000c3'
const grandchildKey = '0x00000000000000000000000000000000000000c4'

const first = {
  sliceId: id('slice vector worker'),
  businessId: 'biz_buyer',
  account,
  agentId: 'agt_1',
  mandateHash: id('slice vector mandate'),
  parentSliceId: `0x${'00'.repeat(32)}`,
  issuerKey: agentKey,
  subKey: workerKey,
  by: agentKey,
  actions: ['reserve', 'cancel'],
  currency: 'USD',
  capPerCommitment: 600_000_000n,
  capOpenReserves: 1_200_000_000n,
  suppliers: ['biz_supplier'],
  categories: ['compute'],
  paymentLimits: [
    { token: '0x20C0000000000000000000000000000000000001', amount: 3_000_000_000n, period: 86400n },
  ],
  approvalRule: { kind: 'above', amount: 550_000_000n },
  expiry: 1_800_864_000n,
  nonce: 1n,
}
const narrowed = {
  ...first,
  capOpenReserves: 800_000_000n,
  priceCapPerCommitment: 400_000_000n,
  nonce: 2n,
  replaces: sliceHash(first, domain),
}
const byAccount = {
  ...narrowed,
  by: account,
  capOpenReserves: 1_500_000_000n,
  approvalRule: { kind: 'always' },
  nonce: 3n,
  replaces: sliceHash(narrowed, domain),
}
const below = {
  ...first,
  sliceId: id('slice vector grandchild'),
  parentSliceId: first.sliceId,
  issuerKey: workerKey,
  subKey: grandchildKey,
  by: workerKey,
  suppliers: [],
  categories: ['compute', 'Zürich "east"'],
  approvalRule: { kind: 'never' },
}

const slice = (name, message) => ({
  name,
  message: toWire(message),
  hash: sliceHash(message, domain),
})
const revocation = {
  businessId: 'biz_buyer',
  account,
  agentId: 'agt_1',
  subKey: workerKey,
  by: agentKey,
}

writeFileSync(
  new URL('../vectors/slice-v1.json', import.meta.url),
  `${JSON.stringify(
    {
      version: 1,
      domain,
      slices: [
        slice("a worker's first slice, handed out by the agent key", first),
        slice('the same slice narrowed by its issuer, with a price limit', narrowed),
        slice('the same slice changed by the business account', byAccount),
        slice("a slice of the worker's slice, with text the encoding has to keep", below),
      ],
      revocations: [
        {
          name: "the agent key revoking its worker's key",
          message: revocation,
          hash: sliceRevocationHash(revocation, domain),
        },
      ],
    },
    null,
    2,
  )}\n`,
)
