import { hkdfSync } from 'node:crypto'
import { encodeAbiParameters, type Hex, keccak256, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical.js'
import { dollars, testnetDemoTerms } from './demo.js'
import {
  chainedTerms,
  type Dependencies,
  type Dependency,
  dependenciesProblem,
  isChainedTerms,
  MAX_DEPENDENCIES,
  subjectFits,
  subjectProblem,
} from './dependencies.js'
import { type GpuSubject, gpuReservationTerms, gpuSubjectFits } from './gpu-reservation.js'
import { checkMandate } from './mandate.js'
import { TESTNET_DEMO_PROFILE } from './profiles.js'
import { describeReason, type ReasonCode } from './reasons.js'
import type { CommitmentReference } from './references.js'
import {
  CHAINED_TERMS_SECTIONS,
  chainedTermsShapeProblem,
  checkSectionDisclosure,
  discloseSection,
  lockTerms,
  plainTermsOf,
  sectionHash,
  sectionHashes,
  sectionSalt,
  TERMS_SECTIONS,
  termsHash,
  termsHeader,
  termsShapeProblem,
  validateChainedTerms,
  validateTerms,
} from './terms.js'
import { testnetDemoTermsV1 } from './terms-v1.js'
import {
  ARBITER,
  CHAIN_ID,
  demoMandate,
  demoRequest,
  id,
  LOCK,
  NOW,
  newKey,
  OTHER_LOCK,
  START,
  TOKEN,
} from './test-helpers.js'
import type { ChainedTerms } from './types.js'
import {
  parseAnyTerms,
  parseChainedTerms,
  parseCommitment,
  parseReserveRequest,
  parseSectionDisclosure,
  parseTerms,
  toWire,
} from './wire.js'

const SALT = `0x${'33'.repeat(32)}` as const
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(toWire(value)))

/** The reseller's booking with GPU cloud, a plain version 2 booking of 8 H100s. */
const upstream = gpuReservationTerms({
  resource: { gpu: 'H100', count: 8, region: 'demo', sku: 'cloud-h100x8' },
  currency: 'USD',
  windowStart: START,
  windowDuration: 3600n,
  pricePerGpuHour: 2_170_000n,
  freeCancelBy: START - 600n,
  lateCancellation: dollars(123),
  noShow: dollars(321),
  gracePeriod: 120n,
  chargeDeadline: START + 3600n,
  contestWindow: 600n,
  releaseDate: START + 3600n,
  arbiter: ARBITER,
  day90SupplierShareBps: 5000,
})
const UPSTREAM_SALT = `0x${'77'.repeat(32)}` as const
const UPSTREAM_HASH = termsHash(upstream, UPSTREAM_SALT)

/** A dependency on the upstream booking. A change can make one the types forbid, for the checks. */
const entry = (change: Partial<CommitmentReference> = {}): Dependency => ({
  on: {
    kind: 'commitment',
    chainId: CHAIN_ID,
    lock: LOCK,
    commitmentId: id('upstream'),
    side: 'buyer',
    termsHash: UPSTREAM_HASH,
    ...change,
  } as Dependency['on'],
  condition: 'accepted',
  disclosed: 'subject',
})

const plain = testnetDemoTerms(START, ARBITER)
const chained = chainedTerms(plain, [entry()])

/** Terms as JSON with another dependencies section. */
const withEntriesOf = (t: ChainedTerms, dependencies: unknown) => ({
  ...roundTrip(t),
  dependencies,
})

