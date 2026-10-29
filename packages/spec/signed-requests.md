# Signed requests to Avow's API

Every request an agent or a supplier sends to Avow's API is signed by the key that sends it. This page fixes what is signed, how each part is encoded, how Avow handles a repeated request, and what a signature does and doesn't prove. The SDK and Avow's API both build on `api-request.ts`, and a client in another language follows this page to produce requests Avow accepts.

## What is signed

The signed message is EIP-712 typed data of type `ApiRequest`.

| Field | Type | Value |
| --- | --- | --- |
| `audience` | string | The deployment the request is for, exactly as that deployment publishes it |
| `method` | string | `GET` or `POST` |
| `path` | string | The request's path, with no query |
| `bodyHash` | bytes32 | keccak256 of the body's exact bytes |
| `signer` | address | The signing key's own address |
| `requestId` | bytes32 | 32 random bytes that name the operation |
| `expiry` | uint64 | Unix seconds after which Avow won't start the request |

The domain is `{ name: "Avow", version: "1", chainId, verifyingContract }`. The chain id is the chain the deployment serves. The verifying contract is the lock of the business the request concerns.

| Request | Lock in the domain |
| --- | --- |
| An agent's request, including its enrollment | The lock of the agent's business, which its mandate names |
| A supplier's request about a commitment | The buyer's lock that holds the commitment |

The message's version is its own, apart from the lock's messages, so it can change without a new lock. The lock never reads an `ApiRequest`.

## The audience

Each deployment of Avow's API has an audience string of its own. It's the deployment's origin in lower case, with the scheme, the port when it isn't the default, and no path or trailing slash. Testnet's is `https://api.testnet.avow.finance`. A staging or local deployment has another, so a request signed for one deployment fails on every other, even one on the same chain with the same keys enrolled.

A client takes the audience from its configuration. It never takes it from a redirect or from a response. Avow compares the audience with its own configured string byte for byte, and a request whose signature verifies only under another audience fails.

## Encoding

Both sides check the same rules before signing or verifying, through `apiRequestProblem`, and Avow refuses anything outside them with `request.invalid`.

- **Method.** `GET` or `POST`, in capitals, exactly as sent.
- **Path.** `/v1` followed by one or more segments of lower-case letters, digits, `-` and `_`. Hex ids are written in lower case. There is no query string, no trailing slash, no `.` or `..` segment and no percent-encoding, so the path a client signs is the path Avow reads whatever either side's URL parser does. A route that needs a parameter takes it as a path segment or in the body.
- **Body.** A `POST` carries UTF-8 JSON, with amounts and times as decimal strings, as `toWire` writes them. `bodyHash` is keccak256 of the exact bytes sent, which Avow hashes as it receives them, before parsing. A request sent with a `Content-Encoding` is refused. A `GET` carries no body, and its hash is keccak256 of no bytes. A body may be at most 65,536 bytes.
- **Header.** The request carries `Authorization: Avow signer=<address>, lock=<address>, requestId=<bytes32>, expiry=<decimal>, signature=<hex>`. Fields are separated by a comma and one space, each appears once, nothing else may appear, and Avow reads hex in any case. Avow rebuilds the message from its own audience, the method, the path and the hash of the body it received, then checks the signature against the header's signer under the header's lock.
- **Signature.** The key's bare signature over the EIP-712 digest, the way the lock reads a signing key's: secp256k1, P-256 or WebAuthn, outside any keychain envelope. The signer is named in the message because a passkey's signature doesn't name it.

## Expiry

Avow starts a request only when its expiry is after Avow's clock and at most 300 seconds ahead of it. A request outside that window is refused with `message.expired` or `message.validity_too_long`, and nothing is recorded. The SDK signs each request for 120 seconds.

## Request ids and retries

`requestId` names one operation for one signer. Avow records each request it starts under its signer and request id, together with the request's digest, and keeps the record and its answer for at least 24 hours.

- **An identical repeat** has the same signer, request id and digest. Avow answers it with the first answer and repeats nothing. This holds after the request's expiry for as long as Avow keeps the record, so a client that lost an answer sends the same bytes again.
- **The same id with other content** has the same signer and request id and another digest. Avow refuses it with `request.id_reused` and does nothing, rather than guess which request was meant.
- **A repeat while the first is running** gets `request.in_progress`, and the client sends the same bytes again shortly.

Avow writes the record of a request, the records its action changes and its answer in one database transaction. A request that fails part way leaves no record, so the same bytes start it again, and no answer ever leaves Avow before its records are committed. When an action includes a transaction Avow sends, the transaction's signed bytes and hash are part of that commit, and Avow broadcasts only after it, so a restart can always find what it sent.

A client makes a new request id for each operation, including each poll for something that changes. It reuses an id only to send the same bytes again.

## Who signed, and what they may do

A valid signature tells Avow which key sent the request. It grants nothing on its own. Each route then checks, from Avow's records and the chain, that the key may do this thing now.

| Route | What Avow checks after the signature |
| --- | --- |
| Enrollment | The mandate names the signing key, the business is known and verified, its administrator signed the mandate as the business account, and the key is on the chain bound to the mandate's hash |
| Reserve approval | The key is an enrolled agent of the lock's business and isn't revoked, its mandate is current and permits reserves, and the full reserve check passes, including the key on the chain |
| Sponsorship | The key is an enrolled agent of the lock's business and isn't revoked, the transaction's sender is that business's account, and every call is one the relay pays for |
| Supplier authorization | The key is the signing key of the supplier the commitment names, and the commitment's reserve is on the chain and not yet accepted |

Avow refuses an unknown key with `request.signer_unknown` and a revoked one with `agent.revoked`. If Avow can't read what a check needs, such as its own records or the chain, it refuses with `service.unavailable` and does nothing. It never approves, authorizes or sponsors an action on records it couldn't read. A later request, or the same bytes again, runs every check afresh.

## What a signed request proves

A signed request proves who asked Avow for what, and Avow's record of it proves when Avow received it. It proves nothing about what happened after. Avow keeps three kinds of record apart and links each to the request's digest.

- **The request.** The signed request, as the record of what was asked.
- **The result.** What Avow decided or produced, such as a decision with its reason code, a signed approval, a refusal or a co-signed transaction.
- **The transaction.** For an action that reaches the chain, the transaction's hash and, once known, its block and outcome. A transaction Avow sent whose outcome it doesn't know yet stays marked unknown until Avow has read the chain.

So a reserve approval's evidence is three items: the agent's signed request, Avow's approval and decision, and the reserve transaction on the chain, which the agent sends and Avow reads.
