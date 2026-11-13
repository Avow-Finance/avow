import { type MandateProof, parseMandateProof } from '@avow-finance/spec'
import { describe, expect, it } from 'vitest'
import { MemoryChain } from './chain.js'
import { mandateProofProblem } from './mandate-proof.js'
import {
  buyer,
  CHAIN_ID,
  DOMAIN,
  id,
  KEY_TX,
  LOCK,
  mandate,
  mHash,
  signedMandate,
} from './test-helpers.js'

/** A mandate the transaction `authorizedIn` authorized, as the SDK hands one over. */
const authorized = (message = mandate, authorizedIn = KEY_TX): MandateProof => ({
  type: 'Mandate',
  schemaVersion: '1',
  chainId: CHAIN_ID,
  lock: LOCK,
  message,
  authorizedIn,
})

/** A chain where the business's root put the agent's key on in `KEY_TX` with `witness`. */
function chainWith(witness = mHash) {
  const chain = new MemoryChain(CHAIN_ID)
  chain.setAgentKey(
    buyer.address,
    mandate.agentKey,
    { active: true, expiry: null, witness },
    KEY_TX,
  )
  return chain
}

const check = (chain: MemoryChain, proof: MandateProof, keyAuthorizedIn = KEY_TX) =>
  mandateProofProblem(chain, proof, { account: buyer.address, domain: DOMAIN, keyAuthorizedIn })

describe('a mandate and what shows the business authorized it', () => {
  it('takes a mandate whose key went on in the named transaction with its hash', async () => {
    expect(await check(chainWith(), authorized())).toBeNull()
  })

  it('refuses the mandate once any field changes, since its hash no longer matches the witness', async () => {
    const changes = [
      { capPerCommitment: mandate.capPerCommitment + 1n },
      { capOpenReserves: mandate.capOpenReserves + 1n },
      { expiry: mandate.expiry + 1n },
      { suppliers: ['someone_else'] },
      { actions: [] },
      { nonce: mandate.nonce + 1n },
    ]
    for (const change of changes) {
      expect(await check(chainWith(), authorized({ ...mandate, ...change }))).toBe(
        'chain.mandate_mismatch',
      )
    }
  })

  it('refuses a mandate that names another transaction than the one its key went on in', async () => {
    expect(await check(chainWith(), authorized(mandate, id('another transaction')))).toBe(
      'chain.mandate_mismatch',
    )
    // Or names the right one while the agent's key went on somewhere else.
    expect(await check(chainWith(), authorized(), id('another transaction'))).toBe(
      'chain.mandate_mismatch',
    )
  })

  it('refuses a mandate whose key the chain holds with another hash or none', async () => {
    expect(await check(chainWith(id('another mandate')), authorized())).toBe(
      'chain.mandate_mismatch',
    )
    expect(await check(new MemoryChain(CHAIN_ID), authorized())).toBe('chain.mandate_mismatch')
  })

  it('still takes a mandate the root signed, and refuses one signed by anyone else', async () => {
    const signed = parseMandateProof(await signedMandate(mandate), {
      chainId: CHAIN_ID,
      lock: LOCK,
    })
    if (!signed.ok) throw new Error(signed.reason)
    expect(await check(new MemoryChain(CHAIN_ID), signed.value)).toBeNull()
    // The same signature on a changed mandate.
    const forged = { ...signed.value, message: { ...mandate, capPerCommitment: 1n } }
    expect(await check(new MemoryChain(CHAIN_ID), forged)).toBe('mandate.signature_invalid')
  })
})

describe('reading a mandate with its proof', () => {
  const expected = { chainId: CHAIN_ID, lock: LOCK }

  it('reads one with a transaction and no signature, and one with a signature', async () => {
    const wire = JSON.parse(
      JSON.stringify(authorized(), (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    )
    const read = parseMandateProof(wire, expected)
    expect(read.ok && 'authorizedIn' in read.value && read.value.authorizedIn).toBe(KEY_TX)
    expect(read.ok && read.value).not.toHaveProperty('signature')
    expect(
      (await signedMandate(mandate)) &&
        parseMandateProof(await signedMandate(mandate), expected).ok,
    ).toBe(true)
  })

  it('refuses one carrying both a signature and a transaction, and one for another lock', async () => {
    const both = { ...((await signedMandate(mandate)) as object), authorizedIn: KEY_TX }
    expect(parseMandateProof(both, expected)).toEqual({ ok: false, reason: 'message.invalid' })
    const wire = JSON.parse(
      JSON.stringify(authorized(), (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    )
    expect(parseMandateProof({ ...wire, authorizedIn: '0x1234' }, expected).ok).toBe(false)
    expect(
      parseMandateProof(wire, {
        chainId: CHAIN_ID,
        lock: '0x00000000000000000000000000000000000000ff',
      }).ok,
    ).toBe(false)
  })
})
