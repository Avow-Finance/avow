# Checking the bookings a booking relies on

A reseller sells capacity it booked from someone else, so its sale relies on its own purchase, and the sale's [version 3 terms](terms-v3.md) name that purchase. `verifyDependencies`, in `@avow-finance/verifier`, checks each booking named before anyone commits to the sale. It proves that a matching booking had been accepted when it was checked, and it promises nothing about that booking after that moment.

## Who checks, and when

Each booking is an ordinary commitment in its own lock, no money moves between the two locks, and neither lock knows about the other. So the parties that rely on a dependency check it at set moments, each by reading the reseller's lock directly. The terms' `dependencyCheck` setting, which these pages call dependency disclosure control, decides whether the buyer is one of them.

| Step | `buyer` setting | `avow` setting |
| --- | --- | --- |
| The buyer signs the terms | The buyer runs `verifyDependencies` and signs only once it passes | The buyer checks the terms hash of its view and relies on Avow's approval |
| Avow approves the reserve | Avow runs the same five tests and refuses with the same reason codes | The same |
| The reserve lands | Nobody checks. The lock checks Avow's approval and the terms hash, and knows nothing of the dependency | The same |
| The reseller accepts | `prepareAcceptance` runs `verifyDependencies` before anything else reads the terms | The same, since the reseller holds the terms in full |
| After acceptance | Nothing gates the booking | The same |

## The five tests

Before it reads anything, the check refuses terms whose shape, setting, dependencies section or subject break the rules. Terms carrying the dependencies section only as its digest are `dependency.elided`. The terms name only the buyer side of a lock, so an entry naming the supplier side is `terms.invalid`, and a subject the template refuses, such as one asking for no GPUs, gives the template's reason. Then it reads each booking's lock and refuses with the first reason that applies.

1. **Provenance.** The lock is on a chain the caller supports, that chain's supported factory lists it, and the lock's own factory field names the same factory (`dependency.lock_unknown`). A lookalike contract with the same functions and an accepted booking is refused here, and nothing is read from it.
2. **Ownership.** The lock belongs to the account the sale names as its supplier (`dependency.not_owned`), so a reseller can't cite another business's booking.
3. **State.** The lock holds the booking (`dependency.not_found`), its supplier isn't the seller's own account (`dependency.self_supplied`), and the lock holds it as accepted with no report filed. A reserved booking is `dependency.not_accepted`, a filed report, pending charge or paused charge is `dependency.charge_pending`, and a released, charged or resolved booking is `dependency.ended`.
4. **Terms.** The lock holds it under the terms hash the sale names (`dependency.terms_mismatch`), and the subject the reseller shows hashes to that terms hash (`dependency.disclosure_invalid`).
5. **Fit.** The sale asks for no more GPUs, of the same GPU and region, inside the booking's window (`dependency.does_not_fit`).

## Reads pinned to one block

The caller passes one `PinnedLockReader` for each chain and factory pair it supports, and the check reads no other chain or factory. `tempoLockReader` reads Tempo. Each reader pins the latest finalized block once per check, at its first read, and every read through it names that block by number. No later block can change what the check saw, and every booking read through one reader is read at the same block. Once a booking's reads finish, the check confirms the block at that height still has the hash it was pinned with. A read that fails, takes longer than ten seconds or can't be pinned refuses with `dependency.unreadable`, never as not found and never as a pass. The result records the block each booking was read at.

## Accepting a booking that relies on others

For version 3 terms, in either setting, `prepareAcceptance` runs `verifyDependencies` before anything else reads the terms, with the reseller's own account as the one whose lock has to hold each booking relied on. The prepared acceptance lists each booking with the block it was read at, as its own copies, so freezing the acceptance leaves the reseller's terms alone. Version 3 terms reach the authorization checks only as the checked terms `verifyDependencies` gives back. `verifySupplierAuthorization` refuses version 3 terms, since it doesn't read the bookings they rely on.

## What the buyer sees

In the `buyer` setting the buyer sees the subject the reseller shows, every reference in the terms, and whatever the lock a reference names shows anyone. The lock's public view of the reseller's booking shows its reserve and how much the lock still holds, each charge's cap and the time it becomes chargeable, the free-cancellation, acceptance and charge deadlines, the release date, the contest window, the arbiter, the day-90 share, the GPU cloud's account, signing key and payout address, and the booking's state and reports. Of what the reseller pays, only the rate stays hidden. The consideration section alone holds it, the lock never stores it, and the buyer gets that section's salted hash and not its salt.

