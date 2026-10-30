// Writes vectors/terms-v2.json and vectors/terms-v3.json from the built package, so another
// implementation can check its canonical JSON, section salts, section hashes, terms hash and lock
// mapping against this one. Run `pnpm --filter @avow-finance/spec build` first. The vectors test
// fails if these files and the code disagree.
import { writeFileSync } from 'node:fs'
import {
  CHAINED_TERMS_SECTIONS,
  canonicalJson,
  chainedTerms,
  demoTerms,
  discloseSection,
  elideDependencies,
  lockTerms,
  sectionHashes,
  sectionSalt,
  TERMS_SECTIONS,
  termsHash,
  termsHeader,
  termsSections,
  testnetDemoTerms,
  toWire,
} from '../dist/index.js'

const START = 1_800_000_000n
const ARBITER = '0x000000000000000000000000000000000000a4b1'
// A checksummed arbiter and a region with non-ASCII letters and quotes, where an implementation
// that skips lower-casing or escapes non-ASCII text would hash differently.
const CHECKSUMMED_ARBITER = '0x7B7b7e93b9De1B9Cba5123f0570B56EB66C53173'

function withRegion(terms, region) {
  return {
    ...terms,
    subject: { ...terms.subject, resource: { ...terms.subject.resource, region } },
  }
}

/** A section as it's hashed, with every address and hash it names in lower case. */
function hashedForm(section, content) {
  if (section === 'resolution') return { ...content, arbiter: content.arbiter.toLowerCase() }
  if (section !== 'dependencies') return content
  return content.map((d) => ({
    ...d,
    on: {
      ...d.on,
      lock: d.on.lock.toLowerCase(),
      commitmentId: d.on.commitmentId.toLowerCase(),
      termsHash: d.on.termsHash.toLowerCase(),
    },
  }))
}

function vector(name, terms, salt, names) {
  const sections = termsSections(terms)
  const hashes = sectionHashes(terms, salt)
  return {
    name,
    salt,
    terms: toWire(terms),
    header: canonicalJson(termsHeader(terms)),
    sections: Object.fromEntries(
      names.map((s) => [
        s,
        {
          canonicalJson: canonicalJson(hashedForm(s, sections[s])),
          salt: sectionSalt(salt, s),
          hash: hashes[s],
        },
      ]),
    ),
    termsHash: termsHash(terms, salt),
    lockTerms: toWire(lockTerms(terms, 6)),
    subjectShownAlone: toWire(discloseSection(terms, salt, 'subject')),
  }
}

function write(file, description, vectors, more = {}) {
  writeFileSync(
    new URL(`../vectors/${file}`, import.meta.url),
    `${JSON.stringify({ description, vectors, ...more }, null, 2)}\n`,
  )
}

const v2 = [
  vector(
    'testnet demo terms',
    testnetDemoTerms(START, ARBITER),
    `0x${'11'.repeat(32)}`,
    TERMS_SECTIONS,
  ),
  vector('demo terms', demoTerms(START, ARBITER), `0x${'5a'.repeat(32)}`, TERMS_SECTIONS),
  vector(
    'checksummed arbiter and a non-ASCII region',
    withRegion(demoTerms(START, CHECKSUMMED_ARBITER), 'Zürich "east"'),
    `0x${'c3'.repeat(32)}`,
    TERMS_SECTIONS,
  ),
]

write(
  'terms-v2.json',
  'Version 2 terms under the gpu-reservation/1 template. Canonical JSON is RFC 8785 with bigints as decimal strings, writing non-ASCII characters as UTF-8 without escaping them. The arbiter\'s address is written in lower case before the resolution section is hashed, whatever case the terms hold it in. Each section salt is HKDF-SHA256 of the commitment salt, with no HKDF salt, info "avow:terms:v2:salt:<section>" and 32 bytes out. Each section hash is keccak256(abi.encode(string "avow:terms:v2:<section>", bytes32 sectionSalt, string canonicalJson)). The terms hash is keccak256(abi.encode(string "avow:terms:v2", string headerJson, bytes32 subject, bytes32 consideration, bytes32 remedies, bytes32 resolution, bytes32 backing)). lockTerms is what Avow\'s approval carries for a 6-decimal token.',
  v2,
)

const CHAIN_ID = 42431
const RESELLER_LOCK = '0x00000000000000000000000000000000000010c6'

