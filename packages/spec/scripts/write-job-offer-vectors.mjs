// Writes vectors/job-offer-v1.json from the built package, so another implementation can check its
// canonical JSON and id of a job offer version against this one. Run
// `pnpm --filter @avow-finance/spec build` first. The job offer tests fail if this file and the code
// disagree.
import { writeFileSync } from 'node:fs'
import {
  canonicalJson,
  JOB_OFFER_VERSION_LABEL,
  jobOfferVersionFields,
  jobOfferVersionId,
  toWire,
} from '../dist/index.js'

const base = {
  template: 'job/1',
  supplier: 'biz_supplier',
  work: { kind: 'fine-tuning', summary: 'Fine-tune a small model on the dataset the buyer sends' },
  compute: { gpu: 'H100', count: 1, region: 'demo' },
  currency: 'USD',
  price: 120_000_000n,
  rules: {
    startAfter: 3_600n,
    turnaround: 7_200n,
    gracePeriod: 600n,
    dailyCapacity: 3,
    lateCancellationBps: 2_000,
    noShowBps: 5_000,
  },
}

function vector(name, version) {
  return {
    name,
    version: toWire(version),
    canonicalJson: canonicalJson(jobOfferVersionFields(version)),
    id: jobOfferVersionId(version),
  }
}

const vectors = [
  vector('a fine-tuning job on one H100', base),
  // Non-ASCII letters, quotes and a backslash in the summary and region, which an implementation
  // that escapes text or normalizes it would encode differently.
  vector('non-ASCII text and escapes', {
    ...base,
    work: { kind: 'évaluation', summary: 'Zürich "east" said 日本語 🙂 \\ ok' },
    compute: { gpu: 'H200', count: 8, region: 'Zürich "east"' },
  }),
  // A price larger than a JavaScript number holds exactly, and no late-cancellation charge.
  vector('a large price and one charge', {
    ...base,
    price: 123_456_789_012_345_678_901n,
    rules: { ...base.rules, lateCancellationBps: 0, gracePeriod: 7_200n },
  }),
]

writeFileSync(
  new URL('../vectors/job-offer-v1.json', import.meta.url),
  `${JSON.stringify({ version: 1, label: JOB_OFFER_VERSION_LABEL, vectors }, null, 2)}\n`,
)