describe('version 3 terms', () => {
  it('are version 2 terms with one more section, and only version 3 has it', () => {
    expect(chained).toEqual({
      ...plain,
      version: 3,
      dependencyCheck: 'buyer',
      dependencies: [entry()],
    })
    expect(isChainedTerms(chained)).toBe(true)
    expect(isChainedTerms(plain)).toBe(false)
    for (const notTerms of [null, undefined, 'terms', 3])
      expect(isChainedTerms(notTerms)).toBe(false)
    expect(chainedTermsShapeProblem(chained)).toBeNull()
    expect(validateChainedTerms(chained, TESTNET_DEMO_PROFILE)).toBeNull()
  })

  it('make the plain booking they describe, which the lock enforces exactly', () => {
    expect(plainTermsOf(chained)).toEqual(plain)
    expect(lockTerms(plainTermsOf(chained), 6)).toEqual(lockTerms(plain, 6))
    expect(termsHash(plainTermsOf(chained), SALT)).not.toBe(termsHash(chained, SALT))
  })

  it('pass the same core and template checks version 2 does', () => {
    const late = { ...plain.remedies, acceptBy: plain.remedies.chargeDeadline }
    expect(
      validateChainedTerms(
        chainedTerms({ ...plain, remedies: late }, [entry()]),
        TESTNET_DEMO_PROFILE,
      ),
    ).toBe(validateTerms({ ...plain, remedies: late }, TESTNET_DEMO_PROFILE))
    const resource = { ...plain.subject.resource, count: 0 }
    const empty = { ...plain, subject: { ...plain.subject, resource } }
    expect(validateChainedTerms(chainedTerms(empty, [entry()]), TESTNET_DEMO_PROFILE)).toBe(
      'terms.template_invalid',
    )
  })

  it('are read only by the version 3 functions, which refuse every other version', () => {
    expect(chainedTermsShapeProblem(plain)).toBe('terms.version_unknown')
    expect(chainedTermsShapeProblem(testnetDemoTermsV1(START, ARBITER))).toBe(
      'terms.version_unknown',
    )
    expect(validateChainedTerms(plain as never, TESTNET_DEMO_PROFILE)).toBe('terms.version_unknown')
    expect(parseChainedTerms(roundTrip(plain))).toEqual({
      ok: false,
      reason: 'terms.version_unknown',
    })
  })
})

describe('every check a plain booking goes through', () => {
  const agent = newKey()
  const mandate = demoMandate(newKey().address, agent.address)
  const request = { ...demoRequest(agent.address), terms: chained as never }

  it('refuses version 3 terms as a version it does not read, as before version 3 existed', () => {
    expect(termsShapeProblem(chained)).toBe('terms.version_unknown')
    expect(validateTerms(chained as never, TESTNET_DEMO_PROFILE)).toBe('terms.version_unknown')
    expect(parseAnyTerms(roundTrip(chained))).toEqual({
      ok: false,
      reason: 'terms.version_unknown',
    })
    expect(() => parseReserveRequest(roundTrip(request))).toThrow()
  })

  it('so the mandate check never approves a booking whose dependencies nobody read', () => {
    const decision = checkMandate({
      mandate,
      request,
      token: TOKEN,
      openReserves: 0n,
      revoked: false,
      now: NOW,
      profile: TESTNET_DEMO_PROFILE,
    })
    expect(decision).toEqual({ result: 'denied', reason: 'terms.version_unknown' })
    const plainDecision = checkMandate({
      mandate,
      request: demoRequest(agent.address),
      token: TOKEN,
      openReserves: 0n,
      revoked: false,
      now: NOW,
      profile: TESTNET_DEMO_PROFILE,
    })
    expect(plainDecision.result).not.toBe('denied')
  })

  it('keeps a commitment record from holding version 3 terms', () => {
    const record = {
      schemaVersion: '3',
      commitmentId: id('downstream'),
      category: 'compute',
      buyer: { businessId: 'biz_training', agentId: 'agt_1', mandateId: id('mandate') },
      supplier: { businessId: 'biz_reseller', agentId: null },
      terms: chained,
      termsHash: termsHash(chained, SALT),
      state: 'draft',
      backing: [],
      start: null,
      contest: null,
      outcome: null,
      references: [],
    }
    expect(parseCommitment(roundTrip(record))).toEqual({ ok: false, reason: 'message.invalid' })
    expect(parseCommitment(roundTrip({ ...record, terms: plain })).ok).toBe(true)
  })
})

describe('a reader that knows only version 2', () => {
  it('refuses version 3 terms as a version it does not read', () => {
    expect(parseTerms(roundTrip(chained))).toEqual({ ok: false, reason: 'terms.version_unknown' })
  })

  it('refuses them relabelled as version 2, since the hash would leave the dependencies out', () => {
    const relabelled = { ...chained, version: 2 }
    expect(termsShapeProblem(relabelled)).toBe('terms.invalid')
    expect(chainedTermsShapeProblem(relabelled)).toBe('terms.version_unknown')
    expect(() => termsHash(relabelled as never, SALT)).toThrow('terms.invalid')
    expect(parseTerms(roundTrip(relabelled))).toEqual({ ok: false, reason: 'terms.invalid' })
  })

  it("can't match a version 3 hash by dropping the dependencies", () => {
    expect(termsHash(plain, SALT)).not.toBe(termsHash(chained, SALT))
    const shown = discloseSection(chained, SALT, 'subject')
    const { dependencies: _, ...four } = shown.others
    const asV2 = { ...shown, header: termsHeader(plain), others: four }
    expect(checkSectionDisclosure(asV2, termsHash(chained, SALT))).toBe('terms.hash_mismatch')
  })
})

