# Adapters for other standards

A commitment's states and the mandate behind it map onto ERC-8183 jobs and AP2 0.1 intent mandates, so an adapter for either can come later without changing the schema. This page sets out both mappings, which `erc8183.ts` and `ap2.ts` implement, and what doesn't carry over.

## ERC-8183 jobs

[ERC-8183](https://eips.ethereum.org/EIPS/eip-8183), a draft of 25 February 2026, describes a job that a client funds in escrow and a provider submits work for. An evaluator then completes the job, which pays the provider, or rejects it, which refunds the client. A commitment uses its money differently. The lock reserves what a broken promise would cost, the supplier is paid from it only for a charge the terms allow, and a kept commitment returns the whole reserve to the business. The job view keeps that difference visible.

`toErc8183Job` reads a commitment as a job. It takes the business account and the token's decimals from the caller, and everything else from the record. A commitment that is a draft, agreed, awaiting approval or expired lives only on Avow's servers, so its job names no provider or evaluator, even when the record already holds the backing Avow approved.

| Job field | From the commitment |
| --- | --- |
| `client` | The business account whose lock holds the reserve |
| `provider` | The supplier's payee that the reserve's backing names, which a charge pays. Null while the commitment's state says no money has reached the lock |
| `evaluator` | The lock that the reserve's backing names. Null while the commitment's state says no money has reached the lock. The lock pays a charge once the contest window closes, applies Avow's ruling or the arbiter's, and applies the day-90 default |
| `budget` | The reserve in the token's base units, the most the supplier can charge |
| `expiredAt` | The release date, from which anyone can return a reserve the supplier accepted with no report |
| `description` | The salted terms hash both sides signed |

A job pays or refunds its whole budget, and a charge can take part of a reserve, so the view also gives what the supplier was paid and what the business got back once the commitment has ended. The two add up to the budget, or to zero when nothing reached the lock, because `parseCommitment` refuses a record whose amounts don't fit its ending.

### States

| Commitment state | Job status | Why |
| --- | --- | --- |
| `draft`, `agreed`, `awaiting_approval` | Open | Nothing is in the lock yet. A counter-offer plays the part of `setBudget` |
| `reserved`, `accepted` | Funded | The reserve is in the lock, and the supplier is bound once it accepts |
| `charge_pending`, `paused` | Submitted | The supplier's report stands as its submission until the charge is paid or ruled on, and a contest keeps it there |

### Endings

The view decides an ending from the commitment's state and how it ended. ERC-8183 lets a job expire only once `expiredAt` has passed, and lets the evaluator reject a funded or submitted job at any time. So only a reserve that went back at its release date shows as Expired, and every other return of the whole reserve shows as Rejected.

| Ending | How it ended | Job status | Why |
| --- | --- | --- | --- |
| `released` | `reached_release_date` | Expired | The release date came with no report, and anyone could return the reserve, as anyone can call `claimRefund` on a job once `expiredAt` passes |
| `released` | `kept`, `supplier_failed` | Rejected | The supplier consented to give the reserve back, which the lock takes at any time, so it can come long before `expiredAt` |
| `released` | `cancelled_in_time` | Rejected | The business cancelled before free cancellation ended |
| `released` | `not_accepted`, `agent_revoked` | Rejected | The supplier never accepted, or the agent was revoked before it did |
| `charged` | `cancelled_late`, `no_show` | Completed | The supplier was paid the charge, and the rest of the reserve went back |
| `resolved` | `ruled`, `day_90_default` | Completed, or Rejected when nothing was paid | A ruling or the day-90 default decided the charge |
| `expired` | `expired` | Rejected | The commitment never reached the lock, and nothing moved |

Versions 1 and 2 of the commitment record recorded a return at the release date as `kept`, as they did the supplier's consent. Such a record stays version 2 when read, keeps `kept`, and its job shows Rejected, which ERC-8183 allows at any time.

Every move a commitment can make maps to a move ERC-8183 allows or to no move at all, and no ending that can come before the release date shows as Expired. A test checks each move in the commitment's state table against ERC-8183's, so a new state, move or way of ending fails it until it maps. The supplier's consent from a pending or paused charge is one of those moves.

ERC-8183 has no contest, since its evaluator decides alone. A contested commitment shows as still submitted until it ends, and its contest record stays with Avow's records, on a release by the supplier's consent as well.

### What doesn't carry over

- A job's budget is its price. A reserve is the most a broken promise costs, and usage is paid apart from it.
- A job pays or refunds its whole budget. A charge can take part of a reserve and return the rest, which the job's settled amounts show.
- ERC-8183 has no contest window, rulings or day-90 default. The lock, as the evaluator, stands for all three.
- ERC-8183 lets anyone call `claimRefund` on a submitted job once `expiredAt` passes, so that refunds can't be blocked. The lock returns a reserve at the release date only when it's accepted with no report. A charge pending or paused can outlast `expiredAt`, by days for a report near the charge deadline and by around 90 days for a paused charge nobody rules on, and the job stays Submitted until the charge ends.
- A business can cancel a funded commitment before its free-cancellation deadline, and ERC-8183 lets a client reject only an open job. The view shows that cancellation as a rejection.
- ERC-8183's `deliverable` and `reason` have no place in the job view. The commitment record holds neither the evidence hash of the supplier's report nor the evidence recorded with the ending, so an adapter that needs them reads them from the chain.

## AP2 intent mandates, version 0.1

This mapping targets [AP2 0.1](https://github.com/google-agentic-commerce/AP2/blob/v0.1.0/src/ap2/types/mandate.py), whose intent mandate it reads and writes. AP2 0.2, released on 28 April 2026, replaced intent and cart mandates with [checkout and payment mandates](https://ap2-protocol.org/ap2/specification/). Their open forms are signed by the user and carry the agent's key as `cnf`, an expiry as `exp`, the merchants and payees allowed, and constraints such as [`payment.amount_range` and `payment.budget`](https://ap2-protocol.org/ap2/payment_mandate/). That says far more of an Avow mandate than 0.1 can, so a new adapter should build on 0.2, and this mapping stays only for systems that still speak 0.1.

`toAp2IntentMandate` maps a mandate onto AP2 0.1's intent mandate, and `fromAp2IntentMandate` reads it back. The suppliers become AP2's merchants and the expiry becomes its intent expiry. The rest travels beside it in an `avow` extension.

| AP2 field | From the mandate |
| --- | --- |
| `merchants` | The suppliers' business ids, or null when the mandate limits categories only |
| `intent_expiry` | The mandate's expiry, as an ISO 8601 time in UTC |
| `user_cart_confirmation_required` | True for every mandate. AP2 0.1 requires it on an intent mandate the user hasn't signed, and the pair carries no signature. Asking the user, who is the business's administrator here, to confirm every cart is at least as strict as any approval rule |
| `natural_language_description` | Whatever the adapter writes |
| `skus` | Null, since a mandate limits categories |
| `requires_refundability` | False |

### What version 0.1 can't carry

- **An approval rule.** The confirmation flag is AP2 0.1's only control, and it can't say "above an amount". The rule travels in the extension.
- **Caps, payment limits, categories, the account, the agent key and the nonce.** They travel in the extension, which an AP2 reader that doesn't know Avow ignores.
- **A signature.** AP2 0.1's intent mandate has no field for one, so a pair proves nothing about who authorized it.
- **An expiry after the year 9999.** An ISO 8601 time with a four-digit year can't write it, so `toAp2IntentMandate` refuses that mandate as `message.validity_too_long`.

### Reading a pair back

`fromAp2IntentMandate` takes any JSON value and parses it against AP2 0.1's intent mandate and the extension, and it refuses a field neither defines. A field AP2 leaves optional reads as AP2 defines it when it's left out. Missing merchants or SKUs allow any, missing refundability requires none, and a missing confirmation flag is true. The intent expiry has to be an ISO 8601 time with a `Z` or an offset, to the whole second, since a time without an offset reads differently in every time zone.

Reading back refuses a pair whose halves disagree with `mandate.ap2_mismatch`. That covers a confirmation flag that isn't true, any SKUs, required refundability and an empty merchant list. AP2's reference implementation spells refundability `requires_refundability` and the example on its A2A extension spells it `required_refundability`, and the reader refuses a requirement in either. A shape that doesn't parse, or a value no mandate can hold, is refused as `message.invalid`.

The mandate read back from a pair binds nobody on its own. Its authority comes from the administrator's signature over it, made with the business account's root key, and the pair doesn't carry that signature. An adapter that accepts AP2 has to get the signed mandate and check that signature, as Avow and the verifier do for any mandate, before it acts on what the pair says.

An AP2 cart mandate corresponds to the signed terms agreement and Avow's approval together, since those fix one purchase.