In the `avow` setting the buyer sees the terms with the dependencies section as its label and digest, so it learns that the booking relies on others and which setting applies, and nothing about which bookings they are. The digest is salted, so the buyer can't confirm a guess at the hidden entries unless the dependencies section's salt leaks.

Neither setting changes what the reseller's own lock shows. Anyone who watches that lock, the buyer included, sees every booking the reseller made upstream, with its reserve, charge caps, deadlines and supplier. The `avow` setting hides which of them this booking relies on, and it never makes the reseller's upstream bookings private.

## What the buyer can verify when Avow checks

The buyer can check that Avow's approval binds these exact terms, hidden section included. It works out the terms hash from its view with `elidedTermsHash`, and the approval names a terms hash, which the approval's digest covers. A view whose hidden section differs gives another terms hash, so an approval built for one view never matches the other.

The buyer can't check what Avow looked at, such as which block Avow read or what each test found. Nothing Avow signs today records that. A signed receipt of Avow's check is proposed, and it isn't built.

## When a check holds

A check proves that a matching upstream booking was accepted when it was checked, and it promises nothing after that. The upstream booking can be cancelled, charged or released right after any check, and nothing on the chain stops the downstream booking when that happens.

### Between Avow's approval and the reserve

Avow's check isn't atomic with funding. The upstream booking can leave the accepted state after Avow approves and before the buyer's reserve lands, and the lock still takes the reserve, since it checks only Avow's approval and the terms. Three things bound that gap.

1. **Expiry.** The lock takes a reserve only before the approval's expiry, and Avow gives an approval for a booking that relies on others 120 seconds, so a stale approval can't fund a reserve later.
2. **Recheck and cancel.** Until the reserve lands or the approval expires, Avow rechecks the upstream lock and cancels the approval if the booking leaves the accepted state. The cancellation stops the funding only if it lands on the chain before the reserve does. When the reserve lands first, the recovery below applies.
3. **Recovery.** A reseller that accepts through `prepareAcceptance` doesn't accept a reserve that landed against an upstream booking that has left the accepted state, since the check refuses it. The protocol doesn't make a reseller use that check, and the lock takes any acceptance the reseller signs. While nobody has accepted, the money stays in the buyer's lock until one of three paths returns all of it. Avow returns an unaccepted reserve, the buyer cancels before the free-cancellation deadline, or anyone triggers the return once the acceptance deadline passes. If the reseller accepts anyway, the booking is accepted like any other, and the reserve comes back only by the ordinary rules, the buyer's free cancellation before its deadline, the reseller's consent, the release date with nothing reported, or the dispute path for any charge the reseller reports.

### After acceptance

Nothing gates the downstream booking once the reseller accepts. The buyer can watch the upstream lock's events, and in the `buyer` setting it knows which booking to watch. A release alone never means failure, since a kept booking ends in a release.

| Upstream event | What it means |
| --- | --- |
| Released by the GPU cloud's consent, as kept | The GPU cloud's job started as agreed, the normal path |
| Released at the release date | The upstream window ended with no charge, also normal |
| Released by the GPU cloud's consent, as `supplierFailed` | The GPU cloud says it didn't deliver |
| Released by free cancellation | The reseller gave up its upstream booking |
| A report filed, a charge pending or a charge paused | The GPU cloud reported a charge against the reseller, such as a late cancellation or a no-show |

The last three mean the capacity may be gone, and none of them changes the downstream booking by itself. The reseller finds other capacity or releases the buyer's reserve, and anything contested goes to the ordinary dispute path, where each party files evidence from its own booking.

## What isn't checked

Overselling isn't checked in this version. One upstream booking can back several downstream bookings, each of which passes on its own, since the check sets nothing aside for the booking that relies on it.

A booking can't rely on itself or form a cycle with another. The booking itself sits in its buyer's lock, which the reseller doesn't own, and is still reserved while it's checked. In a two-booking cycle each booking needs the other accepted first, and the check refuses a reserved booking, so neither can be accepted through it. Their terms hashes rule a cycle out as well, since each entry names a terms hash that already exists. Two entries naming one booking in one section are refused as `terms.invalid`.

The check refuses a booking the reseller supplied from its own account, and it can't tell when one owner runs two registered businesses, each with its own account.