describe('the dependencies section', () => {
  const withEntries = (dependencies: unknown) => ({ ...roundTrip(chained), dependencies })
  const json = roundTrip(entry())

  it('holds one to four entries', () => {
    const four = [1, 2, 3, 4].map((n) => entry({ commitmentId: id(`upstream ${n}`) }))
    const five = [...four, entry({ commitmentId: id('upstream 5') })]
    expect(MAX_DEPENDENCIES).toBe(4)
    expect(
      validateChainedTerms(
        chainedTerms(plain, four as unknown as Dependencies),
        TESTNET_DEMO_PROFILE,
      ),
    ).toBeNull()
    expect(parseChainedTerms(withEntries(roundTrip(four))).ok).toBe(true)
    for (const list of [[], five]) {
      const t = { ...chained, dependencies: list } as unknown as ChainedTerms
      expect(validateChainedTerms(t, TESTNET_DEMO_PROFILE), `${list.length}`).toBe('terms.invalid')
      expect(parseChainedTerms(withEntries(roundTrip(list))), `${list.length}`).toEqual({
        ok: false,
        reason: 'terms.invalid',
      })
    }
  })

  it('refuses a condition or a disclosed section this version does not know', () => {
    const bad = [
      { ...json, condition: 'reserved' },
      { ...json, condition: 'released' },
      { ...json, disclosed: 'consideration' },
      { ...json, disclosed: 'remedies' },
    ]
    for (const d of bad) {
      expect(parseChainedTerms(withEntries([d]))).toEqual({ ok: false, reason: 'terms.invalid' })
      const t = { ...chained, dependencies: [{ ...entry(), ...d, on: entry().on }] }
      expect(validateChainedTerms(t as unknown as ChainedTerms, TESTNET_DEMO_PROFILE)).toBe(
        'terms.invalid',
      )
    }
  })

  it('refuses two entries naming the same booking, whatever terms hash each gives', () => {
    const again = entry({ termsHash: id('other terms') })
    const t = chainedTerms(plain, [entry(), again])
    expect(validateChainedTerms(t, TESTNET_DEMO_PROFILE)).toBe('terms.invalid')
    expect(parseChainedTerms(roundTrip(t))).toEqual({ ok: false, reason: 'terms.invalid' })
    const sameInOtherCase = entry({ lock: LOCK.toUpperCase().replace('0X', '0x') as Hex })
    expect(dependenciesProblem([entry(), sameInOtherCase])).toBe('terms.invalid')
    expect(parseChainedTerms(withEntries(roundTrip([entry(), sameInOtherCase])))).toEqual({
      ok: false,
      reason: 'terms.invalid',
    })
    // Another lock, commitment or chain is another booking.
    for (const other of [
      entry({ lock: OTHER_LOCK }),
      entry({ commitmentId: id('another') }),
      entry({ chainId: CHAIN_ID + 1 }),
    ]) {
      expect(dependenciesProblem([entry(), other])).toBeNull()
    }
  })

  it('refuses entries that are not well-formed references, or hold more than their fields', () => {
    const on = entry().on
    const bad: unknown[] = [
      [{ ...entry(), extra: 1 }],
      [{ ...entry(), on: { ...on, extra: 1 } }],
      [{ ...entry(), on: { ...on, kind: 'payment' } }],
      [{ ...entry(), on: { ...on, chainId: 0 } }],
      [{ ...entry(), on: { ...on, chainId: 1.5 } }],
      [{ ...entry(), on: { ...on, lock: '0x1234' } }],
      [{ ...entry(), on: { ...on, commitmentId: '0x1234' } }],
      [{ ...entry(), on: { ...on, termsHash: 'none' } }],
      [{ ...entry(), on: { ...on, side: 'both' } }],
      [entry({ side: 'supplier' })],
      [{ condition: 'accepted', disclosed: 'subject' }],
      [{ ...entry(), on: null }],
      [null],
      'not a list',
      entry(),
    ]
    bad.forEach((d, i) => {
      expect(dependenciesProblem(d), `case ${i}`).toBe('terms.invalid')
    })
    // A booking relied on is on the buyer side, so the parser refuses the supplier side too.
    expect(parseChainedTerms(withEntries([roundTrip(entry({ side: 'supplier' }))]))).toEqual({
      ok: false,
      reason: 'terms.invalid',
    })
  })

  it('needs the section, as a list', () => {
    const { dependencies: _, ...missing } = chained
    expect(chainedTermsShapeProblem(missing)).toBe('terms.incomplete')
    expect(chainedTermsShapeProblem({ ...chained, dependencies: undefined })).toBe(
      'terms.incomplete',
    )
    expect(chainedTermsShapeProblem({ ...chained, dependencies: entry() })).toBe('terms.invalid')
    expect(parseChainedTerms({ ...roundTrip(chained), dependencies: json })).toEqual({
      ok: false,
      reason: 'terms.invalid',
    })
  })
})