/** A dependency on the buyer side of a lock, which has to be accepted and shows its subject. */
function dependency(lock, commitmentId, termsHash) {
  return {
    on: { kind: 'commitment', chainId: CHAIN_ID, lock, commitmentId, side: 'buyer', termsHash },
    condition: 'accepted',
    disclosed: 'subject',
  }
}

const upper = (hex) => `0x${hex.slice(2).toUpperCase()}`

// The first version 3 vector relies on the booking the first version 2 vector describes.
const reliedOn = dependency(RESELLER_LOCK, `0x${'a1'.repeat(32)}`, v2[0].termsHash)
// Four bookings, with checksummed locks and upper-case ids and hashes that the hash lower-cases.
const four = [
  dependency(
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    upper(`0x${'b1'.repeat(32)}`),
    upper(v2[0].termsHash),
  ),
  dependency(
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    upper(`0x${'b2'.repeat(32)}`),
    upper(v2[1].termsHash),
  ),
  dependency(
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    upper(`0x${'b3'.repeat(32)}`),
    upper(v2[2].termsHash),
  ),
  dependency(
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    upper(`0x${'b4'.repeat(32)}`),
    upper(`0x${'b5'.repeat(32)}`),
  ),
]

const relyingOnOne = chainedTerms(testnetDemoTerms(START, ARBITER), [reliedOn])

/** The first version 3 vector's terms as JSON, with another dependencies section. */
const withDependencies = (dependencies) => ({ ...toWire(relyingOnOne), dependencies })
const entry = toWire(reliedOn)
const fiveEntries = [1, 2, 3, 4, 5].map((n) =>
  toWire(dependency(RESELLER_LOCK, `0x${`c${n}`.repeat(32)}`, v2[0].termsHash)),
)

// Terms Avow checks for the buyer, so the buyer sees them as elideDependencies shows them.
const avowChecked = chainedTerms(testnetDemoTerms(START, ARBITER), [reliedOn], 'avow')
const AVOW_CHECKED_SALT = `0x${'e5'.repeat(32)}`
const elided = toWire(elideDependencies(avowChecked, AVOW_CHECKED_SALT))

// Each differs from the first version 3 vector in its dependencies section or its setting alone.
const invalid = [
  { name: 'no entries', terms: withDependencies([]) },
  { name: 'five entries', terms: withDependencies(fiveEntries) },
  {
    name: 'two entries naming one booking, differing only in letter case',
    terms: withDependencies([
      entry,
      {
        ...entry,
        on: {
          ...entry.on,
          lock: upper(entry.on.lock),
          commitmentId: upper(entry.on.commitmentId),
          termsHash: upper(entry.on.termsHash),
        },
      },
    ]),
  },
  {
    name: 'a condition version 3 does not know',
    terms: withDependencies([{ ...entry, condition: 'reserved' }]),
  },
  {
    name: 'a disclosed section version 3 does not allow',
    terms: withDependencies([{ ...entry, disclosed: 'consideration' }]),
  },
  {
    name: 'a booking on the supplier side',
    terms: withDependencies([{ ...entry, on: { ...entry.on, side: 'supplier' } }]),
  },
  {
    name: 'an entry with a key beside its three',
    terms: withDependencies([{ ...entry, note: 'resold' }]),
  },
  {
    name: 'a reference with a key beside its six',
    terms: withDependencies([{ ...entry, on: { ...entry.on, note: 'resold' } }]),
  },
  {
    name: 'a setting version 3 does not know',
    terms: { ...toWire(relyingOnOne), dependencyCheck: 'seller' },
  },
  {
    name: 'no setting',
    terms: (({ dependencyCheck: _, ...rest }) => rest)(toWire(relyingOnOne)),
  },
]
  .map((v) => ({ ...v, reason: 'terms.invalid' }))
  .concat([
    {
      name: 'the dependencies section only as its digest',
      terms: withDependencies(elided.dependencies),
      reason: 'dependency.elided',
    },
  ])

