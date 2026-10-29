# Signed requests to Avow's API

Every request an agent or a supplier sends to Avow's API is signed by the key that sends it. This page fixes what is signed, how each part is encoded, the order in which Avow checks a request, how a repeated request is handled, and what a signature does and doesn't prove. The SDK and Avow's API both build on `api-request.ts`. A client in another language follows this page and checks itself against `vectors/api-request-v1.json`.

## What is signed

The signed message is EIP-712 typed data of type `ApiRequest`.

| Field | Type | Value |
| --- | --- | --- |
| `audience` | string | The deployment the request is for, in its canonical form |
| `method` | string | `GET` or `POST` |
| `path` | string | The request target exactly as sent, which is only ever a path |
| `bodyHash` | bytes32 | keccak256 of the body's exact bytes |
| `signer` | address | The signing key's own address |
| `requestId` | bytes32 | 32 random bytes that name the operation |
| `expiry` | uint64 | Unix seconds, after which Avow won't start the request |

The domain is `{ name: "Avow", version: "1", chainId, verifyingContract }`. The chain id is the one chain the deployment serves. The verifying contract is the lock of the business the request concerns, which the header names.

| Request | The header's lock | How Avow ties the lock to the request |
| --- | --- | --- |
| An agent's enrollment | The lock of the agent's business | The mandate is signed for that lock, and Avow's record of the business names it |
| Any other agent request | The lock of the agent's business | Avow finds the agent by its key within the business that owns this lock. An access key on two accounts is two agents, and a request acts only for the business whose lock it names |
| A supplier's request about a commitment | The buyer's lock that holds the commitment | Avow looks the commitment up by chain, lock and commitment id together, since commitment ids are unique only within one lock |

The message's version is its own, apart from the lock's messages, so it can change without a new lock. The lock never reads an `ApiRequest`, and an `ApiRequest` signature can't stand for any other message, since EIP-712 hashes its type into the digest.

## The audience

Each deployment of Avow's API has one audience string. It's the deployment's origin in lower case, with the scheme, a port only when it isn't the scheme's default, and no path, query or trailing slash. Testnet's is `https://api.testnet.avow.finance`. `isApiAudience` accepts exactly that form, so one deployment never has two audiences. A staging or local deployment has its own, so a request signed for one deployment fails on every other, even one on the same chain with the same keys enrolled.

A client takes the audience from its configuration and never from a redirect or a response. It doesn't follow redirects at all, so a signed body goes only to the deployment it was signed for. Avow compares the audience with its own configured string byte for byte.

## Encoding

Both sides check the same rules through `apiRequestProblem` before signing or verifying, and Avow refuses anything outside them with `request.invalid`.

- **Method.** `GET` or `POST`, in capitals, exactly as sent.
- **Path.** `/v1` followed by one or more segments of lower-case letters, digits, `-` and `_`, with hex ids in lower case. Avow checks the request target exactly as it arrived, before any routing or decoding, and routes on that same string. A target with a query, a fragment, a trailing slash, a `.` or `..` segment or any percent-encoding is refused, so no part of the target goes unsigned and no URL parser can read it two ways. A route that needs a parameter takes it as a path segment or in the body.
- **Body.** A `POST` carries the canonical JSON of its value in UTF-8, as `encodeApiBody` writes it: keys sorted, no whitespace, amounts and times as decimal strings, and any other number a safe integer. `bodyHash` is keccak256 of the exact bytes sent. Avow hashes the bytes as they arrive, decodes them as strict UTF-8, and refuses a body that isn't canonical, so a repeated key or a reordered object can't be read one way when it's checked and another way when it's stored. A request sent with a `Content-Encoding` is refused. A `GET` carries no body, and its hash is keccak256 of no bytes. A body may be at most 65,536 bytes.
- **Header.** `Authorization: Avow signer=<address>, lock=<address>, requestId=<bytes32>, expiry=<decimal>, signature=<hex>`. Fields are separated by a comma and one space, each appears once and nothing else may, so two readers can't take different values from one header. Avow reads hex in any case.
- **Signature.** The key's bare signature over the EIP-712 digest, the way the lock reads a signing key's: secp256k1, P-256 or WebAuthn, outside any keychain envelope. The message names the signer, because a passkey's signature doesn't.

## The order Avow checks in

Avow takes these steps in this order, and only the last one records anything.

