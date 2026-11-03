# Buyer quickstart

A business and its agent on Moderato, from an empty account to a reserve the supplier accepts, and on to cancelling the booking or contesting a charge, through Avow's hosted API. Run it on your own machine, apart from Avow.

## What it does

- `init` makes the business's root key and the agent's key, has Moderato's faucet fund the account's fees, and creates the business's lock from Avow's factory. Once `enroll` has saved a mandate for that lock, `init` keeps it and refuses an `AVOW_FACTORY` that gives another. To start over with another lock, use a new `STATE_DIR`.
- `enroll` signs the agent's mandate with the root key, which stands in for the administrator's passkey. The mandate lets the agent reserve with one supplier, for compute, up to the reserve you set per booking, for a week, and cancel or start its bookings through Avow. One transaction from the root key puts the agent's key on the account with the mandate's hash and approves the supplier on the lock. Then the agent enrolls with Avow.
- `book` has the agent book 8 H100s with the supplier. It builds the booking's terms with the GPU reservation template, then the SDK agrees them with the supplier, asks Avow to approve the reserve, checks Avow's approval against the terms and the mandate, and funds the reserve from the account while Avow's relay pays the fee. It then follows the lock until the supplier accepts. With `--until-released` it waits on until Avow returns the reserve at its release date.
- `contest` contests the charge the supplier reported on a booking, the one whose commitment id you pass or the latest in the store, with a reason and a statement. The root key contests on the lock, which pauses the charge until someone rules, and gives Avow the statement. It saves the contest in the store, as the section on contesting below sets out.
- `cancel` cancels a booking, the one whose commitment id you pass or the latest in the store, by one of the two paths below. It reads the lock first and saves the cancellation in the store. A booking the store already shows cancelled isn't sent again. A run that stops after Avow recorded the cancellation but before saving it loses nothing, since the next `cancel` asks again and Avow answers with the first cancellation's time, which the SDK checks before the store saves it.

## Cancelling

The lock and the chain's clock decide which path a cancellation takes.

1. **While free cancellation is open on the chain**, the root key cancels on the lock itself, which gives the whole reserve back, and no charge can follow. That needs no mandate, so it works for any booking the lock still holds. The store keeps the transaction's hash from just before it goes out, so the next `cancel` settles a run that was cut short from the transaction's receipt.
2. **Once free cancellation has ended**, the agent asks Avow to record the cancellation, which Avow does with its own timestamp, and `cancel` prints that time. The supplier can then report a late-cancellation charge. Avow records a cancellation only from the free-cancellation deadline until the supplier can report the no-show charge, confirms a report only for a cancellation it recorded in that window, and refers any other report to a ruling. A confirmed charge pays the supplier at most the late-cancellation amount once the contest window closes, and the rest of the reserve goes back to the business.

A commitment the lock has already given back, charged or settled is never sent to Avow. Once the supplier can report the no-show charge, cancelling no longer changes what the business pays, so Avow refuses with `commitment.cancel_closed` and `cancel` says so. Once the charge deadline has passed, Avow refuses with `commitment.ended`, and `cancel` says the booking can no longer be cancelled.

The late path needs a mandate that permits `cancel`. A business enrolled before `cancel` existed holds one that permits only reserves. Its bookings still cancel on the lock while free cancellation is open, from the `STATE_DIR` that holds them. Running `enroll` again keeps the mandate the store holds, so a mandate that permits `cancel` and `start` takes a new account. Run `init` with a new `STATE_DIR`, send Avow the new account and lock to be registered as you did the first time, and run `enroll` once Avow has registered them.

## Contesting

A charge the business disagrees with is contested from its own root key, and the lock pauses the charge until someone rules on it.

```sh
node dist/main.js contest --reason job_started --statement "Our agent sent the start request at 14:02, and the supplier receipted it at 14:03."
node dist/main.js contest 0x<commitment id> --reason never_cancelled --statement "We never cancelled this booking."
```

The reason is one of six, and it has to answer the kind of charge the supplier reported.

| Reason | Answers | Means |
| --- | --- | --- |
| `never_cancelled` | A late cancellation | The business never cancelled |
| `cancelled_in_time` | A late cancellation | The business cancelled before free cancellation ended |
| `job_started` | A no-show | The business showed up and the job started |
| `supplier_did_not_provide` | A no-show | The supplier didn't provide what the terms promise |
| `wrong_charge` | Either | The charge is the wrong kind or the wrong amount |
| `other` | Either | Another reason, which the statement sets out |

