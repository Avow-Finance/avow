// Writes vectors/terms-v2.json from the built package, so another implementation can check its
// canonical JSON, section salts, section hashes, terms hash and lock mapping against this one.
// Run `pnpm --filter @avow-finance/spec build` first. The vectors test fails if this file and the
// code disagree.
import { writeFileSync } from 'node:fs'
import {
  canonicalJson,
  demoTerms,
  discloseSection,
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

function vector(name, terms, salt) {
  const sections = termsSections(terms)
  const hashes = sectionHashes(terms, salt)
  return {
    name,
    salt,
    terms: toWire(terms),
    header: canonicalJson(termsHeader(terms)),
    sections: Object.fromEntries(
      TERMS_SECTIONS.map((s) => [
        s,
        {
          canonicalJson: canonicalJson(
            s === 'resolution'
              ? { ...sections[s], arbiter: sections[s].arbiter.toLowerCase() }
              : sections[s],
          ),
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

const vectors = {
  description:
    'Version 2 terms under the gpu-reservation/1 template. Canonical JSON is RFC 8785 with bigints as decimal strings. Each section salt is HKDF-SHA256 of the commitment salt, with no HKDF salt, info "avow:terms:v2:salt:<section>" and 32 bytes out. Each section hash is keccak256(abi.encode(string "avow:terms:v2:<section>", bytes32 sectionSalt, string canonicalJson)). The terms hash is keccak256(abi.encode(string "avow:terms:v2", string headerJson, bytes32 subject, bytes32 consideration, bytes32 remedies, bytes32 resolution, bytes32 backing)). lockTerms is what Avow\'s approval carries for a 6-decimal token.',
  vectors: [
    vector('testnet demo terms', testnetDemoTerms(START, ARBITER), `0x${'11'.repeat(32)}`),
    vector('demo terms', demoTerms(START, ARBITER), `0x${'5a'.repeat(32)}`),
  ],
}

writeFileSync(
  new URL('../vectors/terms-v2.json', import.meta.url),
  `${JSON.stringify(vectors, null, 2)}\n`,
)
