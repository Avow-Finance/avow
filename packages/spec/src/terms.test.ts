import { hkdfSync } from 'node:crypto'
import {
  type Address,
  concat,
  encodeAbiParameters,
  type Hex,
  hexToBytes,
  keccak256,
  stringToHex,
  toHex,
  zeroAddress,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical.js'
import { demoTerms, dollars, testnetDemoTerms } from './demo.js'
import type { Approval, Charge } from './eip712.js'
import {
  GPU_HOUR,
  type GPU_RESERVATION,
  type GpuReservationTerms,
  gpuGracePeriod,
} from './gpu-reservation.js'
import { PRODUCTION_PROFILE, TESTNET_DEMO_PROFILE } from './profiles.js'
import type { ReasonCode } from './reasons.js'
import {
  AUTHORIZATION_TERMS_FIELDS,
  approvalCaps,
  approvalMandateProblem,
  approvalPartiesProblem,
  approvalTermsProblem,
  approvalTokenProblem,
  checkSectionDisclosure,
  discloseSection,
  enforceableTerms,
  LOCK_RECORD_FIELDS,
  LOCK_TERMS_FIELDS,
  type LockTerms,
  type LockTermsField,
  lockRecordDifferences,
  lockTerms,
  lockTermsDifferences,
  sameCharges,
  sectionHash,
  sectionHashes,
  sectionSalt,
  TERMS_SECTIONS,
  type TermsSection,
  termsCharges,
  termsHash,
  termsHashFromSections,
  termsHeader,
  termsShapeProblem,
  validateTerms,
} from './terms.js'
import { termsHashV1, testnetDemoTermsV1 } from './terms-v1.js'
import { ARBITER } from './test-helpers.js'

const START = 1_800_000_000n
const SALT = `0x${'11'.repeat(32)}` as const
const OTHER: Address = '0x000000000000000000000000000000000000a4b2'
const base = testnetDemoTerms(START, ARBITER)

/** Terms with one section changed. */
function change<S extends TermsSection>(
  t: GpuReservationTerms,
  section: S,
  patch: Partial<GpuReservationTerms[S]>,
): GpuReservationTerms {
  return { ...t, [section]: { ...t[section], ...patch } }
}

describe('termsHash', () => {
  it('is the same for the same terms and salt, and changes with the salt', () => {
    expect(termsHash(base, SALT)).toBe(termsHash(testnetDemoTerms(START, ARBITER), SALT))
    expect(termsHash(base, SALT)).not.toBe(termsHash(base, `0x${'12'.repeat(32)}`))
  })

  it('changes when any field of the header or any section changes', () => {
    const hash = termsHash(base, SALT)
    const [late, noShow] = base.remedies.charges
    if (!late || !noShow) throw new Error('the demo terms have two charges')
    const changed: GpuReservationTerms[] = [
      change(base, 'subject', { resource: { ...base.subject.resource, count: 7 } }),
      change(base, 'subject', { resource: { ...base.subject.resource, region: 'elsewhere' } }),
      change(base, 'subject', { resource: { ...base.subject.resource, sku: 'other' } }),
      change(base, 'subject', { windowStart: START + 1n }),
      change(base, 'subject', { windowDuration: base.subject.windowDuration + 1n }),
      { ...base, consideration: { kind: 'rate', amount: dollars(4), unit: 'gpu-hour' } },
      { ...base, consideration: { kind: 'rate', amount: dollars(3), unit: 'gpu-minute' } },
      { ...base, consideration: { kind: 'fixed', amount: dollars(3) } },
      change(base, 'remedies', { acceptBy: base.remedies.acceptBy - 1n }),
      change(base, 'remedies', { freeCancelBy: base.remedies.freeCancelBy - 1n }),
      change(base, 'remedies', { chargeDeadline: base.remedies.chargeDeadline + 1n }),
      change(base, 'remedies', { charges: [{ ...late, amount: late.amount + 1n }, noShow] }),
      change(base, 'remedies', { charges: [late, { ...noShow, earliest: noShow.earliest + 1n }] }),
      change(base, 'remedies', { charges: [noShow] }),
      change(base, 'resolution', { contestWindow: base.resolution.contestWindow + 1n }),
      change(base, 'resolution', { arbiter: OTHER }),
      change(base, 'resolution', { day90SupplierShareBps: 4999 }),
      change(base, 'backing', { amount: base.backing.amount - 1n }),
      change(base, 'backing', { releaseDate: base.backing.releaseDate + 1n }),
    ]
    const seen = new Set([hash])
    for (const t of changed) seen.add(termsHash(t, SALT))
    expect(seen.size).toBe(changed.length + 1)
  })

  it("reads the arbiter's address in any letter case as the same terms", () => {
    const upper = testnetDemoTerms(START, '0x00000000000000000000000000000000000ABCDE')
    const lower = change(upper, 'resolution', {
      arbiter: '0x00000000000000000000000000000000000abcde',
    })
    expect(termsHash(upper, SALT)).toBe(termsHash(lower, SALT))
  })

  it('needs a random 32-byte salt', () => {
    expect(() => termsHash(base, '0x1234')).toThrow()
    expect(() => termsHash(base, `0x${'00'.repeat(32)}`)).toThrow()
  })

  it('refuses a version it does not read', () => {
    expect(() =>
      termsHash({ ...base, version: 4 } as unknown as GpuReservationTerms, SALT),
    ).toThrow('terms.version_unknown')
  })
})

describe('how the hash is built, spelled out for other implementations', () => {
  it('derives each section salt with HKDF-SHA256, no HKDF salt and the section label as info', () => {
    for (const s of TERMS_SECTIONS) {
      const expected = toHex(
        new Uint8Array(
          hkdfSync(
            'sha256',
            Buffer.from(SALT.slice(2), 'hex'),
            Buffer.alloc(0),
            `avow:terms:v2:salt:${s}`,
            32,
          ),
        ),
      )
      expect(sectionSalt(SALT, s)).toBe(expected)
    }
    const salts = new Set(TERMS_SECTIONS.map((s) => sectionSalt(SALT, s)))
    expect(salts.size).toBe(5)
    expect(salts.has(SALT)).toBe(false)
  })

  it('hashes each section under its own label, salt and canonical JSON, and the header in the clear', () => {
    const salts = Object.fromEntries(TERMS_SECTIONS.map((s) => [s, sectionSalt(SALT, s)]))
    const contents: Record<TermsSection, unknown> = {
      subject: base.subject,
      consideration: base.consideration,
      remedies: base.remedies,
      resolution: { ...base.resolution, arbiter: base.resolution.arbiter.toLowerCase() },
      backing: base.backing,
    }
    const hashes = Object.fromEntries(
      TERMS_SECTIONS.map((s) => [
        s,
        keccak256(
          encodeAbiParameters(
            [{ type: 'string' }, { type: 'bytes32' }, { type: 'string' }],
            [`avow:terms:v2:${s}`, salts[s] as Hex, canonicalJson(contents[s])],
          ),
        ),
      ]),
    ) as Record<TermsSection, Hex>
    expect(sectionHashes(base, SALT)).toEqual(hashes)
    const header =
      '{"amountDecimals":6,"currency":"USD","template":"gpu-reservation/1","version":2}'
    expect(canonicalJson(termsHeader(base))).toBe(header)
    const expected = keccak256(
      encodeAbiParameters(
        [
          { type: 'string' },
          { type: 'string' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
        ],
        [
          'avow:terms:v2',
          header,
          hashes.subject,
          hashes.consideration,
          hashes.remedies,
          hashes.resolution,
          hashes.backing,
        ],
      ),
    )
    expect(termsHash(base, SALT)).toBe(expected)
    expect(termsHashFromSections(termsHeader(base), hashes)).toBe(expected)
  })

  it('hashes nothing a version 1 hash could have hashed, since the two differ at byte 32', () => {
    // A version 1 hash covers the salt and then the terms' JSON object, so its byte 32 is `{`.
    const v1 = testnetDemoTermsV1(START, ARBITER)
    const v1Json = canonicalJson({
      ...v1,
      dispute: { ...v1.dispute, arbiter: v1.dispute.arbiter.toLowerCase() },
    })
    const v1Preimage = concat([SALT, stringToHex(v1Json)])
    expect(keccak256(v1Preimage)).toBe(termsHashV1(v1, SALT))
    expect(hexToBytes(v1Preimage)[32]).toBe('{'.charCodeAt(0))
    // A version 2 hash covers an ABI encoding whose second word is the header's offset, a small
    // number, so its byte 32 is zero whatever the terms say.
    const hashes = sectionHashes(base, SALT)
    const v2Preimage = encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'string' },
        ...TERMS_SECTIONS.map(() => ({ type: 'bytes32' }) as const),
      ],
      [
        'avow:terms:v2',
        canonicalJson(termsHeader(base)),
        ...TERMS_SECTIONS.map((section) => hashes[section]),
      ],
    )
    expect(keccak256(v2Preimage)).toBe(termsHash(base, SALT))
    expect(hexToBytes(v2Preimage)[32]).toBe(0)
  })

  it('keeps sections apart, so the same content hashed as another section never matches', () => {
    const salt = sectionSalt(SALT, 'remedies')
    const asRemedies = sectionHash('remedies', base.remedies, salt)
    for (const s of TERMS_SECTIONS.filter((x) => x !== 'remedies')) {
      expect(sectionHash(s, base.remedies, salt)).not.toBe(asRemedies)
    }
  })
})