describe('who checks the bookings relied on', () => {
  const byAvow = chainedTerms(plain, [entry()], 'avow')

  it('is the buyer unless the terms say Avow, one setting in the header for the whole section', () => {
    expect(chained.dependencyCheck).toBe('buyer')
    expect(byAvow.dependencyCheck).toBe('avow')
    expect(termsHeader(byAvow)).toEqual({ ...termsHeader(chained), dependencyCheck: 'avow' })
    for (const t of [chained, byAvow]) {
      expect(chainedTermsShapeProblem(t)).toBeNull()
      expect(validateChainedTerms(t, TESTNET_DEMO_PROFILE)).toBeNull()
      expect(parseChainedTerms(roundTrip(t))).toEqual({
        ok: true,
        value: { ...t, resolution: { ...t.resolution, arbiter: ARBITER.toLowerCase() } },
      })
    }
  })

  it('is part of the terms hash, so the same booking under the other setting is other terms', () => {
    expect(termsHash(byAvow, SALT)).not.toBe(termsHash(chained, SALT))
    // Every section hashes the same, and only the header differs.
    expect(sectionHashes(byAvow, SALT)).toEqual(sectionHashes(chained, SALT))
  })

  it('refuses a setting version 3 does not know, or none', () => {
    const unknown = { ...chained, dependencyCheck: 'seller' } as unknown as ChainedTerms
    expect(chainedTermsShapeProblem(unknown)).toBe('terms.invalid')
    expect(validateChainedTerms(unknown, TESTNET_DEMO_PROFILE)).toBe('terms.invalid')
    expect(parseChainedTerms(roundTrip(unknown))).toEqual({ ok: false, reason: 'terms.invalid' })
    const { dependencyCheck: _, ...none } = chained
    expect(chainedTermsShapeProblem(none)).toBe('terms.incomplete')
    expect(parseChainedTerms(roundTrip(none))).toEqual({ ok: false, reason: 'terms.invalid' })
  })

  it('never sits in an entry, so one section can never mix the two', () => {
    const mixed = [{ ...entry(), dependencyCheck: 'avow' }, entry({ commitmentId: id('second') })]
    expect(dependenciesProblem(mixed)).toBe('terms.invalid')
    expect(parseChainedTerms(withEntriesOf(byAvow, roundTrip(mixed)))).toEqual({
      ok: false,
      reason: 'terms.invalid',
    })
  })

  it('is left out of the plain booking the terms make, which the lock enforces exactly', () => {
    expect(plainTermsOf(byAvow)).toEqual(plain)
    expect(termsShapeProblem(plainTermsOf(byAvow))).toBeNull()
    expect(lockTerms(plainTermsOf(byAvow), 6)).toEqual(lockTerms(plain, 6))
  })

  it('travels in the header of every section shown on its own, where the hash covers it', () => {
    const shown = discloseSection(byAvow, SALT, 'subject')
    expect(shown.header).toEqual(termsHeader(byAvow))
    expect(checkSectionDisclosure(shown, termsHash(byAvow, SALT))).toBeNull()
    const relabelled = {
      ...shown,
      header: { ...termsHeader(byAvow), dependencyCheck: 'buyer' as const },
    }
    expect(checkSectionDisclosure(relabelled, termsHash(byAvow, SALT))).toBe('terms.hash_mismatch')
    const parsed = parseSectionDisclosure(roundTrip(shown))
    expect(parsed.ok && parsed.value.header).toEqual(termsHeader(byAvow))
    const { dependencyCheck: _, ...noSetting } = termsHeader(byAvow)
    expect(parseSectionDisclosure({ ...roundTrip(shown), header: noSetting })).toEqual({
      ok: false,
      reason: 'terms.invalid',
    })
    const v2 = roundTrip(discloseSection(plain, SALT, 'subject'))
    expect(
      parseSectionDisclosure({ ...v2, header: { ...v2.header, dependencyCheck: 'avow' } }),
    ).toEqual({ ok: false, reason: 'terms.invalid' })
  })
})