1. **Form.** It checks the method, path and body with `apiRequestProblem` and reads the header. A failure here is `request.invalid` or `request.unsigned`.
2. **Signature.** It rebuilds the message from its own audience and chain, the header's lock, and the method, path and body it received, and checks the signature against the header's signer. A failure is `message.signature_invalid`. `verifyApiRequest` does steps 1 and 2.
3. **Request id.** It looks up the signer and request id. A record with the same digest gets the recorded answer. A record with another digest gets `request.id_reused`. A request still running gets `request.in_progress`.
4. **Expiry.** A request with no record starts only while its expiry is after Avow's clock and at most 300 seconds ahead of it, which `apiRequestExpiryProblem` checks. A failure is `message.expired` or `message.validity_too_long`. Since this comes after the lookup, an identical repeat of a request Avow already answered gets that answer even once the request has expired, and `message.expired` always means Avow did nothing with the request.
5. **Authority.** The route checks, from Avow's records and the chain, that this signer may do this thing now, as the section on who signed sets out.
6. **Action.** Avow acts or decides, such as running the reserve check, and writes the request's record, everything the action changes and its answer in one database transaction.

## Request ids and retries

`requestId` names one operation for one signer.

- **What's recorded.** Avow records a request at step 6, when it acts or decides, including a decision to refuse a reserve. A request refused at steps 1 to 5 isn't recorded, because nothing happened. That keeps anyone who makes up keys from filling Avow's records, and lets a client send the same bytes again once the cause is fixed. Avow keeps each record and its answer for at least 24 hours.
- **An identical repeat**, with the same signer, request id and digest, gets the recorded answer, and Avow repeats nothing.
- **The same id with other content**, with the same signer and request id and another digest, is refused with `request.id_reused`, and nothing is done.
- **A repeat while the first is running** gets `request.in_progress`. The record of a running request exists only inside the database transaction that's acting on it, so a crash or a failed action rolls it back with everything else. No request id is ever left blocked, and the same bytes start the request again.
- **No answer before commit.** No answer leaves Avow before its transaction commits. When an action includes a transaction Avow sends to the chain, its signed bytes and hash are part of that commit, and Avow broadcasts only after it, so a restart can always find what it sent.

A client makes a new request id for each operation, including each poll for something that changes, and reuses one only to send the same bytes again. After no answer, an unreadable answer, a 5xx or `request.in_progress`, it sends the same bytes again until Avow answers definitely, and it may keep doing so after the request's expiry.

## Answers

| Status | When | Body |
| --- | --- | --- |
| 200 | Avow acted or decided. A refused reserve is a decision, with `ok: false` and its reason code | The route's answer |
| 400 | `request.invalid`, `message.invalid`, `message.validity_too_long` and other problems with the request itself | An error |
| 401 | `request.unsigned`, `message.signature_invalid`, `message.expired` and `request.signer_unknown` | An error |
| 403 | The signer is known but may not do this now, such as `agent.revoked` or `mandate.expired` | An error |
| 404 | `business.unknown`, `supplier.unknown` or `commitment.unknown` | An error |
| 409 | `request.id_reused` or `request.in_progress` | An error |
| 422 | `sponsorship.refused` | An error |
| 503 | `service.unavailable`, when Avow couldn't read what the request depends on | An error |

An error body is `{ "error": { "reason": "<code>", "message": "<sentence>" } }`. A reader ignores any other field, and treats a reason code it doesn't know as no code.

## Who signed, and what they may do

A valid signature tells Avow which key sent the request. It grants nothing on its own. At step 5 each route checks that the key may do this thing now.

| Route | What Avow checks after the signature |
| --- | --- |
| Enrollment | The mandate is signed for the header's lock and names the signing key. The business owns that lock and is verified, its administrator signed the mandate as the business account, the mandate hasn't expired, and the key is on the chain bound to the mandate's hash |
| Reserve approval | The key is an enrolled agent of the business that owns the header's lock, and isn't revoked. The request names the signing key as its agent key, and the agreement's buyer signature is that key's. Then the full reserve check runs, including the mandate, its scope and the key on the chain |
| Sponsorship | The key is an enrolled agent of the business that owns the header's lock, isn't revoked, and its mandate is current. The transaction's sender is that business's account, and every call is one the relay pays for and the mandate permits |
| Supplier authorization | The key is the signing key of the supplier the commitment names, the commitment's agent isn't revoked, and the commitment's reserve is on the chain and not yet accepted |

Avow refuses an unknown key with `request.signer_unknown` and a revoked one with `agent.revoked`. If Avow can't read what a check needs, such as its own records or the chain, it refuses with `service.unavailable` and records nothing. It never approves, authorizes or sponsors on records it couldn't read, and the same bytes run every check again once it can.

## What a signed request proves

A signed request proves who asked Avow for what, and Avow's record of it proves when Avow received it. It proves nothing about what happened after. Avow keeps three kinds of record apart and links each to the request's digest.

- **The request.** The signed request and its body, as the record of what was asked.
- **The result.** What Avow decided or produced, such as a decision with its reason code, a signed approval, a refusal or a co-signed transaction.
- **The transaction.** For an action that reaches the chain, the transaction's hash and, once known, its block and outcome. A transaction whose outcome Avow doesn't know yet stays marked unknown until Avow has read the chain.

A reserve approval's evidence is three items. They are the agent's signed request, Avow's approval with its decision, and the reserve transaction, which the agent sends and Avow reads on the chain.
