# Keeper

Sends the steps that have come due on an Avow factory's locks on Moderato, for every side reserved within its lookback, so those steps land whether or not Avow is up.

A lock enforces its own deadlines. Once one passes, anyone may call the lock's `trigger` for that side of the commitment, and the lock takes whichever step is due. It returns a reserve the supplier never accepted, releases a kept reserve at its release date, times out a charge report Avow didn't confirm or refer in time, pays a confirmed charge once its contest window closes and applies a posted ruling once its delay has passed. At day 90 it resolves a paused charge nobody ruled on, paying a confirmed charge at the agreed day-90 share and returning an unconfirmed one to the business in full. Avow's settlement service normally makes those calls. The keeper makes them too, from anywhere, with no Avow credentials.

## What a run does

1. Finds every lock from the factory's `LockCreated` events since the block the factory was created in.
2. Reads the locks' `Reserved`, `Released`, `Charged` and `Resolved` events over the lookback, 1,000 locks at a time, and keeps each side that was reserved and hasn't ended. Each run starts at a group picked from the latest block's number, so successive runs start in different places.
3. Simulates `trigger` for each of those sides with `eth_call`. A side counts as having nothing due only when the lock reverts with `NothingDue()`. Any other revert, a rate limit or a node that doesn't answer leaves the side unchecked, and the run reports it.
4. Sends each step that's due as soon as its group of locks is read, before reading the next group. The first step due in a run has Moderato's faucet fund a key made for the run, once. Each `trigger` is signed locally and followed by its hash, since Moderato's public RPC can answer with an error after a transaction has landed. A run signs each step once, and when that transaction lands in no block, the next run sends the step again.
5. Prints a line for each step it sent, with its link on the explorer, a line for each part of the search it didn't read, and a summary naming the locks it read and the oldest reserve it reached.

A run exits with status 1 when a step failed, a transaction's outcome is unknown, a side couldn't be checked or part of the search went unread, so a scheduled run that needs a look shows red.

## Anyone can create locks

The factory creates a lock for any account, at anyone's request, so a keeper meets locks no business uses, and someone can create thousands of them. The keeper is built to keep going when they do. A query the node refuses for holding more than 20,000 logs is split and asked again. A query that fails leaves only its own blocks unread, and the run says which. Each group's due steps go out before the next group is read, and runs start at different groups, so locks behind a pile of empty ones still get reached. A run starts no query or send after `RUN_MINUTES`, and it names the locks it didn't reach.

## Why anyone can run it

`trigger` takes a commitment and a side and nothing else. It needs no signature and no particular caller, it does nothing until a deadline has passed, and it pays only the parties the lock recorded. The lock alone decides what each step does. So the keeper holds nothing worth stealing. Its key exists for one run, in memory, and holds only what the testnet faucet sent it. If you'd rather not depend on Avow's uptime, run your own.

## Running it

You need Node 22.12 or later and pnpm 10. From the repository's root:

```sh
pnpm install
pnpm --filter "@avow-examples/keeper..." build
cd examples/keeper
AVOW_FACTORY=0x9B518c24F9aa9272e20fa78aeDC83b1F00b991a9 AVOW_FACTORY_START_BLOCK=41503611 node dist/main.js
```

| Setting | What it is |
| --- | --- |
| `AVOW_FACTORY` | The lock factory whose locks the keeper serves |
| `AVOW_FACTORY_START_BLOCK` | The block the factory was created in, where the search for its locks starts |
| `LOOKBACK_DAYS` | How many days back it reads reserves, 14 by default. It sends steps only for sides reserved within them |
| `RUN_MINUTES` | How long a run starts queries and sends for, 8 by default |
| `RPC_URL` | Moderato's RPC, `https://rpc.moderato.tempo.xyz` by default |

The demo factory above was created in block 41503611, the first block at which `eth_getCode` returns its code.

Each line a run prints starts with the time, left out here. The keeper's first run on the demo factory sent two overdue day-90 defaults:

```text
sent the step due for 0xf83f4bef595fed73ad1c7998d48512dc1060784a6c13da0a7cbefba37404128b (buyer) on lock 0x101878B1adBfC7029Cb41FFc19D00Fb6b79151B4: https://explore.testnet.tempo.xyz/tx/0xec484d1b4a56cfc6832bb513f71317ad263c75d577ed6269733087eeaef1f162
sent the step due for 0x3481f517a3b5abfda25d35889178ca3668d07c9af31c096df5ab521969b821df (buyer) on lock 0xC43138A5Ce266d730AaDc1944c0b247d27c599f5: https://explore.testnet.tempo.xyz/tx/0x3fe912776365d00e6d148921b30ee586d98479f5f42131001bb10b918bf9a00e
```

Every run ends with a summary. A later run, with nothing left due, ended with this one:

```text
checked 3 of 3 locks created in blocks 41503611 to 41758904, and 7 sides reserved since 2026-10-28T05:19:00.000Z (block 41503611): 0 open, 0 due, 0 sent, 0 taken by another sender, 0 failed, 0 unknown, 0 unchecked, 0 parts unread
```

## On a schedule

[keeper.yml](../../.github/workflows/keeper.yml) runs the keeper against the demo factory every 10 minutes and on demand. The factory, its start block, the lookback and the run's minutes are the workflow's settings, and it holds no secrets. A run stops starting work after 8 minutes, which leaves the rest of the job's 15 for setup and a send in flight. Two keepers can run at once. The lock takes each step once, and the keeper that comes second reports the step as taken by another sender.

## What a run reaches

- Sides reserved within the lookback, and nothing older. A side whose next step comes due more than `LOOKBACK_DAYS` after its reserve, such as a booking 20 days ahead with the default 14, drops out of the window first, and the keeper never sends that step. Each run's summary names the oldest reserve it reached. Set `LOOKBACK_DAYS` longer than the longest gap between a reserve and its last deadline on your factory's locks. Each extra day adds about one and a half queries a run for every 1,000 locks.
- Every lock the factory created, read from its start block. Moderato's public RPC refuses a log query whose last block is more than 100,000 past its first, so the keeper reads logs 100,000 blocks at a time. Moderato makes a block about every 0.6 seconds, so each month adds about 43 queries to finding the locks. When a run's queries outgrow `RUN_MINUTES`, it names what it didn't reach, and later runs start elsewhere.
- Steps on time, up to the schedule. GitHub can start a scheduled run late, so a step can land some minutes after its deadline, and it turns off a public repository's scheduled workflows after 60 days without activity. Anyone who needs steps to land on time runs a keeper of their own as well.

## Tests

`pnpm check` runs the unit tests, which drive the keeper against a scripted chain and its Tempo calls against a scripted node, and check the workflow's settings. `AVOW_LIVE_TEMPO=1` adds a live test against the workflow's factory on Moderato. It checks the start block, every lock and every open side against the chain, then runs the keeper, which sends whatever is due.