describe('how version 3 hashes, spelled out for other implementations', () => {
  it('hashes the five version 2 sections exactly as version 2 does', () => {
    const v2 = sectionHashes(plain, SALT)
    const v3 = sectionHashes(chained, SALT)
    for (const s of TERMS_SECTIONS) expect(v3[s], s).toBe(v2[s])
    expect(Object.keys(v3)).toEqual([...CHAINED_TERMS_SECTIONS])
  })

  it('hashes the dependencies under its own label and salt, and the terms under avow:terms:v3', () => {
    const salt = toHex(
      new Uint8Array(
        hkdfSync(
          'sha256',
          Buffer.from(SALT.slice(2), 'hex'),
          Buffer.alloc(0),
          'avow:terms:v3:salt:dependencies',
          32,
        ),
      ),
    )
    expect(sectionSalt(SALT, 'dependencies')).toBe(salt)
    expect(new Set(CHAINED_TERMS_SECTIONS.map((s) => sectionSalt(SALT, s))).size).toBe(6)
    const dependencies = keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'bytes32' }, { type: 'string' }],
        ['avow:terms:v3:dependencies', salt, canonicalJson(chained.dependencies)],
      ),
    )
    expect(sectionHashes(chained, SALT).dependencies).toBe(dependencies)
    const hashes = sectionHashes(plain, SALT)
    const header =
      '{"amountDecimals":6,"currency":"USD","dependencyCheck":"buyer","template":"gpu-reservation/1","version":3}'
    expect(canonicalJson(termsHeader(chained))).toBe(header)
    const expected = keccak256(
      encodeAbiParameters(
        [
          { type: 'string' },
          { type: 'string' },
          ...CHAINED_TERMS_SECTIONS.map(() => ({ type: 'bytes32' }) as const),
        ],
        [
          'avow:terms:v3',
          header,
          hashes.subject,
          hashes.consideration,
          hashes.remedies,
          hashes.resolution,
          hashes.backing,
          dependencies,
        ],
      ),
    )
    expect(termsHash(chained, SALT)).toBe(expected)
  })

  it('keeps the dependencies apart from every other section', () => {
    const salt = sectionSalt(SALT, 'dependencies')
    const own = sectionHash('dependencies', chained.dependencies, salt)
    for (const s of TERMS_SECTIONS) {
      expect(sectionHash(s, chained.dependencies, salt)).not.toBe(own)
    }
  })
})

describe('the terms hash covers every field of every entry', () => {
  const hash = termsHash(chained, SALT)
  const other = (change: Partial<Dependency>) => chainedTerms(plain, [{ ...entry(), ...change }])

  it('changes when any field of an entry changes', () => {
    const changed: ChainedTerms[] = [
      chainedTerms(plain, [entry({ chainId: CHAIN_ID + 1 })]),
      chainedTerms(plain, [entry({ lock: OTHER_LOCK })]),
      chainedTerms(plain, [entry({ commitmentId: id('another') })]),
      chainedTerms(plain, [entry({ side: 'supplier' })]),
      chainedTerms(plain, [entry({ termsHash: id('other terms') })]),
      chainedTerms(plain, [entry({ kind: 'payment' as 'commitment' })]),
      other({ condition: 'reserved' as 'accepted' }),
      other({ disclosed: 'consideration' as 'subject' }),
      chainedTerms(plain, [entry(), entry({ commitmentId: id('second') })]),
      chainedTerms(plain, [entry({ commitmentId: id('second') }), entry()]),
    ]
    const seen = new Set([hash])
    for (const t of changed) seen.add(termsHash(t, SALT))
    expect(seen.size).toBe(changed.length + 1)
  })

  it('reads every address and hash in an entry in any letter case as the same terms', () => {
    const on = entry().on
    const upper = (h: string) => `0x${h.slice(2).toUpperCase()}` as Hex
    const shouting = chainedTerms(plain, [
      entry({
        lock: upper(on.lock),
        commitmentId: upper(on.commitmentId),
        termsHash: upper(on.termsHash),
      }),
    ])
    expect(termsHash(shouting, SALT)).toBe(hash)
  })
})

