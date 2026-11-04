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

`commitment` reads what the lock holds for a commitment. `cancel` tells Avow the business cancels. `start` reads the lock first and starts only a commitment the lock holds with that supplier's signing key. It has Avow timestamp the request and the supplier sign its start receipt, checks the receipt answers the request and comes from that key, and has Avow record the start. Both need the mandate to permit the action, and an agent has them only when its `AvowApi` has `records`, Avow's records of cancellations and starts, which `httpAvowApi` serves. `cancel` records a late cancellation. Before free cancellation ends the business cancels on the lock instead, with the call `cancelFreeCall` builds, and Avow refuses with `commitment.cancel_on_lock`. Once the no-show charge can be reported a cancellation no longer changes the charge, and Avow refuses with `commitment.cancel_closed`. A commitment has one cancellation, so a later `cancel` gets the first one's time. An `AvowApi` without records gives an agent no `cancel` or `start`, and code that calls one doesn't compile. Called from JavaScript, either throws before reading or sending anything, with an error saying what isn't served.

## What it talks to

- **Avow.** `AvowApi` is Avow's side of the commitments: the reserve check, the relay that pays fees, and the records of cancellations and starts. The records are one optional group, `records`, which holds `cancel`, `requestStart` and `recordStart` together, so an `AvowApi` serves all three or none. `httpAvowApi` implements it over Avow's hosted API, with each call signed by the agent's own access key through `agentRequestKey`, as [signed requests](../spec/signed-requests.md) sets out. Each call is one operation with its own request id. After no answer, an answer of any status whose body isn't JSON, a 5xx or `request.in_progress`, the client sends the same bytes again until Avow answers definitely, and Avow answers an identical repeat without acting again. Avow answers with JSON whatever the status, so a load balancer's HTML 429 goes again, while a JSON 4xx other than `request.in_progress` is definite and thrown at once. An answer that is JSON but not the call's answer, such as an approval for another lock or a message version the SDK doesn't read, would come back the same, since a repeat gets the recorded answer, so the client throws it at once with the parser's reason code. It never follows a redirect. It serves the reserve check, the relay and the records. Each record's answer carries Avow's timestamp on the request, and the client checks that it names the digest of the request the agent signed and the time the answer gives. A commitment cancelled earlier answers with that cancellation and a `cancelledBy` naming the request that carried it, and the client rebuilds that request's digest for this commitment and checks the timestamp names it. Demos and tests can pass a local implementation instead. Keep that implementation's own type, with `satisfies AvowApi` rather than a declared `AvowApi`, since the agent's calls follow the type it's given. A JavaScript caller's partial `records` is refused when the agent is made.

Every failure is an `AvowApiError` with the status, the reason Avow gave and the request id. A refusal by Avow's relay also carries what the relay added in `sponsorship`, such as when the key can ask again, as [relay refusals](../../fern/docs/pages/relay-refusals.mdx) sets out. Its `definite` says whether Avow answered definitely. When it's false the client gave up with no definite answer, so Avow may still have recorded the request, and a caller shouldn't treat it as refused. `retryFor` sets how long the client keeps trying, ten minutes by default, and `onResend` hears about each resend so a long run of them never goes unseen.
- **The supplier.** `SupplierConnection` is the agent's channel to one supplier, which the supplier's own integration implements.
- **The chain.** The agent's client reads the lock and sends the funding transaction.
- **The sandbox's screen.** On testnet, `sessionRelay` posts a sandbox business's events to a session through Avow's API, each signed by the business's root key under its lock, so Avow relays only what a registered sandbox business sent. `sessionUrl` links to the screen that shows the session, and `verifyUrl` links to the page that checks a commitment against its lock.

## Fees

