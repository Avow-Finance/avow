import {
  type Address,
  createPublicClient,
  type Hex,
  http,
  isAddressEqual,
  keccak256,
  recoverAddress,
  stringToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readContract } from 'viem/actions'
import { tempoModerato } from 'viem/chains'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import {
  type Acceptance,
  type Approval,
  acceptanceTypedData,
  approvalTypedData,
  businessActionTypedData,
  type ChargeReport,
  contestAction,
  digestOf,
  evidenceAction,
  evidenceTypedData,
  type ReleaseConsent,
  releaseConsentTypedData,
  reportTypedData,
  type SupplierAction,
  type SupplierEvidence,
  supplierActionTypedData,
  supplierListAction,
} from './eip712.js'
import { keychainSignatureCheck, signForAccount, tempoKeychainCheck } from './keychain.js'
import { id } from './test-helpers.js'

/**
 * One commitment on one lock, from the business approving its supplier to the supplier releasing
 * the reserve, signed message by message the way the SDK signs. Avow's approval key and the
 * supplier's signing key sign plain EIP-712 digests, and an account's root key or admin key signs
 * inside a keychain V2 envelope. The lock contract's tests send these exact signatures to a lock
 * at the same address on the same chain. A change to how the SDK hashes, signs or wraps a message
 * fails this test, and a change to how the lock hashes or checks one fails the lock's, so new pins
 * here go to the lock's tests in the same change.
 *
 * Each key comes from a public label at run time, as Foundry's `makeAddrAndKey` makes its keys,
 * so both sides sign with the same keys. They are test keys and hold nothing.
 */
const key = (label: string) => privateKeyToAccount(keccak256(stringToHex(label)))

const T = 1_800_000_000n
const DOMAIN = {
  chainId: 42431,
  verifyingContract: '0x000000000000000000000000000000000000a11c' as Address,
}
const TOKEN: Address = '0x20c0000000000000000000000000000000000001'

const approvalKey = key('transcript approval key')
const business = key('transcript business')
const businessAdmin = key('transcript business admin key')
const agent = key('transcript agent key')
const supplier = key('transcript supplier')
const signingKey = key('transcript supplier signing key')

const commitmentId = id('transcript commitment')
const termsHash = id('transcript terms')

const approveSupplier = supplierListAction({
  supplier: supplier.address,
  approve: true,
  changeCount: 0n,
  expiry: T + 600n,
})

const approval: Approval = {
  commitmentId,
  side: 'buyer',
  token: TOKEN,
  amount: 500_000_000n,
  supplier: supplier.address,
  supplierSigner: signingKey.address,
  payee: key('transcript payout').address,
  freeCancelBy: T + 7_200n,
  acceptBy: T + 3_600n,
  chargeDeadline: T + 172_800n,
  releaseDate: T + 259_200n,
  contestWindow: 600n,
  charges: [
    { kind: 'lateCancellation', most: 250_000_000n, earliest: T + 7_200n },
    { kind: 'noShow', most: 500_000_000n, earliest: T + 86_400n },
  ],
  day90SupplierShareBps: 5000,
  arbiter: key('transcript arbiter').address,
  termsHash,
  mandateHash: id('transcript mandate'),
  capPerCommitment: 1_000_000_000n,
  capOpenReserves: 2_000_000_000n,
  fundingKey: agent.address,
  nonce: 1n,
  expiry: T + 1_800n,
}

const acceptance: Acceptance = {
  commitmentId,
  side: 'buyer',
  termsHash,
  amount: 500_000_000n,
  token: TOKEN,
  acceptBy: T + 3_600n,
  nonce: 2n,
  expiry: T + 3_000n,
}

const firstReport: ChargeReport = {
  commitmentId,
  side: 'buyer',
  kind: 'lateCancellation',
  amount: 250_000_000n,
  evidenceHash: id('transcript report 1'),
  nonce: 3n,
  expiry: T + 9_000n,
}

const withdrawal: SupplierAction = {
  supplier: supplier.address,
  action: 'withdrawReport',
  commitmentId,
  side: 'buyer',
  reportNumber: 1,
  nonce: 4n,
  expiry: T + 9_000n,
}