describe('the shape terms need before they are hashed', () => {
  it('passes version 2 terms with exactly the header and five sections, and version 1 terms', () => {
    expect(termsShapeProblem(base)).toBeNull()
    expect(termsShapeProblem(testnetDemoTermsV1(START, ARBITER))).toBeNull()
  })

  it('refuses terms missing a header field or a section as incomplete, before hashing them', () => {
    for (const field of ['template', 'currency', 'amountDecimals', ...TERMS_SECTIONS]) {
      const { [field as keyof typeof base]: _, ...missing } = base
      for (const t of [missing, { ...base, [field]: undefined }]) {
        expect(termsShapeProblem(t), field).toBe('terms.incomplete')
        expect(() => termsHash(t as GpuReservationTerms, SALT), field).toThrow('terms.incomplete')
        expect(validateTerms(t as GpuReservationTerms, TESTNET_DEMO_PROFILE), field).toBe(
          'terms.incomplete',
        )
      }
    }
  })

  it('reads terms with no version as version 1, whose checks refuse version 2 sections', () => {
    const { version: _, ...unversioned } = base
    expect(termsShapeProblem(unversioned)).toBeNull()
    expect(validateTerms(unversioned as never, TESTNET_DEMO_PROFILE)).not.toBeNull()
  })

  it('refuses a field beside the header and sections, which the hash would leave out', () => {
    const extra = { ...base, gracePeriod: 60n }
    expect(termsShapeProblem(extra)).toBe('terms.invalid')
    expect(() => termsHash(extra, SALT)).toThrow('terms.invalid')
    expect(validateTerms(extra, TESTNET_DEMO_PROFILE)).toBe('terms.invalid')
    expect(() => discloseSection(extra, SALT, 'subject')).toThrow('terms.invalid')
  })

  it('refuses another version, a section that is no object or a value canonical JSON cannot write', () => {
    expect(termsShapeProblem({ ...base, version: 3 })).toBe('terms.version_unknown')
    const resource = base.subject.resource
    const bad: unknown[] = [
      { ...base, remedies: null },
      { ...base, subject: [] },
      { ...base, backing: 'reserve' },
      change(base, 'subject', { resource: { ...resource, count: 1.5 } }),
      change(base, 'subject', { resource: { ...resource, region: '\ud800' } }),
      change(base, 'subject', { windowStart: new Date(0) as unknown as bigint }),
      null,
      [],
      'terms',
    ]
    bad.forEach((t, i) => {
      expect(termsShapeProblem(t), `case ${i}`).toBe('terms.invalid')
      expect(() => termsHash(t as GpuReservationTerms, SALT), `case ${i}`).toThrow('terms.invalid')
    })
  })
})