The business needs no fee token. `sendSponsored` has the key sign the transaction with `feePayer: true` and a gas limit 15% over the node's estimate, since the relay pays only up to the limit the key signed and the estimate for a business's first reserve leaves little room. The headroom stops at the relay's gas cap, `SPONSORED_RESERVE_GAS_CAP` from the spec unless `gasCap` names a deployment's lower one, and an estimate already over the cap goes as it is, so the relay's refusal names what the transaction needs. Avow's relay co-signs it only when each call goes to the business's own lock or approves that lock to pull the reserve token. The agent checks the relay's bytes carry exactly the payload the key signed and the key's own signature. That covers every call with its destination, data and value, the nonce, the expiry and the fees, and leaves the relay only the fee token and its own signature. Then the agent sends the bytes and tracks their hash from the start, since Tempo's public RPC can answer with an error after a transaction has landed.

A sponsored transaction is valid for under half a minute. The sender reads the latest block before the key signs, and signs again only once it has read every block from there up to one later than that expiry and found the transaction in none. It reads blocks by number and only once they're finalized, which on Tempo means no later answer can change them. Each block has to name the one read before it as its parent, or the scan starts again. A block it can't read stops it there until a later read gets it, so it never skips one. It signs three times at most. `sendSponsored` throws a `SendError` whose outcome says whether anything it sent can still land. That answer assumes nobody but the sender sends the signed transaction, since anyone holding it could land it until it expires, so a relay must never send what it co-signs. `book` reads the lock to settle a failed funding, so its outcomes hold without that assumption. An agent whose wallet pays its own fees can pass its own `send` to `createAgent`.

## The lock's interface

`RESERVE_ABI` is the interface of the one lock function an agent's key calls, matched to the lock deployed on Moderato. It's testnet code, unaudited, and a new factory can change it. Knowing it grants nothing. On every call the lock checks Avow's signature over the whole approval, that the account calling is the business and the key signing is the approval's funding key, that the business approved the supplier, and the approval's caps and expiry. Those checks protect a reserve. The lock's source stays private until its audit, and no reserve's safety rests on that.

`triggerCall` builds the lock's `trigger`, which sends the step due for one side of a commitment once its deadline has passed, such as returning a reserve the supplier never accepted or releasing a kept one at its release date. Anyone may send it. The lock reverts when nothing is due and pays only the parties it recorded. The [keeper](../../examples/keeper) sends it from a key made for each run.

## The administrator's side

`signMandate` and `signHumanApproval` sign for the business account with its root or an admin key, in Tempo's keychain V2 envelope, which the lock and Avow's API need. A browser passkey signs bare, and the envelope is added for it. `agentKeyTerms` turns a mandate into the key authorization Tempo enforces. Pass `[RESERVE_SELECTOR]` as the lock functions, so `reserve` is the one lock function the key can call.

The account's root key sends its own calls to the lock. `approveSupplierCall` lets the business's agents reserve for a supplier, `cancelFreeCall` cancels a commitment before free cancellation ends and gives the whole reserve back, and `contestCall` contests a charge. All three are in `ADMINISTRATOR_ABI`, whose selectors a test pins against the deployed locks. `cancelsFree` says whether the lock takes that cancellation now, from what it holds for the commitment and the chain's clock, with no mandate involved.

## Contesting a charge

`contest` contests a charge the supplier reported, with the business account's root key, and gives Avow the business's statement. It takes the root key, the lock, a client and Avow's records for the business, which `httpBusinessRecords` serves with each request signed by the root key through `rootRequestKey`. It reads the lock and the chain's clock first, and refuses before sending anything when the lock holds nothing for the commitment (`chain.reserve_missing`), the business has already contested it (`contest.already_contested`), no charge is pending and no report stands or the commitment has ended (`contest.not_contestable`), or a pending charge's contest window closes within `CONTEST_SEND_MARGIN`, 25 seconds, of the latest block's time (`contest.window_closed`), since the root key's transaction stays valid that long and the lock reverts one that lands after the window. It throws, sending nothing, when the root key isn't the account that owns the lock. A contest can't be taken back, so it also refuses a reason that doesn't answer the kind of charge reported (`contest.reason_not_for_charge`) and text the statement format doesn't take (`contest.statement_invalid`).

