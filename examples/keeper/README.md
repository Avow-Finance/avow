# Keeper

Sends every step that has come due on an Avow factory's locks on Moderato, so those steps land on time whether or not Avow is up.

A lock enforces its own deadlines. When a supplier lets the time to accept run out, a kept reserve reaches its release date, a confirmed charge's contest window closes, or a contested charge nobody ruled on reaches day 90, anyone may call the lock's `trigger` for that side of the commitment, and the lock sends the money where its record says. Avow's settlement service normally makes those calls. The keeper makes them too, from anywhere, with no Avow credentials.

## What a run does

1. Reads the factory's `LockCreated` events from the block the factory was created in, to find every lock.
2. Reads each lock's `Reserved`, `Released`, `Charged` and `Resolved` events over the last 14 days of blocks, and keeps each side that was reserved and hasn't ended.
3. Simulates `trigger` for each of those sides with `eth_call`. The lock reverts when nothing is due.
4. For each simulation that succeeds, has Moderato's faucet fund a key made for the run, signs `trigger` locally and sends it. It follows each transaction by its hash, since Moderato's public RPC can answer with an error after a transaction has landed, and it signs again only once the chain shows the last transaction can no longer land.
5. Prints a line for each step it sent, with its link on the explorer, and a summary of what it checked.

A run exits with status 1 when a step failed, a transaction's outcome is unknown or a side couldn't be checked, so a scheduled run that needs a look shows red.

## Why anyone can run it

`trigger` takes a commitment and a side and nothing else. It needs no signature and no particular caller, it does nothing until a deadline has passed, and it pays only the parties the lock recorded. Whoever calls it decides only how soon after its deadline a step lands, never what the step does. So the keeper holds nothing worth stealing. Its key exists for one run, in memory, and holds only what the testnet faucet sent it. If you'd rather not depend on Avow's uptime, run your own.

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
| `LOOKBACK_DAYS` | How many days back it looks for commitments, 14 by default |
| `RPC_URL` | Moderato's RPC, `https://rpc.moderato.tempo.xyz` by default |

The demo factory above was created in block 41503611, the first block at which `eth_getCode` returns its code.

Each line a run prints starts with the time, left out here. The keeper's first run on the demo factory sent two overdue day-90 defaults:

```text
sent the step due for 0xf83f4bef595fed73ad1c7998d48512dc1060784a6c13da0a7cbefba37404128b (buyer) on lock 0x101878B1adBfC7029Cb41FFc19D00Fb6b79151B4: https://explore.testnet.tempo.xyz/tx/0xec484d1b4a56cfc6832bb513f71317ad263c75d577ed6269733087eeaef1f162
sent the step due for 0x3481f517a3b5abfda25d35889178ca3668d07c9af31c096df5ab521969b821df (buyer) on lock 0xC43138A5Ce266d730AaDc1944c0b247d27c599f5: https://explore.testnet.tempo.xyz/tx/0x3fe912776365d00e6d148921b30ee586d98479f5f42131001bb10b918bf9a00e
checked 3 locks created in blocks 41503611 to 41754215 and 7 sides reserved in blocks 41503611 to 41754215: 2 open, 2 due, 2 sent, 0 taken by another sender, 0 failed, 0 unknown, 0 unchecked
```

## On a schedule

[keeper.yml](../../.github/workflows/keeper.yml) runs the keeper against the demo factory every 10 minutes and on demand, with the factory and its start block as the workflow's settings and no secrets. Two keepers can run at once. The lock takes each step once, and the keeper that comes second reports the step as taken by another sender.

## Limits

- It checks only sides reserved within the lookback. The demo factory times disputes in minutes and its bookings run in one sitting, so 14 days leaves a wide margin there. A side whose last deadline comes longer than that after its reserve, such as a booking weeks ahead or a dispute with a real 90-day default, needs a longer `LOOKBACK_DAYS`.
- Moderato's public RPC refuses a log query whose last block is more than 100,000 past its first, so the keeper reads logs 100,000 blocks at a time, naming at most 500 locks in a query. The RPC also refuses a query that would return more than 20,000 logs, and a run that meets that limit fails with the node's message.
- The search for locks reads every block since the start block. Moderato makes a block about every 0.6 seconds, so each month adds about 43 log queries to a run.
- GitHub can start a scheduled run late, so a step can land some minutes after its deadline, and it turns off a public repository's scheduled workflows after 60 days without activity. Anyone who needs steps to land on time runs a keeper of their own as well.

## Tests

`pnpm check` runs the unit tests, which drive the keeper against a scripted chain and its Tempo calls against a scripted node. `AVOW_LIVE_TEMPO=1` adds a live test against the workflow's factory on Moderato. It checks the start block, every lock and every open side against the chain, then runs the keeper, which sends whatever is due.
