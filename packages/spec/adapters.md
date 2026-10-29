# Adapters for other standards

A commitment's states, evidence and mandate map onto ERC-8183 jobs and AP2 intent mandates, so an adapter for either can come later without changing the schema. This page sets out both mappings, which `erc8183.ts` and `ap2.ts` implement, and what doesn't carry over.

## ERC-8183 jobs

ERC-8183, a draft of 25 February 2026, describes a job that a client funds in escrow and a provider submits work for. An evaluator then completes the job, which pays the provider, or rejects it, which refunds the client. A commitment uses its money differently. The lock reserves what a broken promise would cost, the supplier is paid from it only for a charge the terms allow, and a kept commitment returns the whole reserve to the business. The job view keeps that difference visible.

`toErc8183Job` reads a commitment as a job.

| Job field | From the commitment |
| --- | --- |
| `client` | The business account whose lock holds the reserve |
| `provider` | The supplier's payee, which a charge pays |
| `evaluator` | The lock, which pays a charge once the contest window closes, applies Avow's ruling or the arbiter's, and applies the day-90 default |
| `budget` | The reserve in the token's base units, the most the supplier can charge |
| `expiredAt` | The release date, after which anyone can return a reserve nothing charged |
| `description` | The salted terms hash both sides signed |

A job pays or refunds its whole budget, and a charge can take part of a reserve, so the view also gives what the supplier was paid and what the business got back once the commitment has ended.

### States

| Commitment state | Job status | Why |
| --- | --- | --- |
| `draft`, `agreed`, `awaiting_approval` | Open | Nothing is in the lock yet. A counter-offer plays the part of `setBudget` |
| `reserved`, `accepted` | Funded | The reserve is in the lock, and the supplier is bound once it accepts |
| `charge_pending`, `paused` | Submitted | The supplier's report stands as its submission until the charge is paid or ruled on, and a contest keeps it there |
| `charged`, or `resolved` with anything paid | Completed | The supplier was paid some or all of the reserve |
| `released` as kept | Expired | The release date passed with nothing charged, and anyone can return the reserve, as anyone can claim an expired job's refund |
| `released` any other way, `resolved` with nothing paid, or `expired` | Rejected | The whole reserve went back, or the commitment never reached the lock and nothing moved |

Every move a commitment can make maps to a move ERC-8183 allows or to no move at all. A test checks each move against ERC-8183's state table, so a new state or move fails it until it maps.

### Evidence

| Job value | From the commitment |
| --- | --- |
| `deliverable`, when submitted | The evidence hash of the supplier's report of the charge |
| `reason`, when completed or rejected | The evidence hash recorded with the ending, and the commitment receipt's hash once the spec defines the receipt |

ERC-8183 has no contest, since its evaluator decides alone. A contested commitment shows as still submitted, and its contest record stays with Avow's records.

### What doesn't carry over

- A job's budget is its price. A reserve is the most a broken promise costs, and usage is paid apart from it.
- A job pays or refunds its whole budget. A charge can take part of a reserve and return the rest, which the job's settled amounts show.
- ERC-8183 has no contest window, rulings or day-90 default. The lock, as the evaluator, stands for all three.
- A business can cancel a funded commitment before its free-cancellation deadline, and ERC-8183 lets a client reject only an open job. The view shows that cancellation as a rejection.

## AP2 intent mandates

`toAp2IntentMandate` maps a mandate onto AP2's intent mandate, and `fromAp2IntentMandate` reads it back. The suppliers become AP2's merchants and the expiry becomes its intent expiry. AP2 has no field for the rest, so the account, actions, caps, limits, categories, approval rule and nonce travel beside it in an `avow` extension.

| AP2 field | From the mandate |
| --- | --- |
| `merchants` | The suppliers' business ids, or null when the mandate limits categories only |
| `intent_expiry` | The mandate's expiry, as an ISO 8601 time |
| `user_cart_confirmation_required` | True whenever the approval rule ever asks the administrator. AP2 can't say "above an amount", so the flag is stricter than the rule and never looser |
| `natural_language_description` | Whatever the adapter writes |
| `skus` | Null, since a mandate limits categories |
| `requires_refundability` | False |

Reading back refuses a pair whose halves disagree with `mandate.ap2_mismatch`. That covers a confirmation flag that doesn't match the approval rule, any SKUs, required refundability and an empty merchant list. A value no mandate can hold, such as an expiry that isn't a whole second, is refused as `message.invalid`.

An AP2 cart mandate corresponds to the signed terms agreement and Avow's approval together, since those fix one purchase. An adapter that accepts AP2 still has to check the user's signature on the intent mandate, which this package doesn't do.
