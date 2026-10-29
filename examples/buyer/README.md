# Buyer quickstart

A business and its agent on Moderato, from an empty account to a reserve the supplier accepts, through Avow's hosted API. Run it on your own machine, apart from Avow.

## What it does

- `init` makes the business's root key and the agent's key, has Moderato's faucet fund the account's fees, and creates the business's lock from Avow's factory.
- `enroll` signs the agent's mandate with the root key, which stands in for the administrator's passkey. The mandate lets the agent reserve with one supplier, for compute, up to the reserve you set per booking, for a week. One transaction from the root key puts the agent's key on the account with the mandate's hash and approves the supplier on the lock. Then the agent enrolls with Avow.
- `book` has the agent book 8 H100s with the supplier. The SDK agrees the terms with the supplier, asks Avow to approve the reserve, checks Avow's approval against the terms and the mandate, and funds the reserve from the account while Avow's relay pays the fee. It then follows the lock until the supplier accepts. With `--until-released` it waits on until Avow returns the reserve at its release date.

## Settings

| Setting | Needed by | What it is |
| --- | --- | --- |
| `AVOW_FACTORY` | init | Avow's lock factory on Moderato |
| `AVOW_API_URL` | enroll, book | Avow's API, such as `https://api.testnet.avow.finance` |
| `BUYER_BUSINESS_ID` | enroll | The business id Avow registered you under |
| `AGENT_ID` | enroll | Your agent's id, `agt_quickstart` by default |
| `SUPPLIER_URL` | enroll, book | Where the supplier's adapter takes agents |
| `AVOW_TOKEN` | enroll, book | The token reserves are held in |
| `RESERVE_DOLLARS` | enroll, book | The reserve per booking, 500 by default |
| `OPEN_BOOKINGS` | enroll | How many bookings the agent may hold at once, 3 by default |
| `AVOW_ARBITER` | book | The arbiter Avow's approvals name |
| `AVOW_DAY90_SHARE_BPS` | book | The share of a disputed charge the supplier gets at day 90, 5000 by default |
| `WINDOW_STARTS_IN` | book | Seconds until the booked window opens, 720 by default |
| `WINDOW_MINUTES` | book | How long the window lasts, 30 by default |
| `STATE_DIR` | all | Where the keys and records live, `.avow-buyer` by default |
| `RPC_URL` | all | Moderato's RPC, `https://rpc.moderato.tempo.xyz` by default |

The reserve is released at the window's end, so the default booking takes about 45 minutes to come back. A window of one minute starting in 180 seconds runs the whole booking in about five.

## Running it

```sh
cd examples/buyer
node dist/main.js init
```

Send Avow the account and lock that `init` prints, with your business's name and country. Avow registers the business and sends the account test tUSD. Then:

```sh
node dist/main.js enroll
node dist/main.js book --until-released
```

`node dist/main.js account` prints the account, the lock and the agent's key again.
