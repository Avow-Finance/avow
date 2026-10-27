# @avow-finance/spec

The commitment schema that Avow's API, the SDK and the verifier all read. A supplier checks a commitment with the same code Avow used to approve it.

> **Status:** pre-release and testnet only. The compute terms here are the working format, and they will change after supplier calls.

## What it holds

| Part | What it does |
| --- | --- |
| Records | Business, administrator, agent, mandate and commitment, with the master spec's 11 commitment states and the moves between them |
| Compute terms | The terms of a GPU reservation, their canonical JSON and the salted terms hash the lock stores |
| Signed messages | The mandate, the terms agreement, Avow's approval, the supplier authorization, the administrator's approval and the start receipt, each as EIP-712 typed data |
| Mandate check | The pure check Avow runs before it signs an approval, which the SDK can run before it asks |
| Reason codes | One stable code for every decision and every refusal |
| AP2 mapping | How a mandate maps onto an AP2 intent mandate |
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