Then it builds the statement for the report the lock holds and sends the lock's `contest` from the root key, which pays its own fee, signed locally and tracked by its hash through `sendOwn`. `onSent` hears the statement and the hash before the bytes go out, so a caller can settle a run that stops. A send that fails or whose outcome is unknown throws the sender's `SendError`. Once the receipt shows the lock's `Paused` event for this contest, `contest` posts the statement to Avow. It returns the contest with the charge it paused, the pause time and `ruleBy`, the end of Avow's ruling time, which is the pause plus the lock's `rulingKeyEnd`.

The contest stands whether or not Avow takes the statement, so the result says which. `postContestStatement` posts the same statement again at any time, and Avow answers a repeat with its first answer. Avow records a statement only once the contest's block is final, and its node can be a block behind the one that gave the receipt, so while Avow answers `contest.not_on_chain` the SDK asks again, up to `STATEMENT_TRIES` times, two seconds apart. `readLandedContest` reads a contest from its transaction, for a caller that stopped after sending, with the charge of the report the contest named as the lock held it in the contest's block, so a report the supplier files after withdrawing that one never reads as the charge contested, and [contesting a charge](../../fern/docs/pages/contesting.mdx) sets out the reasons and the statement.

## Moderato

Every Avow deployment so far runs on Moderato, Tempo's testnet. `moderatoClient` gives a client for it that pays fees in AlphaUSD, `MODERATO_FEE_TOKEN`, through `MODERATO_RPC_URL` unless you pass another RPC, and `createAgent`, `sendOwn` and the verifier's `tempoChainReader` all take it. `moderatoUsdToken` describes a USD token on Moderato as the `RailToken` the agent and the verifier take, with the 6 decimals every USD token on Tempo has. Both quickstarts use these.

## The sandbox

On testnet the sandbox keeps a business and its agent apart. `sandbox.business` is the business's side, and only the runner calls it. It holds the business's root key sealed under a passphrase, with PBKDF2 and AES-256-GCM through the platform's Web Crypto, and opens it only to sign. The first time, it registers the business with Avow's sandbox, waits for its test dollars and creates its lock. When the authority or the suppliers differ from the agent's mandate, it asks a yes or no question and then for the passphrase. It takes whether the business is set up, and which mandate the agent holds, from the chain, since anything running as the developer can write the `.avow` folder, and it sets a business up again only after a yes to a question that says what that replaces. A transaction of its own from the root key revokes every other key the account's keychain still authorizes, access or admin, which it reads from the chain from the block the factory created the lock in, so no file the agent can write keeps a key live. Then a new agent key goes on the account, since the account binds each key to one mandate's hash, and each supplier the lock approves that the new mandate drops comes off in its own transaction. Bookings made under the old authority stay held until their release. It reads the deployment's settings from `https://try.testnet.avow.finance/config.json`, and refuses a factory other than `MODERATO_FACTORY`, the one the SDK trusts.

`sandbox.agent` is the agent's side, and `@avow-finance/sdk/agent` exports it with `Refusal` and nothing else. It reads only the agent's key and mandate, and it has no call that opens the business's key, signs a mandate, enrolls a key or changes the authority.

```ts
import { Refusal, sandbox } from '@avow-finance/sdk/agent'

const agent = await sandbox.agent()
try {
  const commitment = await agent.book({
    supplier: 'avow-demo-gpu',
    resource: { gpu: 'H100', count: 8, hours: 1 },
    reserve: 200,
  })
  console.log(commitment.reference, commitment.link)
  console.log(await commitment.verify(), await commitment.accepted())
} catch (error) {
  if (error instanceof Refusal) console.log(error.layer, error.code, error.message)
}
```

