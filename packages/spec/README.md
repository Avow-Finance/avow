# @avow-finance/spec

The commitment schema that Avow's API, the SDK and the verifier all read. A supplier checks a commitment with the same code Avow used to approve it.

> **Status:** pre-release and testnet only. The compute terms here are the working format, and they will change after supplier calls.

## What's public and what isn't

- **Public now.** This schema, the compute terms format and the verifier, under the repo's Apache 2.0 license.
- **Provisional.** The format is versioned, and a reader refuses a schema version it doesn't know. From the first testnet deployment, any change to a signed message, the terms or their canonical JSON gets a new schema version. Until 1.0 such a change can come in any release, and each release names it.
- **Later.** The written specification will go into the public domain (CC0) once a real counterparty has used the format. This code isn't that specification, and it isn't CC0.
- **Never here.** Customer terms, evidence, identity records and secrets stay out of this repo, its tests and its examples. Tests generate their own keys and use made-up businesses.

## What it holds

| Part | What it does |
| --- | --- |
| Records | Business, administrator, agent, mandate and commitment, with the 11 commitment states and the moves between them |
| Compute terms | The terms of a GPU reservation, their canonical JSON and the salted terms hash the lock stores |
| Signed messages | The mandate, the terms agreement, the supplier authorization, the administrator's approval and the start receipt, each as EIP-712 typed data |
| Lock messages | The messages the lock checks: Avow's approval, the supplier's acceptance, report, evidence and release consent, and the actions a business or supplier account signs with its root or an admin key. Fixed digests in the tests match the lock's own, and the signatures the SDK makes for one whole commitment are pinned for the lock's tests to replay |
| Mandate check | The pure check Avow runs before it signs an approval, which the SDK can run before it asks |
| Reason codes | One stable code for every decision and every refusal |
| AP2 mapping | How a mandate maps onto an AP2 intent mandate |
| Keychain envelope | Tempo's keychain V2 envelope for signatures a business account's root or admin key makes, with an offline check and a check against Tempo's own verifier |
| Wire forms | JSON schemas that parse amounts and times from decimal strings |

## Design rules

- Money in terms and mandates is in micros, millionths of the currency unit, so $500 is `500_000_000n`. A USD token on Tempo has 6 decimals, so its base units equal micros.
- Terms name a currency and never a token, so the same terms and terms hash work on any rail. The token belongs to the backing, in `BackingRef`.
- Every signed message names its schema version, chain and lock in its EIP-712 domain, and carries a nonce and an expiry. A reader refuses a version it doesn't know.
- The reserve equals the largest charge in the terms. A contest window under 72 hours passes only the testnet demo profile.

## Develop

```sh
pnpm --filter @avow-finance/spec test
```

Tests generate their keys for each run and never write them anywhere.