const secondReport: ChargeReport = {
  commitmentId,
  side: 'buyer',
  kind: 'noShow',
  amount: 400_000_000n,
  evidenceHash: id('transcript report 2'),
  nonce: 5n,
  expiry: T + 90_000n,
}

const contest = contestAction({
  commitmentId,
  reportNumber: 2,
  reasonCode: 3,
  statementHash: id('transcript statement'),
  nonce: 6n,
  expiry: T + 90_000n,
})

const supplierEvidence: SupplierEvidence = {
  commitmentId,
  side: 'buyer',
  number: 1,
  evidenceHash: id('transcript supplier evidence'),
  nonce: 7n,
  expiry: T + 90_000n,
}

const businessEvidence = evidenceAction({
  commitmentId,
  evidenceNumber: 1,
  evidenceHash: id('transcript business evidence'),
  nonce: 8n,
  expiry: T + 90_000n,
})

const consent: ReleaseConsent = {
  commitmentId,
  side: 'buyer',
  reason: 'supplierFailed',
  evidenceHash: id('transcript consent'),
  nonce: 9n,
  expiry: T + 90_000n,
}

const digests = {
  approveSupplier: digestOf(businessActionTypedData(approveSupplier, DOMAIN)),
  approval: digestOf(approvalTypedData(approval, DOMAIN)),
  acceptance: digestOf(acceptanceTypedData(acceptance, DOMAIN)),
  firstReport: digestOf(reportTypedData(firstReport, DOMAIN)),
  withdrawal: digestOf(supplierActionTypedData(withdrawal, DOMAIN)),
  secondReport: digestOf(reportTypedData(secondReport, DOMAIN)),
  contest: digestOf(businessActionTypedData(contest, DOMAIN)),
  supplierEvidence: digestOf(evidenceTypedData(supplierEvidence, DOMAIN)),
  businessEvidence: digestOf(businessActionTypedData(businessEvidence, DOMAIN)),
  consent: digestOf(releaseConsentTypedData(consent, DOMAIN)),
}

/** Which key signs each message, and for which account when it signs inside an envelope. */
const signers = {
  approveSupplier: { key: businessAdmin, account: business.address },
  approval: { key: approvalKey },
  acceptance: { key: signingKey },
  firstReport: { key: signingKey },
  withdrawal: { key: supplier, account: supplier.address },
  secondReport: { key: signingKey },
  contest: { key: business, account: business.address },
  supplierEvidence: { key: signingKey },
  businessEvidence: { key: businessAdmin, account: business.address },
  consent: { key: supplier, account: supplier.address },
} as const

type Step = keyof typeof digests

async function sign(step: Step): Promise<Hex> {
  const signer: { key: ReturnType<typeof key>; account?: Address } = signers[step]
  const signature = signer.account
    ? await signForAccount(signer.account, digests[step], signer.key)
    : await signer.key.sign({ hash: digests[step] })
  // The envelope carries the account's address with its checksum's capitals, and the lock reads
  // bytes, so the pins are lowercase.
  return signature.toLowerCase() as Hex
}

