import {
  type BuyerSideReference,
  type ComputeOffers,
  computeOfferCost,
  computeOffersPath,
  computeOfferTerms,
  DEMO_GPU_SUPPLIER,
  parseComputeOffers,
  type SandboxDeployment,
  TESTNET_DEMO_PROFILE,
} from '@avow-finance/spec'
import {
  prepareReport,
  readBacking,
  reportCall,
  signReport,
  tempoChainReader,
  tempoLockReader,
} from '@avow-finance/verifier'
import { type Address, type Hex, keccak256, parseAbi, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { AvowApiError, requestSupplierAuthorization, signingRequestKey } from '../http.js'
import { acceptJob } from '../job/accept.js'
import { connectTestCustomer, TestCustomerError } from '../job/customer.js'
import { quoteJob } from '../job/quote.js'
import { moderatoClient, moderatoUsdToken } from '../moderato.js'
import { Refusal, sandboxAgent } from '../sandbox/agent.js'
import { fundFees } from '../sandbox/business.js'
import type { SandboxStore } from '../sandbox/store.js'
import { loadSupplierItem } from '../sandbox/supplier-key.js'
import { landedReverted, sendErrorIn, sendOwn } from '../send.js'
import { chargeStanding } from './charge.js'
import type { CancelOutcome, JobWorld, LockRead, WorldBooking } from './world.js'

/**
 * The live sandbox on Tempo's testnet: Avow's test customer, avow-demo-gpu's offers, Avow's API and
 * the chain. The agent books with its own key through the SDK, and the business's supplier signing
 * key quotes and accepts. Nothing here opens the business's root key, which only `cancel` asks for,
 * through the developer's passphrase.
 */

/** The lock's own record of which key Avow approves with, the one its signature has to recover to. */
const APPROVAL_KEY_ABI = parseAbi(['function approvalKey() view returns (address)'])

const systemClock = () => BigInt(Math.floor(Date.now() / 1000))
/** How long a quote's agreement stays valid, well inside the customer's limit. */
const QUOTE_VALIDITY = 120n

export async function liveWorld(options: {
  store: SandboxStore
  deployment: SandboxDeployment
  /**
   * Shows the developer the booking and asks whether to cancel it, then cancels it on the lock
   * before free cancellation ends, with the business's root key once they type the passphrase.
   * Null when they decline.
   */
  cancelFree: (booking: WorldBooking, read: LockRead) => Promise<Hex | null>
  fetch?: typeof fetch
}): Promise<JobWorld> {
  const { store, deployment } = options
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  if (!deployment.customerUrl) {
    throw new Error('This sandbox deployment offers no jobs yet, since it names no test customer.')
  }
  const supplierItem = await loadSupplierItem(store)
  if (!supplierItem) {
    throw new Error(
      'Your business has no supplier signing key yet. Run npm start, which registers one.',
    )
  }
  const client = moderatoClient(deployment.rpcUrl)
  const signing = privateKeyToAccount(supplierItem.signingKey)
  const profile = supplierItem.profile
  const customer = await connectTestCustomer({
    baseUrl: deployment.customerUrl,
    key: signingRequestKey(signing),
    chainId: deployment.chainId,
    fetch: send,
  })
  const agent = await sandboxAgent({ store, deployment, session: null, log: () => {}, fetch: send })
  const token = moderatoUsdToken(deployment.token)
  const lockReader = tempoLockReader(client, {
    factory: deployment.factory,
    chainId: deployment.chainId,
  })

  const chain = tempoChainReader(client, {
    factory: deployment.factory,
    chainId: deployment.chainId,
  })
  const latestTime = async () => (await client.getBlock()).timestamp

  /** A commitment at the latest finalized block. */
  async function read(reference: BuyerSideReference): Promise<LockRead | null> {
    const block = await lockReader.head()
    const held = await readBacking(client, reference.lock, reference.commitmentId, reference.side, {
      blockNumber: block.number,
    })
    return held
      ? { state: held.state, block, freeCancelBy: held.freeCancelBy, releaseDate: held.releaseDate }
      : null
  }

  return {
    kind: 'live',
    customer: customer.profile,
    computeSupplier: DEMO_GPU_SUPPLIER,
    supplier: { account: profile.account, signingKey: profile.signingKey, payee: profile.payee },
    token: { address: token.token, decimals: token.decimals },

    pullOrder: (scenario) => customer.order(profile, scenario),

    async offers(order): Promise<ComputeOffers> {
      const s = order.terms.subject
      const url = `${new URL(deployment.supplierUrl).origin}${computeOffersPath(s)}`
      const answer = await send(url, { headers: { accept: 'application/json' }, redirect: 'error' })
      if (!answer.ok)
        throw new Error(`${DEMO_GPU_SUPPLIER} answered ${answer.status} for its offers`)
      const parsed = parseComputeOffers(await answer.json())
      if (!parsed.ok) throw new Error(`${DEMO_GPU_SUPPLIER}'s offers don't read (${parsed.reason})`)
      return parsed.value
    },

    async book(offer, gpus) {
      const terms = computeOfferTerms(offer, gpus, deployment)
      const { reserve, price } = computeOfferCost(offer, gpus)
      try {
        const booked = await agent.bookTerms({ supplier: offer.supplier, terms })
        // The supplier accepts on its own lock-side check, and the booking counts once it has.
        const accepted = await booked.accepted()
        const reference = booked.reference as BuyerSideReference
        const onLock = await read(reference)
        if (!accepted || !onLock) {
          return {
            ok: false,
            code: 'supplier.not_accepted',
            layer: 'supplier',
            amounts: {
              needed: reserve,
              left: BigInt(Math.round(booked.left * 1_000_000)),
              authority: agent.mandate.message.capOpenReserves,
              capPerCommitment: agent.mandate.message.capPerCommitment,
              dailyLimit: null,
              dailyLeft: null,
            },
          }
        }
        return {
          ok: true,
          booking: {
            offer,
            gpus,
            reference,
            terms,
            salt: booked.commitment.salt,
            reserve,
            price,
            reservedIn: booked.commitment.reservedIn,
            read: onLock,
          },
        }
      } catch (error) {
        if (error instanceof Refusal) {
          return { ok: false, code: error.code, layer: error.layer, amounts: error.amounts }
        }
        throw error
      }
    },

    async authority() {
      const m = agent.mandate.message
      const left = BigInt(Math.round((await agent.left()) * 1_000_000))
      const dailyLeft = await agent.dailyLeft()
      return {
        capPerCommitment: m.capPerCommitment,
        capOpenReserves: m.capOpenReserves,
        openReservesLeft: left,
        dailyLimit:
          agent.dailyLimit === null ? null : BigInt(Math.round(agent.dailyLimit * 1_000_000)),
        dailyLeft: dailyLeft === null ? null : BigInt(Math.round(dailyLeft * 1_000_000)),
        suppliers: m.suppliers,
      }
    },

    read,

    async quote(order, booking: WorldBooking | null) {
      const quote = await quoteJob({
        offer: order,
        customer: customer.profile,
        supplier: profile,
        signingKey: signingRequestKey(signing),
        compute: booking
          ? { reference: booking.reference, terms: booking.terms, salt: booking.salt }
          : null,
        expiry: systemClock() + QUOTE_VALIDITY,
      })
      try {
        await customer.quote(order.orderId, quote)
        return { ok: true, quote }
      } catch (error) {
        const reason =
          error instanceof AvowApiError || error instanceof TestCustomerError ? error.reason : null
        if (reason) return { ok: false, code: reason, layer: 'customer' }
        throw error
      }
    },

    orderState: (orderId) => customer.state(orderId),

    async accept(_order, quote) {
      const c = customer.profile
      const approvalKey = await client.readContract({
        address: c.lock,
        abi: APPROVAL_KEY_ABI,
        functionName: 'approvalKey',
      })
      // The signing key pays its own fee, which Moderato's faucet tops up when it runs low.
      await fundFees(client, signing.address)
      const sender = Account.fromSecp256k1(supplierItem.signingKey)
      return acceptJob(
        {
          config: {
            chainId: deployment.chainId,
            avowKeys: [approvalKey as Address],
            businessId: profile.businessId,
            payee: profile.payee,
            acceptedTokens: [token],
            profile: TESTNET_DEMO_PROFILE,
            acceptTestData: true,
            account: profile.account,
            signingKey: profile.signingKey,
          },
          chain,
          dependencies: { readers: [lockReader] },
          authorize: (commitment) =>
            requestSupplierAuthorization(
              { baseUrl: deployment.apiUrl, key: signingRequestKey(signing), fetch: send },
              commitment,
            ),
          signingKey: signing,
          send: async (call) => {
            const receipt = await sendOwn({ client, account: sender, calls: [call] })
            return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber }
          },
          now: systemClock,
        },
        { customer: c, quote },
      )
    },

    async landed(hashes: readonly Hex[]) {
      for (const hash of hashes) {
        const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
        if (receipt?.status === 'success') {
          return { transactionHash: hash, blockNumber: receipt.blockNumber }
        }
      }
      return null
    },

    async deliver(orderId, result) {
      await customer.delivery(orderId, { result })
    },

    async reportCharge(order, kind) {
      const c = customer.profile
      const at = await latestTime()
      // The evidence a report names is this note's hash. Avow confirms from its own record.
      const note = `A ${kind} charge on job ${order.commitmentId}, lock ${c.lock} on chain ${c.chainId}, reported at ${at}.`
      const prepared = await prepareReport(
        {
          lock: c.lock,
          commitmentId: order.commitmentId,
          kind,
          evidenceHash: keccak256(stringToHex(note)),
          now: at,
        },
        {
          config: {
            chainId: deployment.chainId,
            signingKey: profile.signingKey,
            acceptedTokens: [token],
          },
          chain,
        },
      )
      if (!prepared.ok) return { ok: false, code: prepared.reason, layer: 'service' }
      const signed = await signReport(prepared, signing, { disclosureId: prepared.disclosure.id })
      const report = { amount: prepared.report.amount, reportNumber: prepared.reportNumber }
      // The signing key pays its own fee, as it does for an acceptance.
      await fundFees(client, signing.address)
      const sender = Account.fromSecp256k1(supplierItem.signingKey)
      try {
        const receipt = await sendOwn({ client, account: sender, calls: [reportCall(signed)] })
        const block = await client.getBlock({ blockNumber: receipt.blockNumber })
        return {
          ok: true,
          ...report,
          transactionHash: receipt.transactionHash,
          reportedAt: block.timestamp,
        }
      } catch (error) {
        if (landedReverted(error))
          return { ok: false, code: 'chain.report_reverted', layer: 'lock' }
        // A send whose outcome nobody saw may still have landed, which the lock's count shows.
        const hash = sendErrorIn(error)?.hashes.at(-1)
        const held = await chain.backing(c.lock, order.commitmentId, 'buyer').catch(() => null)
        if (hash && held?.hasReport && held.reportCount === report.reportNumber) {
          return { ok: true, ...report, transactionHash: hash, reportedAt: at }
        }
        throw error
      }
    },

    async charge(order, report) {
      const c = customer.profile
      const [held, lock] = await Promise.all([
        chain.backing(c.lock, order.commitmentId, 'buyer'),
        chain.lock(c.lock),
      ])
      if (!lock) throw new Error(`The customer's lock ${c.lock} can't be read`)
      return chargeStanding(held, report, lock.timing.confirmWindow)
    },

    cancel: (booking) => cancelBooking(booking, () => read(booking.reference), options.cancelFree),

    async chainFor() {
      return {
        kind: 'rpc',
        url: deployment.rpcUrl,
        chainId: deployment.chainId,
        factory: deployment.factory,
      }
    },

    now: systemClock,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/**
 * The session's rules for cancelling a booking a model asked to cancel. A booking that can't be
 * read, or whose free cancellation has ended, is the tool layer's own choice to cancel nothing. Only
 * then is the developer asked, and a cancellation the lock reverts is the lock's refusal.
 */
export async function cancelBooking(
  booking: WorldBooking,
  read: () => Promise<LockRead | null>,
  cancelFree: (booking: WorldBooking, read: LockRead) => Promise<Hex | null>,
): Promise<CancelOutcome> {
  const onLock = await read().catch(() => null)
  if (!onLock) {
    return {
      ok: false,
      code: 'reference.unreadable',
      layer: 'service',
      why: "The booking couldn't be read on its lock, so the session cancelled nothing.",
    }
  }
  if (onLock.freeCancelBy <= onLock.block.timestamp) {
    return {
      ok: false,
      code: 'service.cancel_late',
      layer: 'service',
      why: 'Free cancellation has ended, so the session cancels nothing and the booking stands under its terms.',
    }
  }
  try {
    const hash = await cancelFree(booking, onLock)
    return hash
      ? { ok: true, transactionHash: hash }
      : {
          ok: false,
          code: 'service.cancel_declined',
          layer: 'service',
          why: 'Your developer declined the cancellation, so the booking stands.',
        }
  } catch (error) {
    if (!landedReverted(error)) throw error
    return {
      ok: false,
      code: 'chain.cancel_reverted',
      layer: 'lock',
      why: 'The lock reverted the cancellation, so the booking stands.',
    }
  }
}
