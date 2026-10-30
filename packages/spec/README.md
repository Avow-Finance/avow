# @avow-finance/spec

The commitment schema that Avow's API, the SDK and the verifier all read. A supplier checks a commitment with the same code Avow used to approve it.

> **Status:** pre-release and testnet only. The terms format here is the working one, and it will change after supplier calls.

## What's public and what isn't

- **Public now.** This schema, the terms format and the verifier, under the repo's Apache 2.0 license.
- **Provisional.** Every layer carries its own version, and a reader refuses a version it doesn't know. A change to a signed message, the terms or their canonical JSON gets a new version of the layer it touches. Until 1.0 such a change can come in any release, and each release names it.
- **Later.** The written specification will go into the public domain (CC0) once a real counterparty has used the format. This code isn't that specification, and it isn't CC0.
- **Never here.** Customer terms, evidence, identity records and secrets stay out of this repo, its tests and its examples. Tests generate their own keys and use made-up businesses.

## What it holds

| Part | What it does |
| --- | --- |
| Records | Business, administrator, agent, mandate and commitment, with the 11 commitment states, the moves between them, the contest and outcome a record holds in each, and the references a record cites. `parseCommitment` refuses a record whose state can't hold its contest or outcome, or whose outcome's amounts don't fit its ending |
| Terms | Version 2 terms: a header and five sections, each hashed apart, with templates for what each kind of commitment promises. GPU reservation is the first template |
| Version 3 terms | Version 2 with one more section, `dependencies`, for a booking that relies on another business's booking |
| Version 1 terms | The flat GPU reservation format published before the terms had a version, frozen so commitments made under it stay verifiable |
| References | Typed references to a commitment or a settled payment, the checks of a payment against the chain's transfer event in a token the reader accepts, and the rule that a payment's value counts once |
| Signed messages | The mandate, the terms agreement, the supplier authorization, the administrator's approval, the start receipt and Avow's timestamp, each as EIP-712 typed data. A timestamp names a signed request by its digest and says when Avow received it, so a late cancellation or a start request carries a time anyone can check against Avow's timestamp key |
| Signed requests | How an agent or a supplier signs each request to Avow's API, and the bodies the API takes and answers with. [Signed requests](signed-requests.md) fixes the deployment binding, the encoding, request ids and retries, and what a signature proves |
| Supplier adapter | The two routes a supplier's adapter serves to agents, `SUPPLIER_ADAPTER_PATHS`, with the supplier's profile, the offer an agent sends and the signature or refusal the supplier answers with. The answer takes every kind of signature `isKeySignature` checks, so a supplier whose signing key is a passkey can answer |
| Lock messages | The messages the lock checks: Avow's approval, the supplier's acceptance, report, evidence and release consent, and the actions a business or supplier account signs with its root or an admin key. The acceptance names the approval's digest (`approvalDigest`), so it covers every term the approval sets for the commitment, and the lock takes the consent only while the commitment's report count equals the one it names. Fixed digests in the tests match the lock contract's, and the signatures the SDK makes for one whole commitment are pinned, so a change to how the SDK signs one fails a pin |
| Mandate check | The pure check Avow runs before it signs an approval, which the SDK can run before it asks |
| Reason codes | One stable code for every decision and every refusal |
| Adapters | How a mandate maps onto an AP2 0.1 intent mandate and back, and how a commitment reads as an ERC-8183 job. [Adapters](adapters.md) sets out both mappings and what doesn't carry over, and points a new AP2 adapter at AP2 0.2 |
| Keychain envelope | Tempo's keychain V2 envelope for signatures a business account's root or admin key makes, with an offline check and a check against Tempo's own verifier |
| Wire forms | JSON schemas that parse amounts and times from decimal strings. `readCommitmentId` reads a commitment id from text, such as a command's argument, in the lower-case hex every message carries |

## The terms, version 2

A commitment has three layers. The envelope is universal. The terms agreement both sides sign names the commitment, both businesses, the buyer's mandate, the chain, the lock and the terms hash, and the commitment record carries its state, evidence and references. The terms are a header and five sections. A template fixes what one kind of commitment promises, and only the subject depends on it.

| Part | Holds | What reads it |
| --- | --- | --- |
| Header | `version` (2), `template`, `currency` and `amountDecimals` (6) | Every reader, before any section |
| `subject` | What's promised and when, in the template's shape | The template |
| `consideration` | What the buyer owes for the subject, a `rate` per unit or a `fixed` amount | Nobody enforces it. The terms describe it |
| `remedies` | `acceptBy`, `freeCancelBy`, the `charges` the supplier can report, and `chargeDeadline` | The lock, through Avow's approval |
| `resolution` | `contestWindow`, the fallback `arbiter` and `day90SupplierShareBps` | The lock, through Avow's approval |
| `backing` | What secures the commitment: kind `reserve`, the `side` it backs, the `amount` and the `releaseDate` | The lock, through Avow's approval |