describe('showing the subject of version 3 terms', () => {
  const hash = termsHash(chained, SALT)

  it('checks any one of the six sections against the terms hash on its own', () => {
    for (const s of CHAINED_TERMS_SECTIONS) {
      const shown = discloseSection(chained, SALT, s)
      expect(Object.keys(shown.others).sort(), s).toEqual(
        CHAINED_TERMS_SECTIONS.filter((x) => x !== s).sort(),
      )
      expect(checkSectionDisclosure(shown, hash), s).toBeNull()
      const parsed = parseSectionDisclosure(roundTrip(shown))
      if (!parsed.ok) throw new Error(`${s} doesn't parse: ${parsed.reason}`)
      expect(roundTrip(parsed.value), s).toEqual(roundTrip(shown))
      expect(checkSectionDisclosure(parsed.value, hash), s).toBeNull()
    }
  })

  it('shows the resource and window of a booking relied on, and none of its prices', () => {
    const shown = discloseSection(upstream, UPSTREAM_SALT, 'subject')
    const text = JSON.stringify(roundTrip(shown))
    for (const price of ['2170000', '123000000', '321000000']) expect(text).not.toContain(price)
    expect(checkSectionDisclosure(shown, UPSTREAM_HASH)).toBeNull()
  })

  it('refuses a changed subject, a missing dependencies hash or another header', () => {
    const shown = discloseSection(chained, SALT, 'subject')
    const subject = chained.subject
    const { dependencies: _, ...withoutDependencies } = shown.others
    const resource = { ...subject.resource, count: 9 }
    expect(checkSectionDisclosure({ ...shown, content: { ...subject, resource } }, hash)).toBe(
      'terms.hash_mismatch',
    )
    expect(checkSectionDisclosure({ ...shown, others: withoutDependencies }, hash)).toBe(
      'terms.invalid',
    )
    expect(
      checkSectionDisclosure(
        { ...shown, header: { ...termsHeader(chained), version: 4 as 3 } },
        hash,
      ),
    ).toBe('terms.version_unknown')
  })

  it("refuses the dependencies section from version 2 terms, which don't have one", () => {
    expect(() => discloseSection(plain as never, SALT, 'dependencies')).toThrow()
    const shown = roundTrip(discloseSection(chained, SALT, 'dependencies'))
    const asV2 = { ...shown, header: { ...shown.header, version: 2 } }
    expect(parseSectionDisclosure(asV2)).toEqual({ ok: false, reason: 'terms.invalid' })
    const subject = roundTrip(discloseSection(plain, SALT, 'subject'))
    const extra = { ...subject, others: { ...subject.others, dependencies: id('x') } }
    expect(parseSectionDisclosure(extra)).toEqual({ ok: false, reason: 'terms.invalid' })
  })
})

describe('version 3 terms over JSON', () => {
  it('round-trip through the version 3 parser', () => {
    const lower = {
      ...chained,
      resolution: { ...chained.resolution, arbiter: ARBITER.toLowerCase() },
    }
    expect(parseChainedTerms(roundTrip(chained))).toEqual({ ok: true, value: lower })
    expect(parseChainedTerms(roundTrip(plain))).toEqual({
      ok: false,
      reason: 'terms.version_unknown',
    })
  })

  it('refuse a field beside the six sections', () => {
    expect(parseChainedTerms({ ...roundTrip(chained), extra: 1 })).toEqual({
      ok: false,
      reason: 'terms.invalid',
    })
  })
})

