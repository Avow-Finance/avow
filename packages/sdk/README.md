# @avow-finance/sdk

The TypeScript SDK an agent uses to make commitments backed by Avow reserves. An agent books with a supplier, has Avow approve the reserve, checks the approval against the terms, and funds the reserve from its business's account with its own key, while Avow's relay pays the fee. It then reads what the lock holds, and it cancels or starts the job once Avow serves the records those calls need.

> **Status:** pre-release and testnet only. The lock it calls is unaudited testnet code, and every interface here may change before 1.0.

## Booking

`createAgent` takes the agent's access key on its business account, the mandate the business's administrator signed for it, the token the lock holds, the terms profile, and a connection to Avow. `book` takes a supplier, a mandate category and the commitment's version 2 terms, which the caller builds with the template the booking falls under, such as `gpuReservationTerms` from `@avow-finance/spec` for a GPU reservation. A later template needs no change to the SDK. `book` then does the following.

1. It runs the mandate check that Avow and a supplier's verifier run, which checks the terms against their template's rules and the profile too. It refuses terms of any other version, terms that break their rules and a booking the mandate doesn't allow. It also refuses, for now, a reserve the mandate sends to the administrator to approve in person.
2. It makes the commitment's id and a random salt, and signs the terms agreement with its key. The supplier signs the same agreement once it has checked the terms and salt give the agreement's terms hash. A supplier signature from another key is refused before Avow sees it.
3. It asks Avow's reserve check to approve, and passes on Avow's refusal with its decision id.
4. It checks Avow's approval before any money moves. The approval's envelope has to name this chain and lock. The approval has to name this commitment, the supplier's own account, signing key and payout, the lock's token, exactly what the terms map to, and the mandate's hash, caps and the agent's key as the funding key. It also has to be one the lock still takes, before its expiry and the acceptance deadline, and it can't stay valid for more than five minutes. The lock enforces what the approval says, so the agent funds nothing it didn't agree.
5. It funds the reserve in one transaction from the business's account, approving the lock to pull the amount and calling `reserve`. Then it reads the lock as of the block the transaction landed in, and checks the lock holds the reserve under Avow's approval.

It returns the commitment with its terms, salt, agreement and approval. Keep the salt private, since showing a section of the terms or checking the commitment later needs it.

When funding fails, `book` settles the booking against the lock. Avow's approval stops working at the earlier of its expiry and the acceptance deadline, so `book` waits for a finalized block at or past that moment and reads the lock as of it. A read that fails is read again, and an empty lock counts only when the latest block agrees. If the reserve landed anyway, `book` returns the commitment. Its `reservedIn` is null when the reserve landed in a transaction the agent didn't send, or the receipt of the agent's own couldn't be read. Otherwise `book` throws a `BookingError` carrying the commitment and every hash sent. Its outcome is `failed` when the lock holds no reserve, and `unknown` when the chain didn't reach that block in time. `reconcile` takes what the error carries and reads the lock again later, so the agent settles the same booking.

`commitment` reads what the lock holds for a commitment. `cancel` tells Avow the business cancels. `start` reads the lock first and starts only a commitment the lock holds with that supplier's signing key. It has Avow timestamp the request and the supplier sign its start receipt, checks the receipt answers the request and comes from that key, and has Avow record the start. Both need the mandate to permit the action, and an agent has them only when its `AvowApi` has `records`, Avow's records of cancellations and starts, which `httpAvowApi` serves. `cancel` records a late cancellation. Before free cancellation ends the business cancels on the lock instead, and Avow refuses with `commitment.cancel_on_lock`. An `AvowApi` without records gives an agent no `cancel` or `start`, and code that calls one doesn't compile. Called from JavaScript, either throws before reading or sending anything, with an error saying what isn't served.

## What it talks to

- **Avow.** `AvowApi` is Avow's side of the commitments: the reserve check, the relay that pays fees, and the records of cancellations and starts. The records are one optional group, `records`, which holds `cancel`, `requestStart` and `recordStart` together, so an `AvowApi` serves all three or none. `httpAvowApi` implements it over Avow's hosted API, with each call signed by the agent's own access key through `agentRequestKey`, as [signed requests](../spec/signed-requests.md) sets out. Each call is one operation with its own request id. After no answer, an answer of any status whose body isn't JSON, a 5xx or `request.in_progress`, the client sends the same bytes again until Avow answers definitely, and Avow answers an identical repeat without acting again. Avow answers with JSON whatever the status, so a load balancer's HTML 429 goes again, while a JSON 4xx other than `request.in_progress` is definite and thrown at once. An answer that is JSON but not the call's answer, such as an approval for another lock or a message version the SDK doesn't read, would come back the same, since a repeat gets the recorded answer, so the client throws it at once with the parser's reason code. It never follows a redirect. It serves the reserve check, the relay and the records. Each record's answer carries Avow's timestamp on the request, and the client checks that it names the digest of the request the agent signed and the time the answer gives. Demos and tests can pass a local implementation instead. Keep that implementation's own type, with `satisfies AvowApi` rather than a declared `AvowApi`, since the agent's calls follow the type it's given. A JavaScript caller's partial `records` is refused when the agent is made.