describe('showing one section', () => {
  const hash = termsHash(base, SALT)

  it('checks any one section against the terms hash, with only its own salt', () => {
    for (const s of TERMS_SECTIONS) {
      const shown = discloseSection(base, SALT, s)
      expect(Object.keys(shown.others).sort()).toEqual(TERMS_SECTIONS.filter((x) => x !== s).sort())
      expect(JSON.stringify(shown, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))).not.toContain(
        SALT.slice(2),
      )
      expect(checkSectionDisclosure(shown, hash)).toBeNull()
    }
  })

  it('shows the service and window without any price or charge', () => {
    const shown = discloseSection(base, SALT, 'subject')
    const text = JSON.stringify(shown, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))
    for (const secret of ['3000000', '250000000', '500000000']) expect(text).not.toContain(secret)
    expect(checkSectionDisclosure(shown, hash)).toBeNull()
  })

  it('refuses a changed section, another salt, another header, or missing or extra hashes', () => {
    const shown = discloseSection(base, SALT, 'remedies')
    const remedies = base.remedies
    const { backing: _, ...withoutBacking } = shown.others
    const bad = [
      { ...shown, content: { ...remedies, chargeDeadline: remedies.chargeDeadline + 1n } },
      { ...shown, salt: sectionSalt(SALT, 'backing') },
      { ...shown, salt: SALT },
      { ...shown, header: { ...shown.header, currency: 'EUR' as 'USD' } },
      { ...shown, others: { ...shown.others, subject: shown.others.backing as Hex } },
    ]
    for (const d of bad) expect(checkSectionDisclosure(d, hash)).toBe('terms.hash_mismatch')
    expect(checkSectionDisclosure({ ...shown, others: withoutBacking }, hash)).toBe('terms.invalid')
    expect(
      checkSectionDisclosure({ ...shown, others: { ...shown.others, remedies: hash } }, hash),
    ).toBe('terms.invalid')
    expect(
      checkSectionDisclosure(
        { ...shown, header: { ...shown.header, template: 'freight/1' as typeof GPU_RESERVATION } },
        hash,
      ),
    ).toBe('terms.template_unknown')
    expect(checkSectionDisclosure(shown, termsHash(base, `0x${'12'.repeat(32)}`))).toBe(
      'terms.hash_mismatch',
    )
  })

  it('binds the backing, so a changed backing changes the terms hash', () => {
    const otherBacking = change(base, 'backing', { amount: base.backing.amount + 1n })
    expect(termsHash(otherBacking, SALT)).not.toBe(hash)
    const shown = discloseSection(otherBacking, SALT, 'backing')
    expect(checkSectionDisclosure(shown, hash)).toBe('terms.hash_mismatch')
  })
})