describe('whether a GPU reservation fits inside the one it relies on', () => {
  const outer: GpuSubject = upstream.subject
  const inside = (change: Partial<GpuSubject['resource']>, window: Partial<GpuSubject> = {}) => ({
    ...outer,
    ...window,
    resource: { ...outer.resource, ...change },
  })
  const gpu = (subject: GpuSubject, template = 'gpu-reservation/1') => ({ template, subject })

  it('fits the same or fewer GPUs inside the window, under any SKU', () => {
    expect(gpuSubjectFits(outer, outer)).toBe(true)
    expect(gpuSubjectFits(inside({ count: 4, sku: 'resold-h100x4' }), outer)).toBe(true)
    expect(
      gpuSubjectFits(inside({}, { windowStart: START + 600n, windowDuration: 600n }), outer),
    ).toBe(true)
    expect(subjectFits(gpu(inside({ count: 1 })), gpu(outer))).toBe(true)
  })

  it("doesn't fit more GPUs, another GPU or region, or a window outside it", () => {
    const misfits = [
      inside({ count: 9 }),
      inside({ gpu: 'A100' }),
      inside({ region: 'elsewhere' }),
      inside({}, { windowStart: START - 1n }),
      inside({}, { windowDuration: 3601n }),
      inside({}, { windowStart: START + 1n }),
    ]
    misfits.forEach((s, i) => {
      expect(gpuSubjectFits(s, outer), `case ${i}`).toBe(false)
      expect(subjectFits(gpu(s), gpu(outer)), `case ${i}`).toBe(false)
    })
  })

  it('never fits under another template, or one this code does not know', () => {
    expect(subjectFits(gpu(outer), gpu(outer, 'freight/1'))).toBe(false)
    expect(subjectFits(gpu(outer, 'freight/1'), gpu(outer))).toBe(false)
    expect(subjectFits(gpu(outer, 'freight/1'), gpu(outer, 'freight/1'))).toBe(false)
    expect(subjectFits(gpu(outer, 'constructor'), gpu(outer, 'constructor'))).toBe(false)
  })

  it('says what is wrong with a subject on its own, by its template', () => {
    expect(subjectProblem(gpu(outer))).toBeNull()
    expect(subjectProblem(gpu(inside({ count: 0 })))).toBe('terms.template_invalid')
    expect(subjectProblem(gpu(inside({ count: -3 })))).toBe('terms.template_invalid')
    expect(subjectProblem(gpu(inside({ sku: '' })))).toBe('terms.template_invalid')
    expect(subjectProblem(gpu(inside({}, { windowDuration: 0n })))).toBe(
      'terms.deadlines_out_of_order',
    )
    expect(subjectProblem(gpu(inside({}, { windowDuration: -1800n })))).toBe(
      'terms.deadlines_out_of_order',
    )
    expect(subjectProblem(gpu(outer, 'freight/1'))).toBe('terms.template_unknown')
    expect(subjectProblem(gpu(outer, 'constructor'))).toBe('terms.template_unknown')
  })

  it('never fits a subject its template refuses, inside or out', () => {
    // No GPUs, fewer than none, or a window that ends before it starts would each pass the
    // comparison, and none of them is a reservation.
    const refused = [
      inside({ count: 0 }),
      inside({ count: -3 }),
      inside({}, { windowDuration: 0n }),
      inside({}, { windowDuration: -1800n }),
      inside({ sku: '' }),
    ]
    refused.forEach((s, i) => {
      expect(gpuSubjectFits(s, outer), `case ${i}`).toBe(false)
      expect(subjectFits(gpu(s), gpu(outer)), `case ${i}`).toBe(false)
    })
    // The SKU isn't compared, so only the check of the upstream subject refuses one with none.
    expect(gpuSubjectFits(inside({ count: 1 }), inside({ sku: '' }))).toBe(false)
  })
})

describe('the reason codes a dependency check gives', () => {
  it('has one for each of the twelve ways a booking relied on can fail its check', () => {
    const codes: ReasonCode[] = [
      'dependency.lock_unknown',
      'dependency.not_owned',
      'dependency.not_found',
      'dependency.self_supplied',
      'dependency.not_accepted',
      'dependency.charge_pending',
      'dependency.ended',
      'dependency.terms_mismatch',
      'dependency.disclosure_invalid',
      'dependency.does_not_fit',
      'dependency.unreadable',
      'dependency.elided',
    ]
    for (const code of codes) expect(describeReason(code).length, code).toBeGreaterThan(20)
  })
})
