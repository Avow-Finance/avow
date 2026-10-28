import {
  type Approval,
  type AvowDomain,
  approvalTypedData,
  digestOf,
  dollars,
  type GpuReservationInput,
  lockTerms,
  type Mandate,
  MESSAGE_VERSIONS,
  mandateHash,
  PRODUCTION_PROFILE,
  type RailToken,
  type Signed,
  type StartReceipt,
  type SupplierProfile,
  TESTNET_DEMO_PROFILE,
  termsAgreementTypedData,
  termsHash,
  toTokenUnits,
} from '@avow-finance/spec'
import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  recoverAddress,
  stringToHex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { createAgent } from './agent.js'
import type { AvowApi, ReserveApprovalRequest } from './avow-api.js'
import { type Call, RESERVE_ABI } from './lock.js'
import { accountSigner, signMandate } from './sign.js'
import type { SupplierConnection } from './supplier.js'

// Every key is generated for the run and held only in memory.
const id = (label: string) => keccak256(stringToHex(label))
const LOCK: Address = '0x00000000000000000000000000000000000010c4'
const CHAIN_ID = 42431
const D: AvowDomain = { chainId: CHAIN_ID, verifyingContract: LOCK }
const TOKEN: RailToken = {
  rail: 'tempo',
  chainId: CHAIN_ID,
  token: '0x20c0000000000000000000000000000000000001',
  currency: 'USD',
  decimals: 6,
}
const NOW = 1_800_000_000n
const START = NOW + 3600n
const ARBITER: Address = '0x000000000000000000000000000000000000a4b1'

/** A chain the agent must never touch in these tests. */
const noChain = createClient({
  chain: tempoModerato,
  transport: custom({
    request: async ({ method }) => {
      throw new Error(`the test reached the chain with ${method}`)
    },
  }),
})

function supplierParty() {
  const account = privateKeyToAccount(generatePrivateKey())
  const signingKey = privateKeyToAccount(generatePrivateKey())
  const profile: SupplierProfile = {
    businessId: 'biz_supplier',
    account: account.address,
    signingKey: signingKey.address,
    payee: '0x000000000000000000000000000000000000beef',
  }
  return { profile, signingKey }
}

/** A booking on testnet timing: a 30-minute window an hour away, with two minutes of grace. */
function gpuBooking(change: Partial<GpuReservationInput> = {}): GpuReservationInput {
  return {
    resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'demo-h100x8' },
    currency: 'USD',
    windowStart: START,
    windowDuration: 1800n,
    pricePerGpuHour: dollars(3),
    freeCancelBy: START - 600n,
    lateCancellation: dollars(250),
    noShow: dollars(500),
    gracePeriod: 120n,
    chargeDeadline: START + 1800n,
    contestWindow: 600n,
    releaseDate: START + 1800n,
    arbiter: ARBITER,
    day90SupplierShareBps: 5000,
    ...change,
  }
}