describe('validateTerms', () => {
  it('accepts the demo terms under production and the testnet terms under the demo profile', () => {
    expect(validateTerms(demoTerms(START, ARBITER), PRODUCTION_PROFILE)).toBeNull()
    expect(validateTerms(base, TESTNET_DEMO_PROFILE)).toBeNull()
  })

  it("refuses the testnet's 10-minute contest window under production", () => {
    expect(validateTerms(base, PRODUCTION_PROFILE)).toBe('terms.contest_window_short')
  })

  it('refuses a version or template it does not know', () => {
    const v3 = { ...base, version: 3 } as unknown as GpuReservationTerms
    expect(validateTerms(v3, TESTNET_DEMO_PROFILE)).toBe('terms.version_unknown')
    const freight = { ...base, template: 'freight/1' } as unknown as GpuReservationTerms
    expect(validateTerms(freight, TESTNET_DEMO_PROFILE)).toBe('terms.template_unknown')
  })

  it('knows only its own templates and charge kinds, never a name every object inherits', () => {
    const [late, noShow] = base.remedies.charges
    if (!late || !noShow) throw new Error('two charges')
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const template = { ...base, template: name } as unknown as GpuReservationTerms
      expect(validateTerms(template, TESTNET_DEMO_PROFILE), name).toBe('terms.template_unknown')
      const charges = [{ ...late, kind: name }, noShow] as typeof base.remedies.charges
      const kind = change(base, 'remedies', { charges })
      expect(validateTerms(kind, TESTNET_DEMO_PROFILE), name).toBe('terms.charges_invalid')
    }
  })

  it('needs amounts written in millionths of the currency', () => {
    const t = { ...base, amountDecimals: 18 } as unknown as GpuReservationTerms
    expect(validateTerms(t, TESTNET_DEMO_PROFILE)).toBe('terms.invalid')
  })

  it('refuses a backing or side a lock cannot enforce', () => {
    for (const backing of [
      { ...base.backing, kind: 'partner' },
      { ...base.backing, kind: 'payment' },
      { ...base.backing, side: 'supplier' },
    ]) {
      const t = { ...base, backing } as unknown as GpuReservationTerms
      expect(validateTerms(t, TESTNET_DEMO_PROFILE)).toBe('terms.backing_unsupported')
    }
  })

  it('needs the reserve to equal the largest charge', () => {
    for (const amount of [dollars(499), dollars(600)]) {
      expect(validateTerms(change(base, 'backing', { amount }), TESTNET_DEMO_PROFILE)).toBe(
        'terms.reserve_mismatch',
      )
    }
    const [late, noShow] = base.remedies.charges
    if (!late || !noShow) throw new Error('two charges')
    const lateLarger = change(
      change(base, 'remedies', { charges: [{ ...late, amount: dollars(700) }, noShow] }),
      'backing',
      { amount: dollars(700) },
    )
    expect(validateTerms(lateLarger, TESTNET_DEMO_PROFILE)).toBeNull()
  })

  it('needs one of each charge kind at most, in the lock order, each with an amount', () => {
    const [late, noShow] = base.remedies.charges
    if (!late || !noShow) throw new Error('two charges')
    for (const charges of [
      [],
      [noShow, late],
      [noShow, noShow],
      [{ ...late, amount: 0n }, noShow],
      [{ ...late, kind: 'minimumUse' }, noShow],
      [late, noShow, late, noShow, late],
    ]) {
      const t = change(base, 'remedies', { charges: charges as typeof base.remedies.charges })
      expect(validateTerms(t, TESTNET_DEMO_PROFILE), JSON.stringify(charges.length)).toBe(
        'terms.charges_invalid',
      )
    }
  })

  it('needs every deadline in order', () => {
    const r = base.remedies
    const end = START + base.subject.windowDuration
    const bad = [
      change(base, 'remedies', { chargeDeadline: end - 1n }),
      change(base, 'remedies', { acceptBy: START + 1n }),
      change(base, 'remedies', { freeCancelBy: START + 1n }),
      change(base, 'backing', { releaseDate: r.chargeDeadline - 1n }),
      change(base, 'subject', { windowDuration: 0n }),
      change(base, 'remedies', {
        charges: r.charges.map((c) =>
          c.kind === 'noShow' ? { ...c, earliest: r.chargeDeadline } : c,
        ),
      }),
      change(base, 'remedies', {
        charges: r.charges.map((c) => (c.kind === 'noShow' ? { ...c, earliest: START - 1n } : c)),
      }),
    ]
    for (const t of bad) {
      expect(validateTerms(t, TESTNET_DEMO_PROFILE)).toBe('terms.deadlines_out_of_order')
    }
  })

  it('needs a real arbiter and a share from 0 to 10,000', () => {
    const bad = [
      { arbiter: '0x0000000000000000000000000000000000000000' as Address },
      { arbiter: '0x1234' as Address },
      { day90SupplierShareBps: -1 },
      { day90SupplierShareBps: 10_001 },
    ]
    for (const patch of bad) {
      expect(validateTerms(change(base, 'resolution', patch), TESTNET_DEMO_PROFILE)).toBe(
        'terms.dispute_invalid',
      )
    }
    // A share that isn't a whole number can't be hashed, so it never reaches the dispute check.
    const fractional = change(base, 'resolution', { day90SupplierShareBps: 50.5 })
    expect(validateTerms(fractional, TESTNET_DEMO_PROFILE)).toBe('terms.invalid')
    for (const day90SupplierShareBps of [0, 10_000]) {
      const t = change(base, 'resolution', { day90SupplierShareBps })
      expect(validateTerms(t, TESTNET_DEMO_PROFILE)).toBeNull()
    }
  })

  it("applies the GPU reservation template's own rules", () => {
    const late = base.remedies.charges[0]
    if (!late) throw new Error('a late cancellation charge')
    const bad: [GpuReservationTerms, string][] = [
      [{ ...base, consideration: { kind: 'fixed', amount: dollars(3) } }, 'terms.template_invalid'],
      [
        {
          ...base,
          consideration: { kind: 'fixed', amount: dollars(3), unit: GPU_HOUR } as never,
        },
        'terms.template_invalid',
      ],
      [
        { ...base, consideration: { kind: 'rate', amount: dollars(3), unit: 'hour' } },
        'terms.template_invalid',
      ],
      [
        change(base, 'subject', { resource: { ...base.subject.resource, count: 0 } }),
        'terms.template_invalid',
      ],
      [
        change(base, 'subject', { resource: { ...base.subject.resource, gpu: '' } }),
        'terms.template_invalid',
      ],
      [
        change(base, 'subject', { resource: { ...base.subject.resource, region: '' } }),
        'terms.template_invalid',
      ],
      [
        change(base, 'subject', { resource: { ...base.subject.resource, sku: '' } }),
        'terms.template_invalid',
      ],
      [
        change(base, 'remedies', {
          charges: [{ ...late, earliest: late.earliest - 1n }, ...base.remedies.charges.slice(1)],
        }),
        'terms.template_invalid',
      ],
      [
        // A wrong consideration is reported before a window with no length.
        change({ ...base, consideration: { kind: 'fixed', amount: dollars(3) } }, 'subject', {
          windowDuration: 0n,
        }),
        'terms.template_invalid',
      ],
    ]
    for (const [t, reason] of bad) expect(validateTerms(t, TESTNET_DEMO_PROFILE)).toBe(reason)
  })

  it('accepts each GPU reservation deadline at its limit', () => {
    const r = base.remedies
    const [late, noShow] = r.charges
    if (!late || !noShow) throw new Error('two charges')
    const end = START + base.subject.windowDuration
    const atLimits = [
      // Free cancellation up to the window's start, with the late cancellation chargeable from it.
      change(base, 'remedies', {
        freeCancelBy: START,
        charges: [{ ...late, earliest: START }, noShow],
      }),
      // A no-show chargeable from the window's start, with no grace period.
      change(base, 'remedies', { charges: [late, { ...noShow, earliest: START }] }),
      // The window ending at the charge deadline.
      change(base, 'remedies', { chargeDeadline: end }),
    ]
    for (const t of atLimits) expect(validateTerms(t, TESTNET_DEMO_PROFILE)).toBeNull()
    expect(r.acceptBy).toBe(START)
  })
})