// Each differs from the Avow-checked vector's view in one way, and a buyer refuses it.
const view = (change) => ({ ...elided, ...change })
const invalidElided = [
  { name: 'a view of terms the buyer checks', elided: view({ dependencyCheck: 'buyer' }) },
  {
    name: 'a view that hides the consideration too',
    elided: view({
      consideration: { label: 'avow:terms:v2:consideration', digest: `0x${'ab'.repeat(32)}` },
    }),
  },
  {
    name: 'a view that hides the subject and shows the dependencies',
    elided: view({
      subject: { label: 'avow:terms:v2:subject', digest: `0x${'ab'.repeat(32)}` },
      dependencies: toWire(avowChecked.dependencies),
    }),
  },
  {
    name: 'the dependencies in clear',
    elided: view({ dependencies: toWire(avowChecked.dependencies) }),
  },
  {
    name: 'a digest under another label',
    elided: view({ dependencies: { ...elided.dependencies, label: 'avow:terms:v2:dependencies' } }),
  },
  {
    name: 'a digest that is not 32 bytes',
    elided: view({ dependencies: { ...elided.dependencies, digest: '0x1234' } }),
  },
  {
    name: 'an elided section with a key beside its label and digest',
    elided: view({ dependencies: { ...elided.dependencies, entries: 1 } }),
  },
  {
    name: 'the dependencies section salt beside the digest',
    elided: view({
      salts: { ...elided.salts, dependencies: sectionSalt(AVOW_CHECKED_SALT, 'dependencies') },
    }),
  },
  {
    name: 'a section shown without its salt',
    elided: view({ salts: (({ backing: _, ...rest }) => rest)(elided.salts) }),
  },
].map((v) => ({ ...v, reason: 'terms.invalid' }))

write(
  'terms-v3.json',
  'Version 3 terms under the gpu-reservation/1 template, for a booking that relies on other bookings. They are version 2 terms with the header\'s version set to 3 and one more section, dependencies, a list of one to four entries, each naming a different booking relied on (a commitment reference with kind, chainId, lock, commitmentId, side and termsHash, on the buyer side), the condition it has to meet ("accepted") and the section of it the seller shows ("subject"). The five version 2 sections are hashed exactly as version 2 hashes them, with salt info "avow:terms:v2:salt:<section>" and label "avow:terms:v2:<section>". The dependencies section has salt info "avow:terms:v3:salt:dependencies" and label "avow:terms:v3:dependencies", and each entry\'s lock, commitmentId and termsHash are written in lower case before it is hashed. The terms hash is keccak256(abi.encode(string "avow:terms:v3", string headerJson, bytes32 subject, bytes32 consideration, bytes32 remedies, bytes32 resolution, bytes32 backing, bytes32 dependencies)). lockTerms is what Avow\'s approval carries for a 6-decimal token, the same mapping as version 2, since the lock enforces nothing in the dependencies section. subjectShownAlone shows the subject with its own salt and the other five section hashes. The header holds dependencyCheck, "buyer" when the buyer reads each booking relied on from the chain itself and "avow" when Avow checks them for it. In the last vector Avow checks the booking relied on, and its elided field is the buyer\'s view of the terms, every section in clear with its own salt under salts except dependencies, which is its label "avow:terms:v3:dependencies" and its digest, the section hash. The buyer\'s view gives the same terms hash, from the header, each shown section hashed with its salt, and the digest. invalid lists version 3 terms that differ from the first vector only in their dependencies section or their dependencyCheck, each with the reason a version 3 reader refuses them, and invalidElided lists views of the last vector a buyer refuses, each with its reason.',
  [
    vector(
      'testnet demo terms relying on one booking',
      relyingOnOne,
      `0x${'22'.repeat(32)}`,
      CHAINED_TERMS_SECTIONS,
    ),
    vector(
      'demo terms relying on four bookings named in mixed case',
      chainedTerms(demoTerms(START, ARBITER), four),
      `0x${'6b'.repeat(32)}`,
      CHAINED_TERMS_SECTIONS,
    ),
    vector(
      'checksummed arbiter and a non-ASCII region relying on one booking',
      chainedTerms(withRegion(demoTerms(START, CHECKSUMMED_ARBITER), 'Zürich "east"'), [reliedOn]),
      `0x${'d4'.repeat(32)}`,
      CHAINED_TERMS_SECTIONS,
    ),
    {
      ...vector(
        'testnet demo terms relying on one booking, which Avow checks for the buyer',
        avowChecked,
        AVOW_CHECKED_SALT,
        CHAINED_TERMS_SECTIONS,
      ),
      elided,
    },
  ],
  { invalid, invalidElided },
)