`book` returns the commitment once the reserve is funded, with its `CommitmentReference` and a link to the screen's `#verify=` page, which carries the reference and nothing private. It throws a `Refusal` when the booking is refused before any money moves, naming the reason code, the layer that refused it and the amounts. `sdk` is the SDK's own mandate check, `avow` is Avow's reserve check, which counts what the lock already holds under the mandate, `relay` is Avow's relay refusing to pay the fee, `lock` is an on-chain revert, and `keychain` is the account's keychain holding the agent's key to its daily limit. Its message is `refusalSentence` from the spec, such as "This booking needs $400 and your agent has $300 of authority left, so Avow refused the reserve and no money moved. The lock takes no reserve without Avow's approval, and your agent's key can't move more than $500 a day, a limit your business set on chain." `verify` runs the open verifier on the agent's machine, every check the buyer's side can make. It checks Avow's approval against the commitment, the supplier, the lock's token, the terms and the mandate's caps and hash, then that a lock the trusted factory made holds the commitment under the terms hash, enforces what the terms map to and holds the approval checked, and that the agent's key is on the account bound to the mandate. `accepted` waits for the supplier's acceptance on the lock, and `commitments` lists every commitment the business's agents made, with its state and whether the current mandate made it.

An agent that skips every check in its own code meets the same refusal from Avow and the same daily limit on its key, as long as it never holds the business's root key. In Node the sandbox keeps its items in the working directory's `.avow` folder, which ignores itself in git, and Node loads the SDK through its `node` export, which sets that store. A browser loads the same SDK without it and passes its own `store`. The setup's steps are exported on their own, so the playground and the starter share one copy. `createSandboxBusiness` funds the fees, creates the lock, registers the business and waits for its test dollars, and `authorizeSandboxKey` and `enrollSandboxAgent` sign the mandate, change keys on the account and enroll the agent.

`avow-sandbox` is the runner behind the starter's `npm start`. It reads `business.ts` in a process of its own, prepares the business, opens the screen, and runs `agent.ts` at each press of Enter in a session of its own with no controlling terminal and pipes for its output, with every `AVOW_` variable taken out of its environment and only the session put back. It ends each child's whole process group when it exits, refuses to ask for the passphrase while a process in that group is alive, and keeps no prompt history. Before each passphrase it also refuses when it finds another process holding the terminal open, looking through `/proc` on Linux and `lsof` elsewhere, and it says so when it can't look. A process that leaves the group, or whose open files the runner can't read, escapes both checks. The agent gets no key, environment variable or signing function from the runner, but a program running as you can read what you type, so in production the business key stays off the agent's machine. The agent's key signs a run's events, and the root key signs an authority change. It keeps the session in `.avow` across restarts while Avow's relay holds it for the business and takes its events, and moves to a new one shortly before the relay closes it, a day after its first event. Whenever a session is new, `prepareSandboxBusiness` with `announce` has the root key sign the agent's current authority into it, which takes the passphrase once, and it posts every mandate it signs too. After each run it shows what the agent's key can still move today, and `avow-sandbox fresh` moves a worn business aside for a fresh one.

### The MCP agent

`avow-sandbox-mcp` gives a model in Claude Code, Claude Desktop or any other MCP client the sandbox's agent, over stdio. It runs as the agent, through the same calls `@avow-finance/sdk/agent` makes, and it never opens the business's key, so a model gets exactly the agent's authority. It has three tools. `authority` gives the two limits, what the agent can hold at once and what its key can move today, with what's left of each. `book` books with a reserve and returns the commitment, the verifier's checks and the supplier's acceptance, or the refusal's reason code, layer, sentence and when the same booking could pass. Held reserves come back as bookings end or are cancelled, the key's daily limit starts again each day, the relay can be limiting how much it takes for now, and anything else in the mandate changes only with a new one. `commitments` lists every commitment with its state and a link to check it. Each call posts its events to the session the runner opened, marked with source `mcp`, so the screen shows which ones a model made. `avow-sandbox-mcp add claude-code` and `avow-sandbox-mcp add claude-desktop` add it to Claude against the agent in the current folder. With `AVOW_LIVE_TEMPO=1`, a test drives it through the official MCP client on Moderato, where a $200 booking is reserved and accepted and a $400 booking is refused by Avow with $300 left.

A business names two limits. The authority is what the agent can hold in bookings at once, which Avow refuses past and the lock checks against Avow's approval. The daily limit is what the agent's key can move in a day, which the business sets on chain and the account's keychain holds whatever Avow approves, $1,000 when left out. Reserves cancelled during free cancellation still count against the day.

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
