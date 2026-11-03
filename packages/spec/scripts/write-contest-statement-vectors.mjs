// Writes vectors/contest-statement-v1.json from the built package, so another implementation can
// check its canonical JSON and hash of a contest statement against this one. Run
// `pnpm --filter @avow-finance/spec build` first. The contest tests fail if this file and the code
// disagree.
import { writeFileSync } from 'node:fs'
import { keccak256, stringToHex } from 'viem'
import { contestStatementHash, encodeContestStatement } from '../dist/index.js'

const commitmentId = keccak256(stringToHex('contest statement vector commitment'))

function vector(name, statement) {
  return {
    name,
    statement,
    canonicalJson: encodeContestStatement(statement),
    hash: contestStatementHash(statement),
  }
}

const vectors = [
  vector('a no-show contested in plain text', {
    commitmentId,
    side: 'buyer',
    reportNumber: 1,
    reason: 'job_started',
    text: 'Our agent sent the start request at 14:02 and the supplier receipted it at 14:03.',
  }),
  // Non-ASCII letters, an emoji, quotes, a backslash, a tab and both kinds of line break, which an
  // implementation that escapes text, drops a character or normalizes line ends would encode
  // differently.
  vector('every kind of character the format keeps', {
    commitmentId,
    side: 'buyer',
    reportNumber: 2,
    reason: 'other',
    text: 'Zürich "east" said 日本語 🙂 \\ ok\tthen:\nline two\r\nline three',
  }),
  // The id in mixed case, which the canonical JSON writes in lower case, so it hashes as the first
  // vector's id would.
  vector('a commitment id in mixed case', {
    commitmentId: `0x${commitmentId.slice(2).toUpperCase()}`,
    side: 'buyer',
    reportNumber: 1,
    reason: 'never_cancelled',
    text: 'We never cancelled.',
  }),
]

writeFileSync(
  new URL('../vectors/contest-statement-v1.json', import.meta.url),
  `${JSON.stringify({ version: 1, label: 'avow:contest-statement:v1', vectors }, null, 2)}\n`,
)