Remedies, resolution and backing hold everything a lock enforces, and the core refuses a charge kind, backing kind or side a lock can't enforce. The only backing this version takes is the buyer's reserve. A payment that has already settled is evidence that money moved, so no backing kind refers to one.

### Templates

`gpu-reservation/1` is the first template. Its subject is the GPU, count, region and SKU with the window's start and length, and its consideration is a rate per `gpu-hour`. Its own rules put free cancellation and acceptance before the window opens, a late cancellation chargeable from the free-cancellation deadline, a no-show chargeable once the grace period after the window's start has passed, and the window's end before the charge deadline. The grace period lives only in the no-show charge's start time. `gpuReservationTerms` builds terms from what a booking states.

A template's meaning never changes. A change in how a template reads its terms is a new template version, such as `gpu-reservation/2`. The core knows templates by id and refuses one it doesn't know, so a template is reviewed code and never something a party supplies.

### What the lock enforces

`lockTerms` maps terms to the fields of Avow's approval, which the lock stores and enforces. The side, amount and release date come from the backing, the deadlines and charges from the remedies, and the contest window, arbiter and day-90 share from the resolution. Avow's API builds its approval with this mapping, and `approvalTermsProblem` refuses an approval that differs from it in any field or names another terms hash. The verifier runs the same check against the supplier's own terms before it builds an acceptance, so an approval can't make a lock enforce anything the terms don't say. The terms name a currency and never a token, so the approval's token sits outside the mapping, and the API and the verifier each check that it's a token accepted for that currency.

`LOCK_TERMS_FIELDS` names every field `lockTerms` gives, and `lockTermsDifferences` is the one comparison of them. `approvalTermsProblem` runs it on an approval. `lockRecordDifferences` runs it on a lock's record, which holds every field but the side, since the lock files each record under its side. The verifier runs it on the four fields a supplier authorization carries, `AUTHORIZATION_TERMS_FIELDS`. The build fails when `LockTerms` gains a field the list leaves out, so a new field is compared everywhere at once. `approvalPartiesProblem`, `approvalTokenProblem` and `approvalMandateProblem` check the rest of an approval, and the SDK and the verifier both use them.

### Hashing

Every hash here is reproducible from these rules, and `vectors/terms-v2.json` holds worked examples that `scripts/write-terms-vectors.mjs` writes and the tests check. One of them has a checksummed arbiter and a region with non-ASCII letters and quotes, where an implementation that skips a rule would hash differently.

- **The terms' shape** is exactly the header's four fields and the five sections. The hash covers nothing else, so `termsShapeProblem` refuses a field beside them, a section that isn't an object and a value canonical JSON can't write, and `termsHash` throws on terms it refuses.
- **Canonical JSON** is RFC 8785. Amounts, times and durations are integers written as decimal strings. Amounts are millionths of the currency, times are UTC Unix seconds and durations are seconds. Every other number is a safe integer, such as a count or a share in basis points. Strings have to be well-formed Unicode, and non-ASCII characters are written as UTF-8 without escapes. Only plain objects and arrays are written, so a Date or a Map throws.
- **Section salts** come from HKDF-SHA256 (RFC 5869). The input keying material is the commitment's 32-byte salt, there's no HKDF salt, the info is the UTF-8 label `avow:terms:v2:salt:<section>`, and the output is 32 bytes. The commitment's salt comes from a cryptographic random source, one per commitment, and an all-zero salt is refused.
- **A section's hash** is `keccak256(abi.encode(string label, bytes32 sectionSalt, string canonicalJson))`, with the label `avow:terms:v2:<section>`. The arbiter's address is hashed in lower case.
- **The terms hash** is `keccak256(abi.encode(string "avow:terms:v2", string headerJson, bytes32 subject, bytes32 consideration, bytes32 remedies, bytes32 resolution, bytes32 backing))`.

Each section has its own label, so a section can't be read as another section. A version 1 hash covers the salt followed by the terms' JSON, whose first character is `{`, and a version 2 hash covers an ABI encoding whose 33rd byte is always zero, so a hash of one version can never match the other's. A change of backing changes the terms hash, so it makes a new commitment and no signature carries over to it.

### Showing one section

`discloseSection` shows one section with its own salt and the other four sections' hashes, and `checkSectionDisclosure` checks it against the terms hash a lock or a signed message holds. A business can show what it booked and when without showing a price. The commitment's salt never leaves the parties.

## The terms, version 3

A booking can rely on another business's booking. A compute reseller sells a training agent 8 H100s and books the same capacity from a GPU cloud, so the reseller's sale stands on its own purchase. The sale uses version 3 terms, which are version 2 terms with one more section, `dependencies`, and one more header field, `dependencyCheck`. A plain booking keeps version 2, byte for byte.