Every failure is an `AvowApiError` with the status, the reason Avow gave and the request id. Its `definite` says whether Avow answered definitely. When it's false the client gave up with no definite answer, so Avow may still have recorded the request, and a caller shouldn't treat it as refused. `retryFor` sets how long the client keeps trying, ten minutes by default, and `onResend` hears about each resend so a long run of them never goes unseen.
- **The supplier.** `SupplierConnection` is the agent's channel to one supplier, which the supplier's own integration implements.
- **The chain.** The agent's client reads the lock and sends the funding transaction.

## Fees

The business needs no fee token. `sendSponsored` has the key sign the transaction with `feePayer: true`, and Avow's relay co-signs it only when each call goes to the business's own lock or approves that lock to pull the reserve token. The agent checks the relay's bytes carry exactly the payload the key signed and the key's own signature. That covers every call with its destination, data and value, the nonce, the expiry and the fees, and leaves the relay only the fee token and its own signature. Then the agent sends the bytes and tracks their hash from the start, since Tempo's public RPC can answer with an error after a transaction has landed.

A sponsored transaction is valid for under half a minute. The sender reads the latest block before the key signs, and signs again only once it has read every block from there up to one later than that expiry and found the transaction in none. It reads blocks by number and only once they're finalized, which on Tempo means no later answer can change them. Each block has to name the one read before it as its parent, or the scan starts again. A block it can't read stops it there until a later read gets it, so it never skips one. It signs three times at most. `sendSponsored` throws a `SendError` whose outcome says whether anything it sent can still land. That answer assumes nobody but the sender sends the signed transaction, since anyone holding it could land it until it expires, so a relay must never send what it co-signs. `book` reads the lock to settle a failed funding, so its outcomes hold without that assumption. An agent whose wallet pays its own fees can pass its own `send` to `createAgent`.

## The lock's interface

`RESERVE_ABI` is the interface of the one lock function an agent's key calls, matched to the lock deployed on Moderato. It's testnet code, unaudited, and a new factory can change it. Knowing it grants nothing. On every call the lock checks Avow's signature over the whole approval, that the account calling is the business and the key signing is the approval's funding key, that the business approved the supplier, and the approval's caps and expiry. Those checks protect a reserve. The lock's source stays private until its audit, and no reserve's safety rests on that.

`triggerCall` builds the lock's `trigger`, which sends the step due for one side of a commitment once its deadline has passed, such as returning a reserve the supplier never accepted or releasing a kept one at its release date. Anyone may send it. The lock reverts when nothing is due and pays only the parties it recorded. The [keeper](../../examples/keeper) sends it from a key made for each run.

## The administrator's side

`signMandate` and `signHumanApproval` sign for the business account with its root or an admin key, in Tempo's keychain V2 envelope, which the lock and Avow's API need. A browser passkey signs bare, and the envelope is added for it. `agentKeyTerms` turns a mandate into the key authorization Tempo enforces. Pass `[RESERVE_SELECTOR]` as the lock functions, so `reserve` is the one lock function the key can call.

## Moderato

Every Avow deployment so far runs on Moderato, Tempo's testnet. `moderatoClient` gives a client for it that pays fees in AlphaUSD, `MODERATO_FEE_TOKEN`, through `MODERATO_RPC_URL` unless you pass another RPC, and `createAgent`, `sendOwn` and the verifier's `tempoChainReader` all take it. `moderatoUsdToken` describes a USD token on Moderato as the `RailToken` the agent and the verifier take, with the 6 decimals every USD token on Tempo has. Both quickstarts use these.

## Use

```ts
import { createAgent } from '@avow-finance/sdk'
import { gpuReservationTerms, TESTNET_DEMO_PROFILE } from '@avow-finance/spec'

// client, key, mandate, token, avow and supplier come from the business's setup, and booking
// states the GPUs, the window, the price, the charges and the dispute terms.
const agent = createAgent({ client, key, mandate, token, profile: TESTNET_DEMO_PROFILE, avow })

const terms = gpuReservationTerms(booking)
const booked = await agent.book({ supplier, terms, category: 'compute' })
if (!booked.ok) throw new Error(booked.reason)
const { commitmentId } = booked.commitment

// The lock holds the reserve, and shows the supplier's acceptance once it lands.
console.log(await agent.commitment(commitmentId))
```

## Develop

```sh
pnpm --filter @avow-finance/sdk test
AVOW_LIVE_TEMPO=1 pnpm --filter @avow-finance/sdk test
```

The second line also sends a sponsored transaction on Moderato from keys made for the run, which the testnet faucet funds.