describe('what the lock enforces', () => {
  it('maps version 2 demo terms to exactly the values version 1 mapped the same booking to', () => {
    const v1 = testnetDemoTermsV1(START, ARBITER)
    expect(lockTerms(base, 6)).toEqual(lockTerms(v1, 6))
    expect(lockTerms(base, 18)).toEqual(lockTerms(v1, 18))
    expect(enforceableTerms(base)).toEqual(enforceableTerms(v1))
  })

  it("gives the lock's charges in the token's base units, and the grace period from the no-show", () => {
    expect(termsCharges(base, 6)).toEqual([
      { kind: 'lateCancellation', most: 250_000_000n, earliest: base.remedies.freeCancelBy },
      { kind: 'noShow', most: 500_000_000n, earliest: START + 120n },
    ])
    expect(termsCharges(base, 18)[1]?.most).toBe(500n * 10n ** 18n)
    expect(gpuGracePeriod(base)).toBe(120n)
  })

  it("names the side the backing secures, and version 1 terms back the buyer's side", () => {
    expect(lockTerms(base, 6).side).toBe('buyer')
    expect(enforceableTerms(testnetDemoTermsV1(START, ARBITER)).side).toBe('buyer')
  })

  it('leaves out a charge the booking sets to zero', () => {
    const t = testnetDemoTerms(START, ARBITER)
    const onlyNoShow = change(t, 'remedies', { charges: t.remedies.charges.slice(1) })
    expect(termsCharges(onlyNoShow, 6).map((c) => c.kind)).toEqual(['noShow'])
  })
})

