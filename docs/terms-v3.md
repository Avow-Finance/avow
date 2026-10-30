# Version 3 terms

A booking can rely on another business's booking. A compute reseller sells a training agent 8 H100s and books the same capacity from a GPU cloud, so the reseller's sale stands on its own purchase. The sale uses version 3 terms, which are version 2 terms with one more section, `dependencies`, and one more header field, `dependencyCheck`. A plain booking keeps version 2, byte for byte. Everything on this page is in `@avow-finance/spec`, and [Checking the bookings a booking relies on](dependency-check.md) covers who checks a dependency, when, and what that proves.

## The dependencies section

Each entry in `dependencies` names one booking this one relies on.

| Field | Holds |
| --- | --- |
| `on` | The booking relied on, as a commitment reference: chain, lock, commitment id, side and terms hash. The side is always `buyer`, and the lock has to be the seller's own |
| `condition` | The state that booking has to be in at each check. Version 3 knows one, `accepted`, which means its lock holds it as accepted with no report filed |
| `disclosed` | The section of that booking the seller shows whoever checks it. Version 3 allows only `subject`, the resource and the window |

The section holds one to four entries, each naming a different booking whatever terms hash each gives, and `parseChainedTerms` and `validateChainedTerms` refuse anything else. The terms say nothing about what happens if a booking relied on fails. A booking can't rely on itself or on a booking that relies on it, since an entry names a terms hash that already exists and the new booking's terms hash covers the entry.

For GPU reservations, `gpuSubjectFits` says whether a booking fits inside the one it relies on. It asks for no more GPUs, of the same GPU and in the same region, inside that booking's window. The SKU isn't compared, so a reseller can sell part of what it booked under its own SKU. A subject the template refuses never fits, so a booking that asks for no GPUs, or for a window with no length, can't slip through the comparison.

## Dependency disclosure control

`dependencyCheck` says who checks the bookings the dependencies section names on the buyer's behalf. There's one setting for the whole section, and no entry carries one, so a section can never mix the two.

| Setting | Who checks | What the buyer is shown |
| --- | --- | --- |
| `buyer`, the default | The buyer reads each booking from the chain itself before it signs | The terms in full, every reference and the subject the seller shows for each |
| `avow` | Avow checks each booking before it approves, and the buyer relies on that approval | The terms with the dependencies section as its label and digest |

The seller and Avow see the terms in full in both settings. The setting sits in the header, which is hashed in the clear, so a buyer shown only the digest still reads the setting and checks it against the terms hash. A setting inside the hidden section would let a seller hide entries the buyer is meant to read, and the buyer couldn't tell. `chainedTerms` takes the setting as its third argument and defaults to `buyer`.

The setting controls what the buyer sees of the terms and nothing more. Neither setting changes what the seller's own lock shows anyone who watches it, which includes every booking the seller made upstream, so the `avow` setting never makes dependencies private.

## The buyer's view

In the `avow` setting the seller shows the buyer `elideDependencies(terms, salt)`, an `ElidedTerms` value. It's the terms with every section in clear except `dependencies`, which becomes `{ label, digest }`, the label `avow:terms:v3:dependencies` and the section's hash. Beside it, `salts` holds the own salt of each of the five sections in clear. The view never holds the commitment's salt or the dependencies section's salt.

The buyer reads a view with `parseElidedTerms` and works out its terms hash with `elidedTermsHash`. That's the hash of the terms in full, from the header, each section in clear hashed with its own salt, and the digest standing in for the hidden section. The buyer checks it against the hash Avow's approval names, and an approval that names it binds the hidden entries too. Two views that differ only in their hidden sections give different terms hashes, and so different approval digests.

A digest is salted, so nobody can confirm a guess at the hidden entries without the dependencies section's salt, which only the seller and Avow hold. That a dependencies section exists is visible by design, since the header says version 3 and the view carries the digest.

`parseElidedTerms` refuses a view whose header says `buyer`, a view that hides any other section, a view that shows the dependencies in clear, and an elided section that isn't exactly its label and a 32-byte digest. It also refuses a missing salt and a salt for the dependencies section. `elideDependencies` throws on terms in the `buyer` setting, and `elidedTermsHash` throws on any view `parseElidedTerms` would refuse.

## Readers that need the entries

A reader that needs the dependencies section in clear and gets only its digest refuses with `dependency.elided`, and never reads the section as empty or the booking as relying on nothing. `chainedTermsShapeProblem`, `validateChainedTerms` and `parseChainedTerms` refuse both the buyer's whole view and terms whose `dependencies` holds a digest, `termsHash` and `discloseSection` throw on them, and the verifier's dependency check refuses them before it reads anything.

## Hashing

Version 3 hashes the five version 2 sections exactly as version 2 does, under their `avow:terms:v2` labels and salts. The dependencies section gets its own salt, from the HKDF info `avow:terms:v3:salt:dependencies`, and its own label, `avow:terms:v3:dependencies`. Each entry's lock, commitment id and terms hash are hashed in lower case. The header is `version` 3, `template`, `currency`, `amountDecimals` and `dependencyCheck`, so the setting is part of the terms hash, and the same booking under the other setting is other terms. The terms hash is `keccak256(abi.encode(string "avow:terms:v3", string headerJson, bytes32 subject, bytes32 consideration, bytes32 remedies, bytes32 resolution, bytes32 backing, bytes32 dependencies))`. The buyer's view adds no hashing of its own.

`packages/spec/vectors/terms-v3.json` holds worked examples, one naming four bookings in mixed case and one in the `avow` setting with the buyer's view of it, from which the same terms hash reproduces. Its `invalid` list holds terms a version 3 reader refuses, each with the reason code, covering an empty section, five entries, two entries naming one booking in different letter case, an unknown condition or disclosed section, the supplier side, a key beside an entry's own, an unknown or missing setting, and dependencies given only as their digest. Its `invalidElided` list holds views a buyer refuses, covering malformed elision and a view that hides any section other than dependencies.

A reader that knows only version 2 refuses version 3. Terms relabelled as version 2 hold fields the version 2 hash would leave out, and dropping the dependencies gives another terms hash.

## Who takes version 3

Every check a plain booking goes through refuses version 3 as a version it doesn't read, exactly as it did before version 3 existed. That's `termsShapeProblem`, `validateTerms`, `checkMandate`, `parseTerms`, `parseAnyTerms`, the reserve request and the commitment record. A booking that relies on another is sound only once that booking is read from its lock, and none of these read a lock, so none of them can approve one. Version 3 has its own functions, `chainedTermsShapeProblem`, `validateChainedTerms` and `parseChainedTerms`, for a path that also runs the dependency check, and the buyer's view has `elideDependencies`, `parseElidedTerms` and `elidedTermsHash`. `plainTermsOf` gives the version 2 terms a version 3 booking makes, which pass the same rules and make the lock enforce the same values under another terms hash. Hashing and showing a section take either version, since neither approves anything.
