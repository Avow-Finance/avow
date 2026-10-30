# Relay refusals

Avow's relay pays the network fee for an agent's reserve, so a business's agents never need to hold a fee token. It pays within limits, and when it won't pay it refuses with a reason code an agent can act on. A refusal changes nothing on the chain or in Avow's records. The commitment stays as it was, and the agent decides what happens next.

## How the relay decides

The relay runs six checks in a fixed order, and the first one that fails gives the refusal.

1. **Content.** The transaction approves the reserve token to the business's own lock and reserves on that lock, and does nothing else.
2. **The key.** The agent key that signed the request to Avow also signed the transaction, for its business account.
3. **Caps.** The transaction's gas, its fee per gas and the most it could pay in fees all fit the caps for a reserve.
4. **Rate limit.** The signing key hasn't asked the relay to pay too many times in the last minute.
5. **Simulation.** The transaction succeeds when it runs on the latest block.
6. **Budgets.** The transaction's gas fits every budget it counts toward.

## The codes

| Code | Status | What the error adds | What the agent does |
| --- | --- | --- | --- |
| `sponsorship.refused` | 422 | Nothing | Changes the transaction, since the relay never pays for it as it is |
| `sponsorship.over_cap` | 422 | `cap` and `limit` | Prepares the transaction again within the limit |
| `sponsorship.rate_limited` | 429 | `retryAt` | Signs a fresh transaction once `retryAt` has passed |
| `sponsorship.simulation_failed` | 422 | `revert` | Fixes what made the transaction revert before it tries again |
| `sponsorship.budget_spent` | 429 | `budget` and `retryAt` | Waits, pays its own fee, or asks its business to have the budget raised |

Each field arrives in the error body beside `reason` and `message`. Numbers travel as decimal strings, and times are unix seconds by Avow's clock.

```json
{
  "error": {
    "reason": "sponsorship.rate_limited",
    "message": "This key has asked Avow's relay to pay 11 times in the last minute.",
    "retryAt": "1800000060"
  }
}
```

### `sponsorship.refused`

The relay pays only for a reserve. The transaction has to come from the business account, carry the signature of the agent key that signed the request, and do nothing but approve the reserve token to the business's own lock and reserve on that lock. Anything else gets this code, including a transaction for another chain, one with no expiry and one that stays valid longer than the relay allows. The same transaction always gets the same answer, so the agent has to change it.

### `sponsorship.over_cap`

`cap` names the cap the transaction is over, and `limit` gives that cap.

| `cap` | What it limits | `limit` is in |
| --- | --- | --- |
| `gas` | The transaction's gas limit | Gas |
| `fee_per_gas` | What the transaction pays a gas at the latest base fee, which is the base fee and its priority fee together, up to its maximum fee per gas | Attodollars a gas |
| `fee` | The most the transaction could pay, its gas limit times its maximum fee per gas | Base units of the fee token |

The fee ceiling is fixed for each kind of transaction, so it holds while the network's base fee climbs. A transaction that asks for a high maximum fee per gas can pass the per-gas cap and still be over the ceiling, and preparing it again with a lower maximum fee per gas or less gas fixes that. When the base fee itself has risen past what the ceiling allows, the relay pays for nothing of that kind until it falls, and the agent can pay its own fee meanwhile.

### `sponsorship.rate_limited`

Each signing key may ask the relay to pay a set number of times a minute. Every request counts, including the ones the relay refuses, so a key that keeps sending stays limited. `retryAt` is the earliest time a request from the key can pass. A transaction the relay pays for stays valid for a minute at most, so by `retryAt` the old one may have expired, and the agent should prepare and sign a fresh one.

### `sponsorship.simulation_failed`

The relay runs the transaction on the latest block before it pays, so it never pays for a transaction that fails. `revert` holds the revert data, and `message` gives the node's reading of it. A lock error such as `WrongState` means the commitment isn't in the state the call needs, and the same transaction keeps failing until that changes. Revert data of `0x` means the transaction ran out of gas, so it needs more gas, within the gas cap.

### `sponsorship.budget_spent`

The relay counts the gas it pays for over the last 24 hours against a budget for each agent key, each business and the relay as a whole. `budget` names the budget the transaction doesn't fit, as `agent_key`, `business` or `relay`, and `retryAt` is the latest time enough of it frees up. Gas held for a transaction that never lands comes back within a few minutes, so a retry can pass before `retryAt`.

The agent has three ways forward. It can wait, it can sign the transaction again without a fee payer and pay its own fee, or its business can ask Avow to raise the business's budget for a while. A key that spends its whole budget deserves a look first, since a compromised agent key is one way to get there.

## In the SDK

`httpAvowApi` throws an `AvowApiError` for every refusal, with the code in `reason` and the fields the relay added in `sponsorship`. `sendSponsored` wraps that error in a `SendError` as its `cause`. `parseSponsorshipRefusal` in `@avow-finance/spec` reads the same fields from any error body.

```ts
import { AvowApiError, SendError } from '@avow-finance/sdk'

/** What Avow's relay added to the refusal behind an error, or null. */
function relayRefusal(error: unknown) {
  const api = error instanceof SendError ? error.cause : error
  return api instanceof AvowApiError ? api.sponsorship : null
}

const refusal = relayRefusal(error)
if (refusal?.reason === 'sponsorship.rate_limited') {
  // Prepare and sign a fresh transaction once refusal.retryAt has passed.
}
```