async function setup(options: { actions?: Mandate['actions'] } = {}) {
  const root = Account.fromSecp256k1(generatePrivateKey())
  const key = Account.fromSecp256k1(generatePrivateKey(), { access: root })
  const avowKey = privateKeyToAccount(generatePrivateKey())
  const supplier = supplierParty()
  const mandate: Mandate = {
    mandateId: id('mandate-1'),
    businessId: 'biz_buyer',
    agentId: 'agt_1',
    account: root.address,
    agentKey: key.accessKeyAddress,
    actions: options.actions ?? ['reserve', 'cancel', 'start'],
    currency: 'USD',
    capPerCommitment: dollars(500),
    capOpenReserves: dollars(1500),
    suppliers: ['biz_supplier'],
    categories: ['compute'],
    paymentLimits: [{ token: TOKEN.token, amount: dollars(1500), period: 86_400n }],
    approvalRule: { kind: 'above', amount: dollars(800) },
    expiry: NOW + 86_400n,
    nonce: 1n,
  }
  const signedMandate = await signMandate(mandate, D, accountSigner(root.address, root))
  const mHash = mandateHash(mandate, D)

  /** Avow's approval as the API builds it, with one field changed when a test asks. */
  async function approve(
    r: ReserveApprovalRequest,
    change: Partial<Approval> = {},
    envelope: Partial<Signed<Approval>> = {},
  ): Promise<Signed<Approval>> {
    const message: Approval = {
      commitmentId: r.request.commitmentId,
      token: TOKEN.token,
      ...lockTerms(r.request.terms, TOKEN.decimals),
      supplier: supplier.profile.account,
      supplierSigner: supplier.profile.signingKey,
      payee: r.request.payee,
      termsHash: termsHash(r.request.terms, r.salt),
      mandateHash: mHash,
      capPerCommitment: toTokenUnits(mandate.capPerCommitment, TOKEN.decimals),
      capOpenReserves: toTokenUnits(mandate.capOpenReserves, TOKEN.decimals),
      fundingKey: key.accessKeyAddress,
      nonce: 1n,
      expiry: NOW + 120n,
      ...change,
    }
    const signature = await avowKey.sign({ hash: digestOf(approvalTypedData(message, D)) })
    return {
      type: 'Approval',
      schemaVersion: MESSAGE_VERSIONS.Approval,
      chainId: CHAIN_ID,
      lock: LOCK,
      message,
      signature,
      ...envelope,
    }
  }

  const calls: string[] = []
  const requests: ReserveApprovalRequest[] = []
  const sent: Call[][] = []
  let approvalChange: Partial<Approval> = {}
  let envelopeChange: Partial<Signed<Approval>> = {}
  let refusal: string | null = null
  const avow: AvowApi = {
    async approveReserve(r) {
      calls.push('approveReserve')
      requests.push(r)
      if (refusal) return { ok: false, decisionId: 'dec_1', reason: refusal as never }
      return {
        ok: true,
        decisionId: 'dec_1',
        approval: await approve(r, approvalChange, envelopeChange),
      }
    },
    async sponsor(transaction) {
      calls.push('sponsor')
      return transaction
    },
    async cancel() {
      calls.push('cancel')
      return { cancelledAt: NOW + 60n }
    },
    async requestStart({ commitmentId }) {
      calls.push('requestStart')
      return { startRequestHash: id(`start ${commitmentId}`), requestedAt: NOW + 120n }
    },
    async recordStart() {
      calls.push('recordStart')
    },
  }

  let signWith = supplier.signingKey
  const connection: SupplierConnection = {
    profile: supplier.profile,
    async signAgreement({ agreement, terms, salt, domain }) {
      calls.push('signAgreement')
      // The supplier checks the terms and salt give the hash it signs.
      expect(termsHash(terms, salt)).toBe(agreement.termsHash)
      return signWith.sign({ hash: digestOf(termsAgreementTypedData(agreement, domain)) })
    },
    async startJob(r) {
      calls.push('startJob')
      const receipt: StartReceipt = {
        commitmentId: r.commitmentId,
        side: 'buyer',
        startRequestHash: r.startRequestHash,
        startedAt: r.requestedAt + 1n,
        nonce: 1n,
        expiry: NOW + 600n,
      }
      return {
        type: 'StartReceipt',
        schemaVersion: MESSAGE_VERSIONS.StartReceipt,
        chainId: CHAIN_ID,
        lock: LOCK,
        message: receipt,
        signature: '0x',
      }
    },
  }

  const agent = createAgent({
    client: noChain,
    key,
    mandate: signedMandate,
    token: TOKEN,
    profile: TESTNET_DEMO_PROFILE,
    avow,
    now: () => NOW,
    send: async (c) => {
      calls.push('send')
      sent.push(c)
      return { transactionHash: id('the reserve transaction') }
    },
  })

  return {
    agent,
    key,
    root,
    supplier,
    connection,
    signedMandate,
    mHash,
    calls,
    requests,
    sent,
    avow,
    changeApproval: (c: Partial<Approval>) => {
      approvalChange = c
    },
    changeEnvelope: (c: Partial<Signed<Approval>>) => {
      envelopeChange = c
    },
    refuse: (reason: string) => {
      refusal = reason
    },
    signAgreementWith: (k: typeof supplier.signingKey) => {
      signWith = k
    },
  }
}