const pinned: Record<Step, Hex> = {
  approveSupplier:
    '0x04935865f5b8328b322a79baad246221013439c59cfe55724d3112aac34cef45be81419210087dcc92039f8e51cb13ea93a6d7cbb13fcd7b2e817186f1224135f39e1c62523f2c55958c78b9742d3f96131e0b172f1c',
  approval:
    '0x2421059ab51bb25c715e1336cc4150ebcc8b847b2bc62a1d86f8dfeba11364815a8b971d5154f5c92efa44821bcd326472f0985949bce646df76a252e74f0ed01c',
  acceptance:
    '0x243779f531f3fe4b9affe3ff4ddd545b7adc93630af610cd0d90cdae2d738b2f2e47a2c102a242ea1240d592cbfde913e52d240180121dee8b26c278b02845231c',
  firstReport:
    '0x1ceb378e48c7587acd97fecda0aa14933256c5416dfbe41d06f1e49192c098010c5a6360142a5c893b1ab455f69f38e732a4c34916ae4b0bc884d4a9e4e961891b',
  withdrawal:
    '0x04747ade3828326c3309e438ae714480dfbf480b74b18bd4949f7a9acd034b1bda81718f53d26f067ec6406994e5ac311e89798f5457b092c13ed55d6980b1700d202770097601900c4709c9db22d4f4d46db62e5a1b',
  secondReport:
    '0x244c05b6c0b49c1c517ad96f96f3f35bdcb00307575a1a70f4460c502321cfac1db7b6051aa677cf98d0be602ba3da506eaea422bf61d1bce2485249537e93b81c',
  contest:
    '0x04935865f5b8328b322a79baad246221013439c59c9e64a80a54c6de8482af3b5d0e0c63f9692c7778837b0d700a659edb564f67592988ff4c3fe0a161a7951a2fcea49ecb6786bcf27b9597f35f1caec787cd65a01c',
  supplierEvidence:
    '0x1c19716cc6008c7940d7a85d4bd57b5d0a5111729f639da47413a7d5e055b61466a2072514c32313d26e88779e0d4a4fc6c85272211e0f4039f13c8c042e75ba1c',
  businessEvidence:
    '0x04935865f5b8328b322a79baad246221013439c59c6c2f0ae711625499f302e193f4fd6ccbb6cc27cc4a5ac564a5eeb13c029d07477688a5c884c2fb5ee0ec4721acac99220c528c5a4b98074aca6945734d12c5841b',
  consent:
    '0x04747ade3828326c3309e438ae714480dfbf480b7439956202405316e34f8dd25472d87c68a426045987157de225a103865a5382ce638c67c5fc60c8ae53e336d67cdd535e1b7d6137e0493ef8b3cecf00eacbc0941b',
}

describe('a commitment signed with the SDK', () => {
  it('gives the signatures the lock contract replays', async () => {
    const signatures = Object.fromEntries(
      await Promise.all((Object.keys(digests) as Step[]).map(async (s) => [s, await sign(s)])),
    )
    expect(signatures).toEqual(pinned)
  })

  it('signs the approval the same way a wallet signs the typed data', async () => {
    const signature = await approvalKey.signTypedData(approvalTypedData(approval, DOMAIN))
    expect(signature.toLowerCase()).toBe(pinned.approval)
  })

  it('verifies each pinned signature for its signer', async () => {
    const isAdminKey = (account: Address, k: Address) =>
      isAddressEqual(account, business.address) && isAddressEqual(k, businessAdmin.address)
    const check = keychainSignatureCheck(isAdminKey)
    for (const step of Object.keys(digests) as Step[]) {
      const signer: { key: ReturnType<typeof key>; account?: Address } = signers[step]
      if (signer.account) {
        expect(
          await check({ signer: signer.account, digest: digests[step], signature: pinned[step] }),
        ).toBe(true)
      } else {
        expect(await recoverAddress({ hash: digests[step], signature: pinned[step] })).toBe(
          signer.key.address,
        )
      }
    }
  })
})

/**
 * With AVOW_LIVE_TEMPO=1, the same signatures go to Tempo's own verifier on Moderato, the checks
 * the lock makes. It reads only. The business's admin key is registered nowhere on chain, so the
 * two messages it signs are checked offline above and skipped here.
 */
const live = process.env.AVOW_LIVE_TEMPO === '1'

describe.skipIf(!live)("the same signatures on Moderato's verifier", () => {
  const client = createPublicClient({
    chain: tempoModerato,
    transport: http('https://rpc.moderato.tempo.xyz', { retryCount: 5, retryDelay: 500 }),
  })
  const keychainCheck = tempoKeychainCheck(client)

  it('accepts each one signed by a single key or by an account root key', async () => {
    for (const step of Object.keys(digests) as Step[]) {
      const signer: { key: ReturnType<typeof key>; account?: Address } = signers[step]
      if (signer.account && !isAddressEqual(signer.account, signer.key.address)) continue
      const accepted = signer.account
        ? await keychainCheck({
            signer: signer.account,
            digest: digests[step],
            signature: pinned[step],
          })
        : await readContract(client, {
            address: Addresses.signatureVerifier,
            abi: Abis.signatureVerifier,
            functionName: 'verify',
            args: [signer.key.address, digests[step], pinned[step]],
          })
      expect(accepted, step).toBe(true)
    }
  }, 120_000)
})