Each entry in `dependencies` names one booking this one relies on.

| Field | Holds |
| --- | --- |
| `on` | The booking relied on, as a commitment reference: chain, lock, commitment id, side and terms hash. The side is always `buyer`, and the lock has to be the seller's own |
| `condition` | The state that booking has to be in at each check. Version 3 knows one, `accepted`, which means its lock holds it as accepted with no report filed |
| `disclosed` | The section of that booking the seller shows whoever checks it. Version 3 allows only `subject`, the resource and the window |

The section holds one to four entries, each naming a different booking whatever terms hash each gives, and `parseChainedTerms` and `validateChainedTerms` refuse anything else. The terms say nothing about what happens if a booking relied on fails. A booking can't rely on itself or on a booking that relies on it, since an entry names a terms hash that already exists and the new booking's terms hash covers the entry.

For GPU reservations, `gpuSubjectFits` says whether a booking fits inside the one it relies on. It asks for no more GPUs, of the same GPU and in the same region, inside that booking's window. The SKU isn't compared, so a reseller can sell part of what it booked under its own SKU. A subject the template refuses never fits, so a booking that asks for no GPUs, or for a window with no length, can't slip through the comparison.

### Dependency disclosure control

`dependencyCheck` says who checks the bookings the dependencies section names on the buyer's behalf. With `buyer`, the default, the buyer is shown the terms in full and reads each booking from the chain itself. With `avow`, Avow checks each booking before it approves, the buyer relies on that approval, and the buyer is shown the dependencies section only as its label and digest. The seller and Avow see the terms in full in both. There's one setting for the whole section, and no entry carries one, so a section can never mix the two. The setting sits in the header, which is hashed in the clear, so a buyer shown only the digest still reads the setting and checks it against the terms hash. A setting inside the hidden section would let a seller hide entries the buyer is meant to read.

The setting controls what the buyer sees of the terms and nothing more. Neither setting changes what the seller's own lock shows anyone who watches it, which includes every booking the seller made upstream, so the `avow` setting never makes dependencies private.

### The buyer's view

In the `avow` setting the seller shows the buyer `elideDependencies(terms, salt)`, the terms with every section in clear except `dependencies`, which becomes its label `avow:terms:v3:dependencies` and its digest, the section hash. Beside it, `salts` holds the own salt of each section in clear, and the view never holds the commitment's salt or the dependencies section's salt. The buyer reads it with `parseElidedTerms` and works out the terms hash of the terms in full with `elidedTermsHash`, so an approval that names that hash binds the hidden entries too. The digest is salted, so nobody can confirm a guess at the hidden entries without the dependencies section's salt, and that a dependencies section exists is visible by design.

`parseElidedTerms` refuses a view whose header says `buyer`, a view that hides any other section or shows the dependencies in clear, an elided section that isn't exactly its label and a 32-byte digest, a missing salt and a salt for the dependencies section. A reader that needs the entries and gets only the digest refuses with `dependency.elided`, and never reads the booking as relying on nothing. `chainedTermsShapeProblem`, `validateChainedTerms` and `parseChainedTerms` refuse that way, and `termsHash` and `discloseSection` throw.

### Hashing

Version 3 hashes the five version 2 sections exactly as version 2 does, under their `avow:terms:v2` labels and salts. The dependencies section gets its own salt, from the HKDF info `avow:terms:v3:salt:dependencies`, and its own label, `avow:terms:v3:dependencies`. Each entry's lock, commitment id and terms hash are hashed in lower case. The header is `version` 3, `template`, `currency`, `amountDecimals` and `dependencyCheck`, so the setting is part of the terms hash. The terms hash is `keccak256(abi.encode(string "avow:terms:v3", string headerJson, bytes32 subject, bytes32 consideration, bytes32 remedies, bytes32 resolution, bytes32 backing, bytes32 dependencies))`. The buyer's view adds no hashing of its own.

`vectors/terms-v3.json` holds worked examples, one naming four bookings in mixed case and one in the `avow` setting with the buyer's view of it, from which the same terms hash reproduces. Its `invalid` list holds terms a version 3 reader refuses and its `invalidElided` list holds views a buyer refuses, each with the reason code.

A reader that knows only version 2 refuses version 3. Terms relabelled as version 2 hold fields the version 2 hash would leave out, and dropping the dependencies gives another terms hash.

### Who takes version 3