describe('approvalTermsProblem', () => {
  const lock = lockTerms(base, 6)
  const hash = termsHash(base, SALT)
  const approval = { ...lock, termsHash: hash } satisfies Partial<Approval>

  it('passes an approval built from the terms', () => {
    expect(approvalTermsProblem(approval, { lock, termsHash: hash })).toBeNull()
  })

  it('refuses an approval that differs from the terms in any enforced field', () => {
    const [late, noShow] = lock.charges
    if (!late || !noShow) throw new Error('two charges')
    const cases: [Partial<typeof approval>, string][] = [
      [{ side: 'supplier' }, 'approval.terms_mismatch'],
      [{ amount: lock.amount - 1n }, 'approval.terms_mismatch'],
      [{ freeCancelBy: lock.freeCancelBy + 1n }, 'approval.terms_mismatch'],
      [{ acceptBy: lock.acceptBy + 1n }, 'approval.terms_mismatch'],
      [{ chargeDeadline: lock.chargeDeadline + 1n }, 'approval.terms_mismatch'],
      [{ releaseDate: lock.releaseDate + 1n }, 'approval.terms_mismatch'],
      [{ contestWindow: lock.contestWindow + 1n }, 'approval.terms_mismatch'],
      [{ termsHash: termsHash(base, `0x${'12'.repeat(32)}`) }, 'approval.terms_mismatch'],
      [{ charges: [late] }, 'approval.charges_mismatch'],
      [{ charges: [{ ...late, most: late.most + 1n }, noShow] }, 'approval.charges_mismatch'],
      [
        { charges: [late, { ...noShow, earliest: noShow.earliest - 1n }] },
        'approval.charges_mismatch',
      ],
      [{ day90SupplierShareBps: 4000 }, 'approval.dispute_mismatch'],
      [{ arbiter: OTHER }, 'approval.dispute_mismatch'],
    ]
    for (const [patch, reason] of cases) {
      expect(approvalTermsProblem({ ...approval, ...patch }, { lock, termsHash: hash })).toBe(
        reason,
      )
    }
  })
})

