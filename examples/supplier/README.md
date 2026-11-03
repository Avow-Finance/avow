# Supplier quickstart

A minimal supplier adapter for Avow on Moderato. Agents book with it over HTTP, it accepts each reserve Avow authorizes once its own checks pass, and it reports a charge on a booking cancelled late or never used. Run it on your own machine, apart from Avow.

## What it does

- `GET /profile` gives agents the supplier's business id, account, payout address and signing key.
- `POST /agreements` signs an agent's terms agreement. It signs GPU reservation terms that meet Avow's testnet profile, reserve no more than its limit and leave it at least a minute to accept. It records the booking before it answers, and it answers the same offer again with the same signature.
- Both routes and their bodies are the ones `@avow-finance/spec` fixes for every supplier adapter, so an agent that talks to this adapter talks to yours.
- `GET /policy` publishes what it accepts, as sentences a developer reads and as the numbers an agent checks an offer against. It's built from the same rules `POST /agreements` enforces, so the two never drift apart.
- It holds at most 5 open bookings for one buyer's lock and 200 in all, so one buyer can't take every slot and the poll stays short however many agents book. An offer past either limit gets a 429 and can come again once a booking is accepted or lapses. An offer it already signed still gets its signature.
- `GET /health` answers while the process runs, for a load balancer or a container platform.
- Every few seconds it asks Avow to authorize each booking it signed, with a request its signing key signs. Once the agent has funded the reserve, Avow answers with its authorization, its approval and the buyer's mandate.
- The verifier checks all three against the supplier's own terms and the lock before the supplier holds capacity, then builds the acceptance. The supplier signs it and sends it to the lock, paying the fee from its signing key.
- It grants the capacity only once the acceptance's receipt shows the lock took it, as the verifier's README asks. Until then the reserve can still go back to the business, so a booking stays `held` and nothing is granted.
- A booking whose reserve never arrives lapses at its acceptance deadline, and Avow returns any reserve then.

Each acceptance transaction's hash is recorded before its bytes go to the chain. After a restart the adapter reads the lock, so a booking is accepted once whatever happened in between. The adapter reads an accepted or lapsed booking once, then leaves it alone. It logs a booking file it can't read once, and reads that file again once it changes.

## Reporting a charge

- `report` reports a late cancellation, or a no-show with `--no-show`, on the accepted booking whose commitment id you pass, or on the latest accepted one.
- It writes a short note to the store saying which booking and kind it reports and when, and the report names the note's keccak256 as its evidence. Keep the note, since a ruling may ask for it.
- The verifier builds the report from the lock, for the most the terms let that kind take, and refuses one the lock wouldn't take with a reason code, such as `report.too_early` before a late cancellation can be charged.
- The signing key signs the report once its disclosure is shown and sends it to the lock, paying the fee as it does for acceptances. The store records the transaction's hash before its bytes go out, along with the report's number on the commitment. `report` run again follows the report it filed whatever became of it, a withdrawal included, by comparing that number with the lock's report count. It files another only once the last can no longer land and the lock never counted it.
- Then it follows the lock and says what Avow did. Avow confirms a late-cancellation report only when it recorded the business's cancellation from the free-cancellation deadline on and before the no-show charge could be reported. A confirmed charge pays at most the late-cancellation amount once the contest window closes, unless the business contests it first, and the rest of the reserve goes back to the business. Avow refers any other report to a ruling.

## Settings

| Setting | What it is |
| --- | --- |
| `AVOW_API_URL` | Avow's API, such as `https://api.testnet.avow.finance` |
| `AVOW_FACTORY` | Avow's lock factory on Moderato |
| `AVOW_TOKEN` | The token reserves are held in |
| `AVOW_APPROVAL_KEYS` | The address Avow signs authorizations with. Separate several with commas |
| `SUPPLIER_BUSINESS_ID` | The business id Avow registered you under |
| `PORT` | Where agents reach you, 8790 by default |
| `MAX_RESERVE_DOLLARS` | The largest reserve you take for one booking, 1000 by default |
| `POLL_SECONDS` | How often it asks Avow about open bookings, 5 by default |
| `MAX_OPEN_PER_BUYER` | The most open bookings it holds for one buyer's lock, 5 by default |
| `MAX_OPEN_BOOKINGS` | The most open bookings it holds in all, 200 by default |
| `STATE_DIR` | Where the keys and bookings live, `.avow-supplier` by default |
| `RPC_URL` | Moderato's RPC, `https://rpc.moderato.tempo.xyz` by default |

`serve` needs every setting above. `report` needs only `AVOW_FACTORY` and `AVOW_TOKEN`, with `STATE_DIR` and `RPC_URL` when you set them for `serve`.

A booking is open from the moment the supplier signs its agreement until the lock holds the acceptance or the booking lapses.

## Running it

```sh
cd examples/supplier
node dist/main.js init
```

`init` makes your account key and signing key, has Moderato's faucet fund the signing key's fees, and prints three addresses. Send them to Avow, which registers you and gives you the settings above. Then:

```sh
node dist/main.js serve
```

Agents need your URL, so run it where they can reach it. `node dist/main.js profile` prints your addresses again.

Once the buyer has cancelled after free cancellation ended, report the late cancellation, from another terminal while `serve` keeps running. A no-show can be reported once the booked window's grace period has passed.

```sh
node dist/main.js report
node dist/main.js report 0x<commitment id> --no-show
```

## Hosting it

Run `init` on your own machine, then give the host only what `serve` needs. `serve` signs with the signing key alone and never with the account key, so the account key stays on your machine with `keys.json`. Back that file up, since the account is where charges are paid.

| Setting | What it is |
| --- | --- |
| `SUPPLIER_SIGNING_KEY` | The `signingKey` from `keys.json`, passed from your host's secret store |
| `SUPPLIER_ACCOUNT` | The `account` address `init` printed |

Set both and `serve`, `report` and `profile` take the keys from the environment. Set neither and they read `keys.json`. One without the other stops the command with the name of the setting that's missing.

Put `STATE_DIR` on a disk that outlives the process, such as a network volume, since the bookings and reports live there and a restart picks up from them. Run one `serve` process at a time, because the store counts open bookings from what its own process saves. A host that rolls out a new version should stop the old process before it starts the new one.