The statement is the business's account in its own words, at most 4,000 bytes. Its hash goes to the lock with the contest, so it can't change afterwards, and the lock takes one contest per commitment. Write it as the record a ruling will rest on.

`contest` reads the lock first. The lock takes a contest of a charge Avow confirmed until its contest window closes, ten minutes after the confirmation with the quickstart's terms, and of a report Avow hasn't answered at any time. `contest` refuses, sending nothing, a booking the lock holds no charge or report for, one already contested, a window that's closed or closes within the 25 seconds a send can take, and a reason that doesn't answer the charge, and says which. The root key sends the contest and pays its own fee, so no agent, mandate or relay takes part. Then it gives Avow the statement, signed by the root key.

It prints what it contested, when the lock paused the charge, and when Avow must rule by, which is 30 minutes after the pause on testnet. After that the arbiter can rule until 90 minutes after the pause, and a charge nobody rules on resolves then, paying the supplier the day-90 share of a charge Avow confirmed and nothing of one it didn't.

A run that stops loses nothing. The store keeps the contest's transaction from just before it goes out, so the next `contest` settles it from the receipt. When Avow doesn't record the statement, the contest still stands and the charge stays paused. `contest` says so and exits with an error, and the next `contest` gives Avow the same statement, which is safe to repeat. Once the store holds a contest, a later run finishes that one whatever reason and statement it's given.

To rehearse it, contest a charge while the lock takes one. A no-show report takes a contest until Avow answers it, within five minutes of the report on testnet, so contest one with `job_started` or `supplier_did_not_provide` soon after the supplier reports it. A late-cancellation charge Avow confirmed takes one for the ten minutes of its contest window. A report Avow refers to a ruling is paused already, so it goes to a ruling without a contest, and `contest` says so.

## Settings

| Setting | Needed by | What it is |
| --- | --- | --- |
| `AVOW_FACTORY` | init | Avow's lock factory on Moderato |
| `AVOW_API_URL` | enroll, book, cancel, contest | Avow's API, such as `https://api.testnet.avow.finance` |
| `BUYER_BUSINESS_ID` | enroll | The business id Avow registered you under |
| `AGENT_ID` | enroll | Your agent's id, `agt_quickstart` by default |
| `SUPPLIER_URL` | enroll, book | Where the supplier's adapter takes agents |
| `AVOW_TOKEN` | enroll, book, cancel | The token reserves are held in |
| `RESERVE_DOLLARS` | enroll, book | The reserve per booking, 500 by default |
| `OPEN_BOOKINGS` | enroll | How many bookings the agent may hold at once, 3 by default |
| `AVOW_ARBITER` | book | The arbiter Avow's approvals name |
| `AVOW_DAY90_SHARE_BPS` | book | The share of a disputed charge the supplier gets at day 90, 5000 by default |
| `WINDOW_STARTS_IN` | book | Seconds until the booked window opens, 720 by default |
| `WINDOW_MINUTES` | book | How long the window lasts, 30 by default |
| `STATE_DIR` | all | Where the keys and records live, `.avow-buyer` by default |
| `RPC_URL` | all | Moderato's RPC, `https://rpc.moderato.tempo.xyz` by default |

The reserve is released at the window's end, so the default booking takes about 45 minutes to come back. A window of one minute starting in 180 seconds runs the whole booking in about five.

With the default window, free cancellation ends six minutes after `book`, and the supplier can report the no-show charge from 14 minutes after it, two minutes into the window, so a `cancel` in between takes the late path. From then until the charge deadline, 42 minutes after `book`, Avow refuses with `commitment.cancel_closed`.

## Running it

```sh
cd examples/buyer
AVOW_FACTORY=0x8fa7177c84BE069df2a51F096ED28d5D661B8283 node dist/main.js init
```

Send Avow the account and lock that `init` prints, with your business's name and country. Avow registers the business and sends the account test tUSD. Then:

```sh
node dist/main.js enroll
node dist/main.js book --until-released
```

Without `--until-released`, `book` stops once the supplier accepts. To rehearse a late cancellation, book, wait until free cancellation has ended, and cancel the latest booking, or name one by the commitment id `book` printed.

```sh
node dist/main.js book
node dist/main.js cancel
node dist/main.js cancel 0x<commitment id>
```

`node dist/main.js account` prints the account, the lock and the agent's key again.