describe('the lock-enforced fields every check compares', () => {
  const lock = lockTerms(base, 6)
  const hash = termsHash(base, SALT)
  const [late, noShow] = lock.charges
  if (!late || !noShow) throw new Error('two charges')
  // One change to each lock-enforced field, and the reason an approval with it gets. Both are
  // typed over every field, so a field added to LockTerms fails the type check here until it has
  // a change and a reason, and then every test below checks each comparison catches it.
  const changed: { readonly [K in LockTermsField]: LockTerms[K] } = {
    side: 'supplier',
    amount: lock.amount + 1n,
    freeCancelBy: lock.freeCancelBy + 1n,
    acceptBy: lock.acceptBy - 1n,
    chargeDeadline: lock.chargeDeadline + 1n,
    releaseDate: lock.releaseDate + 1n,
    contestWindow: lock.contestWindow + 1n,
    charges: [late, { ...noShow, most: noShow.most - 1n }],
    day90SupplierShareBps: lock.day90SupplierShareBps + 1,
    arbiter: OTHER,
  }
  const reasons: { readonly [K in LockTermsField]: ReasonCode } = {
    side: 'approval.terms_mismatch',
    amount: 'approval.terms_mismatch',
    freeCancelBy: 'approval.terms_mismatch',
    acceptBy: 'approval.terms_mismatch',
    chargeDeadline: 'approval.terms_mismatch',
    releaseDate: 'approval.terms_mismatch',
    contestWindow: 'approval.terms_mismatch',
    charges: 'approval.charges_mismatch',
    day90SupplierShareBps: 'approval.dispute_mismatch',
    arbiter: 'approval.dispute_mismatch',
  }
  const withChange = (f: LockTermsField): LockTerms => ({ ...lock, [f]: changed[f] })

  it('lists every field lockTerms gives, once', () => {
    expect([...LOCK_TERMS_FIELDS].sort()).toEqual(Object.keys(lock).sort())
    expect(new Set(LOCK_TERMS_FIELDS).size).toBe(LOCK_TERMS_FIELDS.length)
  })

  it('finds a change to any one field, and only that field', () => {
    expect(lockTermsDifferences(lock, lock, LOCK_TERMS_FIELDS)).toEqual([])
    for (const f of LOCK_TERMS_FIELDS) {
      expect(lockTermsDifferences(withChange(f), lock, LOCK_TERMS_FIELDS), f).toEqual([f])
    }
    // An arbiter in other letter case is the same arbiter.
    const upper = { ...lock, arbiter: lock.arbiter.toUpperCase().replace('0X', '0x') as Address }
    expect(lockTermsDifferences(upper, lock, LOCK_TERMS_FIELDS)).toEqual([])
  })

  it("refuses an approval that differs in any field, with that field's reason", () => {
    for (const f of LOCK_TERMS_FIELDS) {
      const approval = { ...withChange(f), termsHash: hash }
      expect(approvalTermsProblem(approval, { lock, termsHash: hash }), f).toBe(reasons[f])
    }
  })

  it("compares a lock's record in every field but the side, whatever order either side lists charges in", () => {
    expect(LOCK_RECORD_FIELDS).toEqual(LOCK_TERMS_FIELDS.filter((f) => f !== 'side'))
    for (const f of LOCK_RECORD_FIELDS) {
      expect(lockRecordDifferences(withChange(f), lock), f).toEqual([f])
    }
    // A record names its side by where it's read from, so the side isn't one of its fields.
    expect(lockRecordDifferences(withChange('side'), lock)).toEqual([])
    // The lock stores charges by kind, so neither side's charges have an order that counts.
    const reversed = { ...lock, charges: [noShow, late] }
    expect(lockRecordDifferences(reversed, lock)).toEqual([])
    expect(lockRecordDifferences(lock, reversed)).toEqual([])
    expect(lockRecordDifferences(reversed, reversed)).toEqual([])
    expect(lockRecordDifferences({ ...lock, charges: [noShow] }, lock)).toEqual(['charges'])
    expect(lockRecordDifferences(lock, { ...lock, charges: [noShow] })).toEqual(['charges'])
    // Out of order, a changed charge is still found.
    const changedNoShow = { ...noShow, most: noShow.most - 1n }
    expect(lockRecordDifferences(lock, { ...lock, charges: [changedNoShow, late] })).toEqual([
      'charges',
    ])
  })

  it('compares a supplier authorization in the four lock-enforced fields it carries', () => {
    expect([...AUTHORIZATION_TERMS_FIELDS]).toEqual([
      'amount',
      'acceptBy',
      'chargeDeadline',
      'releaseDate',
    ])
    for (const f of AUTHORIZATION_TERMS_FIELDS) {
      expect(lockTermsDifferences(withChange(f), lock, AUTHORIZATION_TERMS_FIELDS), f).toEqual([f])
    }
  })

  it('compares charges in order, in every field the signed Charge type holds', () => {
    expect(sameCharges(lock.charges, [late, noShow])).toBe(true)
    expect(sameCharges(lock.charges, [noShow, late])).toBe(false)
    expect(sameCharges(lock.charges, [late])).toBe(false)
    const changes: Partial<Charge>[] = [
      { kind: 'noShow' },
      { most: late.most + 1n },
      { earliest: late.earliest + 1n },
    ]
    for (const change of changes) {
      expect(sameCharges(lock.charges, [{ ...late, ...change }, noShow])).toBe(false)
    }
  })
})