describe('booking with a supplier', () => {
  it('agrees the terms, has Avow approve, checks the approval and funds the reserve', async () => {
    const s = await setup()
    const result = await s.agent.book({
      supplier: s.connection,
      booking: gpuBooking(),
      category: 'compute',
    })
    if (!result.ok) throw new Error(result.reason)
    expect(s.calls).toEqual(['signAgreement', 'approveReserve', 'send'])
    const c = result.commitment
    expect(c.termsHash).toBe(termsHash(c.terms, c.salt))
    expect(c.reservedIn).toBe(id('the reserve transaction'))

    // The agreement both sides signed names the commitment, both businesses and the mandate.
    const agreement = c.agreement
    expect(agreement.message).toMatchObject({
      commitmentId: c.commitmentId,
      termsHash: c.termsHash,
      category: 'compute',
      buyerBusinessId: 'biz_buyer',
      supplierBusinessId: 'biz_supplier',
      mandateHash: s.mHash,
      expiry: NOW + 600n,
    })
    const digest = digestOf(termsAgreementTypedData(agreement.message, D))
    const buyer = await recoverAddress({ hash: digest, signature: agreement.buyerSignature })
    expect(buyer.toLowerCase()).toBe(s.key.accessKeyAddress.toLowerCase())

    // Avow got the agreement, the salt and the request as the agent's key funds it.
    const [request] = s.requests
    expect(request).toMatchObject({ salt: c.salt, fundedBy: 'agent' })
    expect(request?.request).toMatchObject({
      commitmentId: c.commitmentId,
      agentKey: s.key.accessKeyAddress,
      supplier: 'biz_supplier',
      payee: s.supplier.profile.payee,
    })

    // One transaction approves the lock to pull the reserve, then calls reserve with the approval.
    const [calls] = s.sent
    if (!calls) throw new Error('nothing was sent')
    const [approve, reserve] = calls
    expect(approve?.to).toBe(TOKEN.token)
    const [spender, amount] = decodeFunctionData({ abi: Abis.tip20, data: approve?.data ?? '0x' })
      .args as [Address, bigint]
    expect(spender.toLowerCase()).toBe(LOCK)
    expect(amount).toBe(500_000_000n)
    expect(reserve?.to).toBe(LOCK)
    expect(reserve?.data).toBe(
      encodeFunctionData({
        abi: RESERVE_ABI,
        functionName: 'reserve',
        args: [approvalTypedData(c.approval.message, D).message, c.approval.signature],
      }),
    )
  })

  it('refuses terms that break their rules before asking anyone', async () => {
    const s = await setup()
    const production = createAgent({
      client: noChain,
      key: s.key,
      mandate: s.signedMandate,
      token: TOKEN,
      profile: PRODUCTION_PROFILE,
      avow: s.avow,
      now: () => NOW,
    })
    // A 10-minute contest window is the testnet profile's, and production refuses it.
    expect(
      await production.book({ supplier: s.connection, booking: gpuBooking(), category: 'compute' }),
    ).toEqual({ ok: false, reason: 'terms.contest_window_short' })
    expect(s.calls).toEqual([])
  })

  it('refuses a supplier signature from another key, before Avow sees the agreement', async () => {
    const s = await setup()
    s.signAgreementWith(privateKeyToAccount(generatePrivateKey()))
    expect(
      await s.agent.book({ supplier: s.connection, booking: gpuBooking(), category: 'compute' }),
    ).toEqual({ ok: false, reason: 'message.signature_invalid' })
    expect(s.calls).toEqual(['signAgreement'])
  })

  it("passes on Avow's refusal with its decision, and sends nothing", async () => {
    const s = await setup()
    s.refuse('mandate.over_commitment_cap')
    expect(
      await s.agent.book({ supplier: s.connection, booking: gpuBooking(), category: 'compute' }),
    ).toEqual({ ok: false, reason: 'mandate.over_commitment_cap', decisionId: 'dec_1' })
    expect(s.sent).toEqual([])
  })

  it('funds only an approval that says exactly what the terms and the mandate say', async () => {
    const other: Address = '0x000000000000000000000000000000000000dead'
    const cases: [Partial<Approval>, string][] = [
      [{ commitmentId: id('another commitment') }, 'approval.commitment_mismatch'],
      [{ supplier: other }, 'approval.parties_mismatch'],
      [{ supplierSigner: other }, 'approval.parties_mismatch'],
      [{ payee: other }, 'approval.parties_mismatch'],
      [{ token: '0x20c0000000000000000000000000000000000002' }, 'approval.terms_mismatch'],
      [{ side: 'supplier' }, 'approval.terms_mismatch'],
      [{ amount: 500_000_001n }, 'approval.terms_mismatch'],
      [{ releaseDate: START + 1801n }, 'approval.terms_mismatch'],
      [{ termsHash: id('other terms') }, 'approval.terms_mismatch'],
      [{ charges: [] }, 'approval.charges_mismatch'],
      [{ arbiter: other }, 'approval.dispute_mismatch'],
      [{ mandateHash: id('another mandate') }, 'approval.mandate_mismatch'],
      [{ capPerCommitment: 500_000_001n }, 'approval.mandate_mismatch'],
      [{ capOpenReserves: 1_500_000_001n }, 'approval.mandate_mismatch'],
      [{ fundingKey: other }, 'approval.mandate_mismatch'],
    ]
    for (const [change, reason] of cases) {
      const s = await setup()
      s.changeApproval(change)
      const result = await s.agent.book({
        supplier: s.connection,
        booking: gpuBooking(),
        category: 'compute',
      })
      expect(result, JSON.stringify(Object.keys(change))).toEqual({
        ok: false,
        reason,
        decisionId: 'dec_1',
      })
      expect(s.sent).toEqual([])
    }
  })

  it('funds only an approval signed for this chain and lock', async () => {
    const cases: [Partial<Signed<Approval>>, string][] = [
      [{ chainId: 1 }, 'message.wrong_chain'],
      [{ lock: '0x00000000000000000000000000000000000010c5' }, 'message.wrong_contract'],
      [{ schemaVersion: '9' }, 'message.schema_unknown'],
    ]
    for (const [change, reason] of cases) {
      const s = await setup()
      s.changeEnvelope(change)
      const result = await s.agent.book({
        supplier: s.connection,
        booking: gpuBooking(),
        category: 'compute',
      })
      expect(result).toEqual({ ok: false, reason, decisionId: 'dec_1' })
      expect(s.sent).toEqual([])
    }
  })

  it("refuses to book when the mandate doesn't permit reserves", async () => {
    const s = await setup({ actions: ['start'] })
    expect(
      await s.agent.book({ supplier: s.connection, booking: gpuBooking(), category: 'compute' }),
    ).toEqual({ ok: false, reason: 'mandate.action_not_permitted' })
    expect(s.calls).toEqual([])
  })
})

