# Supplier quickstart

A minimal supplier adapter for Avow on Moderato. Agents book with it over HTTP, and it accepts each reserve Avow authorizes once its own checks pass. Run it on your own machine, apart from Avow.

## What it does

- `GET /profile` gives agents the supplier's business id, account, payout address and signing key.
- `POST /agreements` signs an agent's terms agreement. It signs GPU reservation terms that meet Avow's testnet profile, reserve no more than its limit and leave it at least a minute to accept. It records the booking before it answers, and it answers the same offer again with the same signature.
- Every few seconds it asks Avow to authorize each booking it signed, with a request its signing key signs. Once the agent has funded the reserve, Avow answers with its authorization, its approval and the buyer's mandate.
- The verifier checks all three against the supplier's own terms and the lock before the supplier holds capacity, then builds the acceptance. The supplier signs it and sends it to the lock, paying the fee from its signing key.
- A booking whose reserve never arrives lapses at its acceptance deadline, and Avow returns any reserve then.

Each acceptance transaction's hash is recorded before its bytes go to the chain. After a restart the adapter reads the lock, so a booking is accepted once whatever happened in between.

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
| `STATE_DIR` | Where the keys and bookings live, `.avow-supplier` by default |
| `RPC_URL` | Moderato's RPC, `https://rpc.moderato.tempo.xyz` by default |

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