describe("the approval's parties, token and mandate", () => {
  const ACCOUNT: Address = '0x00000000000000000000000000000000000000c1'
  const SIGNER: Address = '0x00000000000000000000000000000000000000c3'
  const PAYOUT: Address = '0x00000000000000000000000000000000000000c5'
  const AGENT: Address = '0x00000000000000000000000000000000000000a1'
  const TOKEN: Address = '0x20c0000000000000000000000000000000000001'
  const MANDATE = keccak256(stringToHex('mandate'))
  const parties = { account: ACCOUNT, signingKey: SIGNER, payee: PAYOUT }
  const named = { supplier: ACCOUNT, supplierSigner: SIGNER, payee: PAYOUT }
  const caps = { capPerCommitment: dollars(500), capOpenReserves: dollars(1500) }

  it("passes an approval naming the supplier's own parties, in any letter case", () => {
    expect(approvalPartiesProblem(named, parties)).toBeNull()
    const upper = (a: Address) => a.toUpperCase().replace('0X', '0x') as Address
    expect(approvalPartiesProblem(named, { ...parties, payee: upper(PAYOUT) })).toBeNull()
  })

  it('refuses another supplier account, signing key or payout', () => {
    for (const change of [{ supplier: OTHER }, { supplierSigner: OTHER }, { payee: OTHER }]) {
      expect(approvalPartiesProblem({ ...named, ...change }, parties)).toBe(
        'approval.parties_mismatch',
      )
    }
  })

  it("refuses a token other than the lock's", () => {
    expect(approvalTokenProblem({ token: TOKEN }, TOKEN)).toBeNull()
    expect(approvalTokenProblem({ token: OTHER }, TOKEN)).toBe('approval.terms_mismatch')
  })

  it("gives the mandate's caps in the token's base units, and throws on one it can't hold", () => {
    expect(approvalCaps(caps, 6)).toEqual(caps)
    expect(approvalCaps(caps, 18)).toEqual({
      capPerCommitment: 500n * 10n ** 18n,
      capOpenReserves: 1500n * 10n ** 18n,
    })
    expect(() => approvalCaps({ ...caps, capPerCommitment: 1n }, 2)).toThrow(RangeError)
  })

  it('refuses another mandate, other caps, or a funding key the caller does not allow', () => {
    const approval = { mandateHash: MANDATE, ...caps, fundingKey: AGENT }
    const expected = { mandateHash: MANDATE, caps, fundingKeys: [AGENT] }
    expect(approvalMandateProblem(approval, expected)).toBeNull()
    const changes = [
      { mandateHash: keccak256(stringToHex('another mandate')) },
      { capPerCommitment: caps.capPerCommitment + 1n },
      { capOpenReserves: caps.capOpenReserves - 1n },
      { fundingKey: zeroAddress },
    ]
    for (const change of changes) {
      expect(approvalMandateProblem({ ...approval, ...change }, expected)).toBe(
        'approval.mandate_mismatch',
      )
    }
    // The account's root key, the zero address, funds only where the caller allows it.
    const byRoot = { ...approval, fundingKey: zeroAddress }
    expect(
      approvalMandateProblem(byRoot, { ...expected, fundingKeys: [AGENT, zeroAddress] }),
    ).toBeNull()
  })
})