describe('cancelling and starting', () => {
  it('tells Avow the business cancels, when the mandate permits it', async () => {
    const s = await setup()
    expect(await s.agent.cancel(id('commitment'))).toEqual({ ok: true, cancelledAt: NOW + 60n })
    const reservesOnly = await setup({ actions: ['reserve'] })
    expect(await reservesOnly.agent.cancel(id('commitment'))).toEqual({
      ok: false,
      reason: 'mandate.action_not_permitted',
    })
    expect(reservesOnly.calls).toEqual([])
  })

  it('has Avow timestamp the request, the supplier sign its receipt and Avow record it, in order', async () => {
    const s = await setup()
    const started = await s.agent.start(id('commitment'), s.connection)
    if (!started.ok) throw new Error(started.reason)
    expect(s.calls).toEqual(['requestStart', 'startJob', 'recordStart'])
    expect(started.receipt.message.startRequestHash).toBe(id(`start ${id('commitment')}`))
  })
})

describe('setting up an agent', () => {
  it('refuses a mandate for another key, another account or another chain', async () => {
    const s = await setup()
    const base = {
      client: noChain,
      mandate: s.signedMandate,
      token: TOKEN,
      profile: TESTNET_DEMO_PROFILE,
      avow: s.avow,
    }
    const strangerKey = Account.fromSecp256k1(generatePrivateKey(), { access: s.root })
    expect(() => createAgent({ ...base, key: strangerKey })).toThrow('another agent key')
    expect(() =>
      createAgent({ ...base, key: s.key, mandate: { ...s.signedMandate, chainId: 1 } }),
    ).toThrow("can't be used on this chain")
    expect(() => createAgent({ ...base, key: s.key, token: { ...TOKEN, chainId: 1 } })).toThrow(
      "isn't on the mandate's chain",
    )
  })
})
