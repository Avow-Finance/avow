import { describe, expect, it } from 'vitest'
import { testnetDemoJobTerms } from './demo.js'
import { chainedTerms } from './dependencies.js'
import {
  decodeJobVerification,
  encodeJobVerification,
  type JobVerification,
  jobVerificationOf,
  jobVerificationProblem,
} from './job-verification.js'
import { encodeCommitmentReference } from './reference-link.js'
import { termsHash } from './terms.js'
import { ARBITER, COMPUTE_REFERENCE, id, JOB_REFERENCE, SALT, START } from './test-helpers.js'

const job = testnetDemoJobTerms(START, ARBITER)
const terms = chainedTerms(job, [
  { on: COMPUTE_REFERENCE, condition: 'accepted', disclosed: 'subject' },
])
const commitment = { ...JOB_REFERENCE, termsHash: termsHash(terms, SALT) }
const verification = jobVerificationOf(terms, SALT, commitment)

describe('a link to verify a job', () => {
  it('reads back exactly, and works out to the terms hash the reference names', () => {
    const token = encodeJobVerification(verification)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeJobVerification(token)).toEqual({ ok: true, value: verification })
    expect(jobVerificationProblem(verification)).toBeNull()
  })

  it('names the compute booking in clear and hides the work, the price and the charges', () => {
    const json = atob(encodeJobVerification(verification).replace(/-/g, '+').replace(/_/g, '/'))
    expect(json).toContain(COMPUTE_REFERENCE.commitmentId)
    expect(json).not.toContain('fine-tuning')
    expect(json).not.toContain('40000000')
    expect(json).not.toContain(SALT.slice(2))
  })

  it('works out to another hash once anything it carries changes', () => {
    const changed: JobVerification[] = [
      {
        ...verification,
        dependencies: [
          { ...terms.dependencies[0], on: { ...COMPUTE_REFERENCE, commitmentId: id('another') } },
        ],
      },
      { ...verification, dependenciesSalt: id('another salt') },
      { ...verification, header: { ...verification.header, dependencyCheck: 'avow' } },
      { ...verification, sectionHashes: { ...verification.sectionHashes, consideration: id('x') } },
    ]
    for (const v of changed) expect(jobVerificationProblem(v)).toBe('terms.hash_mismatch')
  })

  it('refuses to name one job’s commitment with another’s terms', () => {
    expect(() => jobVerificationOf(terms, SALT, JOB_REFERENCE)).toThrow(RangeError)
  })

  it('reads a commitment reference’s token, or anything else, as invalid', () => {
    for (const token of [
      encodeCommitmentReference(commitment),
      '',
      'not a token',
      'A'.repeat(7000),
    ]) {
      expect(decodeJobVerification(token)).toEqual({ ok: false, reason: 'message.invalid' })
    }
  })
})