Every check a plain booking goes through refuses version 3 as a version it doesn't read, exactly as it did before version 3 existed. That's `termsShapeProblem`, `validateTerms`, `checkMandate`, `parseTerms`, `parseAnyTerms`, the reserve request and the commitment record. A booking that relies on another is sound only once that booking is read from its lock, and none of these read a lock, so none of them can approve one. Version 3 has its own functions, `chainedTermsShapeProblem`, `validateChainedTerms` and `parseChainedTerms`, for a path that also runs the dependency check, and the buyer's view has `elideDependencies`, `parseElidedTerms` and `elidedTermsHash`. `plainTermsOf` gives the version 2 terms a version 3 booking makes, which pass the same rules and make the lock enforce the same values under another terms hash. Hashing and showing a section take either version, since neither approves anything.

### What's checked and what isn't

Nothing on the chain enforces a dependency. Each booking is an ordinary commitment in its own lock under the same rules as any other, no money moves between the two locks, and neither lock knows about the other. The parties that rely on a dependency check it at set moments by reading the upstream lock directly.

A check refuses a booking the seller supplied itself from the same account (`dependency.self_supplied`), since that shows no one else accepted it. It can't tell when one owner runs two registered businesses, each with its own account.

A check proves that a matching booking by the seller had been accepted when it was checked, and it promises nothing after that. It doesn't set that capacity aside for this booking. Overselling isn't checked, so a seller can cite one upstream booking in many downstream bookings and each of them passes on its own. Between checks the upstream booking can be cancelled, charged or released, and nothing on the chain stops the downstream booking when that happens.

## Version 1 terms

Version 1 terms are flat and carry no version field. Commitments made under them stay verifiable. `termsHash`, `validateTerms` and `lockTerms` read version 1 as well as version 2, and version 1 keeps the hash, checks and mapping it was signed under, with its original vectors pinned in the tests. `parseAnyTerms` reads version 1 or 2 for checking a commitment already made, `parseTerms` takes version 2 only, for a new plain booking, and `parseChainedTerms` takes version 3 only.

## References and payments

A reference has a kind. A commitment reference is chain, lock, commitment id, side and terms hash, checked against the lock. A payment reference names a settled transfer by chain, transaction hash and log index, its canonical id, and states the token, sender, recipient, amount and memo. The reference names its own token and any contract can emit an event shaped like a token's, so `checkPaymentReference` takes the tokens the reader accepts and refuses any other. It passes only when the transaction succeeded and is finalized and the log at that index is that token's own TIP-20 `TransferWithMemo` event with exactly those values. A plain transfer without a memo, or anything read from calldata, doesn't count.

Any number of records can cite one payment as evidence, but its value counts at most once. `checkAttributions` refuses a second attribution of the same payment's value, whichever obligation it names. It proves uniqueness only within the set it's given, and it can't see an attribution another service or a later request makes. Before any version lets a payment's value be allocated, a persistent registry has to record each attribution atomically.

## Versions

| Layer | Version | Changes when |
| --- | --- | --- |
| Messages a lock checks | `LOCK_MESSAGE_VERSION`, 1 | The lock's code changes, which means a new lock |
| Each message a lock never sees | Its own entry in `MESSAGE_VERSIONS`, each 1 | That message changes |
| Terms | `version` inside the terms hash, 2 for a plain booking and 3 for one that relies on other bookings | The header, a section's schema, canonical JSON or the hashing changes |
| Template | In its id, such as `gpu-reservation/1` | What the template means changes |
| Commitment record | `COMMITMENT_RECORD_VERSION`, 3 | The record's own fields change. Version 2 added the references a record cites. Version 3 gave a reserve that went back at its release date its own kind of outcome, `reached_release_date`, which versions 1 and 2 recorded as `kept`, as they did the supplier's consent. A version 1 or 2 record reads as version 3, citing nothing when it's version 1. One that ended as `kept` stays version 2, so writing it back keeps its meaning |

Every signed message names its version, chain and lock in its EIP-712 domain, and carries a nonce and an expiry. A signed request to Avow's API carries a request id in place of the nonce, which names one operation. A reader refuses a version it doesn't know for that message type.

## Design rules

- Money in terms and mandates is in micros, millionths of the currency unit, so $500 is `500_000_000n`. A USD token on Tempo has 6 decimals, so its base units equal micros.
- Terms name a currency and never a token, so the same terms and terms hash work on any EVM rail. The token belongs to the commitment's backing record, in `BackingRef`.
- The reserve equals the largest charge in the terms. A contest window under 72 hours passes only the testnet demo profile. Each profile also fixes the timing of the locks its factory creates, and a supplier's verifier accepts no other. The production profile holds the intended production timing, which is unaudited and which no deployed factory uses yet. The testnet demo factory doesn't enforce every production limit.

## Develop

```sh
pnpm --filter @avow-finance/spec test
pnpm --filter @avow-finance/spec build && node packages/spec/scripts/write-terms-vectors.mjs
```

Tests generate their keys for each run and never write them anywhere. The second line rewrites the version 2 and version 3 vectors, which only a new terms version should need. The tests pin each published file by its hash, so a change that moves a published hash fails.
