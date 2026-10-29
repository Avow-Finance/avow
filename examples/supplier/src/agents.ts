import { createServer, type IncomingMessage, type Server } from 'node:http'
import {
  canonicalJson,
  digestOf,
  parseTerms,
  type SupplierProfile,
  termsAgreementJson,
  termsAgreementTypedData,
  toWire,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { z } from 'zod'
import { type AgreementOffer, agreementProblem, type OfferRules } from './offer.js'
import type { SupplierStore } from './store.js'

export interface AgentDeps {
  profile: SupplierProfile
  rules: OfferRules
  store: SupplierStore
  signingKey: PrivateKeyAccount
  /** Whether a lock came from Avow's factory, so a booking can only be on a real lock. */
  isLock: (lock: Address) => Promise<boolean>
  now: () => bigint
  log: (line: string) => void
}

/** What the server answers: a status and a JSON body. */
export interface Answer {
  status: number
  body: unknown
}

const MAX_BODY = 64 * 1024
const fail = (status: number, error: string): Answer => ({ status, body: { error } })

const offerJson = z.strictObject({
  agreement: z.unknown(),
  terms: z.unknown(),
  salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  domain: z.strictObject({
    chainId: z.number().int().positive(),
    verifyingContract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  }),
})

/** Reads an agent's request to sign a terms agreement, or says what's wrong with it. */
function readOffer(json: unknown): AgreementOffer | string {
  const outer = offerJson.safeParse(json)
  if (!outer.success) return 'the body is no agreement offer'
  const agreement = termsAgreementJson.safeParse(outer.data.agreement)
  if (!agreement.success) return "the agreement doesn't parse"
  const terms = parseTerms(outer.data.terms)
  if (!terms.ok) return `the terms don't parse (${terms.reason})`
  return {
    agreement: agreement.data,
    terms: terms.value,
    salt: outer.data.salt.toLowerCase() as Hex,
    domain: {
      chainId: outer.data.domain.chainId,
      verifyingContract: outer.data.domain.verifyingContract.toLowerCase() as Address,
    },
  }
}

/**
 * Signs an agent's terms agreement, the first thing an agent asks a supplier for. The supplier
 * records the booking before it answers, so a restart never loses one it signed. The same offer
 * sent again gets the same signature, and another offer for the same commitment is refused.
 */
export async function signAgreement(deps: AgentDeps, json: unknown): Promise<Answer> {
  const offer = readOffer(json)
  if (typeof offer === 'string') return fail(400, offer)
  const { agreement, terms, salt, domain } = offer
  const commitmentId = agreement.commitmentId.toLowerCase() as Hex
  const record = {
    agreement: toWire(agreement),
    terms: toWire(terms),
    salt,
    chainId: domain.chainId,
    lock: domain.verifyingContract,
  }
  const known = deps.store.booking(commitmentId)
  if (known) {
    const same =
      canonicalJson({ ...record }) ===
      canonicalJson({
        agreement: known.agreement,
        terms: known.terms,
        salt: known.salt,
        chainId: known.chainId,
        lock: known.lock,
      })
    return same
      ? { status: 200, body: { signature: known.signature } }
      : fail(409, 'another agreement for this commitment is already signed')
  }
  const problem = agreementProblem(offer, deps.rules, deps.now())
  if (problem) return fail(422, problem)
  if (!(await deps.isLock(domain.verifyingContract))) {
    return fail(422, "the agreement's lock isn't one Avow's factory made")
  }
  const signature = await deps.signingKey.sign({
    hash: digestOf(termsAgreementTypedData(agreement, domain)),
  })
  deps.store.put({ commitmentId, ...record, signature, status: 'agreed' })
  deps.log(`signed the agreement for ${commitmentId} on lock ${domain.verifyingContract}`)
  return { status: 200, body: { signature } }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * The supplier's endpoint for agents. `GET /profile` gives the supplier's business id, account,
 * payout address and signing key, and `POST /agreements` signs a terms agreement.
 */
export function agentServer(deps: AgentDeps): Server {
  return createServer(async (req, res) => {
    let answer: Answer
    try {
      if (req.method === 'GET' && req.url === '/profile') {
        answer = { status: 200, body: deps.profile }
      } else if (req.method === 'POST' && req.url === '/agreements') {
        let json: unknown
        try {
          json = await readBody(req)
        } catch {
          json = undefined
        }
        answer =
          json === undefined
            ? fail(400, 'the body is no JSON under 64 KiB')
            : await signAgreement(deps, json)
      } else {
        answer = fail(404, 'no such route')
      }
    } catch (e) {
      deps.log(`an agent's request failed: ${e instanceof Error ? e.message : String(e)}`)
      answer = fail(500, 'the supplier could not answer')
    }
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer.body))
  })
}
