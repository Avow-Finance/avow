import {
  approvalJson,
  type Parsed,
  parseSigned,
  parseTerms,
  reserveRequestJson,
  termsAgreementJson,
} from '@avow-finance/spec'
import type { Address, Hex } from 'viem'
import type { WorkerAnswer, WorkerAsk, WorkerRequest } from './worker-request.js'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const HEX_BYTES = /^0x([0-9a-fA-F]{2})+$/
const U64 = /^(0|[1-9][0-9]{0,19})$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const holdsOnly = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).every((k) => keys.includes(k)) && keys.every((k) => k in v)
const matches = (v: unknown, pattern: RegExp): v is string =>
  typeof v === 'string' && pattern.test(v)

function readAsk(v: unknown, expected: { chainId: number; lock: Address }): Parsed<WorkerAsk> {
  const bad = { ok: false, reason: 'request.invalid' } as const
  if (!isRecord(v)) return bad
  if (v.kind === 'agreement') {
    if (!holdsOnly(v, ['kind', 'agreement', 'request', 'salt'])) return bad
    if (!matches(v.salt, BYTES32)) return bad
    const agreement = termsAgreementJson.safeParse(v.agreement)
    const request = reserveRequestJson.safeParse(v.request)
    if (!agreement.success || !request.success) return bad
    // A worker commits to version 2 terms only, whose check needs no read of another lock.
    const terms = parseTerms(isRecord(v.request) ? v.request.terms : undefined)
    if (!terms.ok) return bad
    return {
      ok: true,
      value: {
        kind: 'agreement',
        agreement: agreement.data,
        request: { ...request.data, terms: terms.value },
        salt: v.salt as Hex,
      },
    }
  }
  if (v.kind === 'fund') {
    if (!holdsOnly(v, ['kind', 'approval'])) return bad
    const approval = parseSigned(v.approval, 'Approval', approvalJson, expected)
    if (!approval.ok) return approval
    return { ok: true, value: { kind: 'fund', approval: approval.value } }
  }
  return bad
}

/**
 * Reads a worker's request as it crossed the agent's socket, into typed values. The signature is
 * checked by the agent's signer, over the request as read here.
 */
export function parseWorkerRequest(
  json: unknown,
  expected: { chainId: number; lock: Address },
): Parsed<WorkerRequest> {
  const bad = { ok: false, reason: 'request.invalid' } as const
  if (!isRecord(json) || !holdsOnly(json, ['ask', 'subKey', 'requestId', 'expiry', 'signature'])) {
    return bad
  }
  const { subKey, requestId, expiry, signature } = json
  if (
    !matches(subKey, ADDRESS) ||
    !matches(requestId, BYTES32) ||
    !matches(expiry, U64) ||
    !matches(signature, HEX_BYTES)
  ) {
    return bad
  }
  const ask = readAsk(json.ask, expected)
  if (!ask.ok) return ask
  return {
    ok: true,
    value: {
      ask: ask.value,
      subKey: subKey as Address,
      requestId: requestId as Hex,
      expiry: BigInt(expiry),
      signature: signature as Hex,
    },
  }
}

/** Reads the agent's answer to a worker, or null when it isn't one. */
export function parseWorkerAnswer(json: unknown): WorkerAnswer | null {
  if (!isRecord(json)) return null
  if (json.ok === false && holdsOnly(json, ['ok', 'reason']) && typeof json.reason === 'string') {
    return json as WorkerAnswer
  }
  if (json.ok !== true) return null
  if (json.kind === 'agreement' && holdsOnly(json, ['ok', 'kind', 'buyerSignature'])) {
    return matches(json.buyerSignature, HEX_BYTES) ? (json as WorkerAnswer) : null
  }
  if (
    json.kind === 'fund' &&
    holdsOnly(json, ['ok', 'kind', 'transactionHash', 'blockNumber']) &&
    (json.transactionHash === null || matches(json.transactionHash, BYTES32)) &&
    (json.blockNumber === null || matches(json.blockNumber, U64))
  ) {
    return {
      ok: true,
      kind: 'fund',
      transactionHash: json.transactionHash as Hex | null,
      blockNumber: json.blockNumber === null ? null : BigInt(json.blockNumber as string),
    }
  }
  return null
}
