# Your Avow agent

This folder gives an AI agent $500 of authority to commit a business, and shows you what it can and can't commit you to. It runs on Tempo's Moderato testnet with test dollars, so nothing here moves real money.

## Run it

```sh
npm start
```

The first time, `npm start` sets everything up on your machine. It makes your business's keys and keeps them in `.avow`, a folder git ignores. It registers a sandbox business with Avow, waits for its $1,500 of test dollars, creates the business's lock, and signs and enrolls your agent's mandate. Then it opens a screen that shows each run as it happens, and waits for you.

Each time you press Enter, it runs `agent.ts` once.

## What to try

1. Press Enter. The agent books 8 H100s for an hour with a $200 reserve. It prints the commitment's reference and a link anyone can open to check it. Your machine then runs the open verifier, the same checks the supplier runs, and the supplier accepts.
2. Change `reserve` to 400 and press Enter. Your agent has $300 of authority left, so Avow refuses the reserve and no money moves. You see the reason code, the layer that refused it and the amounts. The SDK checks nothing past the mandate, so the refusal comes from Avow, the same one an agent that skipped every check of its own would meet. Under Avow, the lock takes no reserve without Avow's approval, and your agent's key can't move more than the daily limit your business set on chain.
3. Change `reserve` to 250 and press Enter. It fits, so the agent makes a second commitment under the same authority.
4. Change `authority` and press Enter. Your business signs a new mandate for a new agent key and enrolls it, and the run says so.

Each reserve sits in your business's own lock, for one named supplier, until the booking's window ends. Then it goes back to the business.

## What's in agent.ts

`agent.ts` is the only file you edit, and it says three things.

- **The supplier** is `avow-demo-gpu`, Avow's demo GPU supplier at https://supplier.testnet.avow.finance.
- **The authority** is the most your agent can hold in bookings at once, $500 by default, with that supplier only.
- **The booking** is 8 H100s for an hour, backed by a $200 reserve.

The booking is a few calls to `@avow-finance/sdk`, which you can lift into your own agent. `sandbox.agent` gives the agent its authority, `agent.book` makes a commitment or throws a `Refusal`, `commitment.verify` runs the open verifier, and `commitment.accepted` waits for the supplier.

## Your keys

Your keys are made on this machine and stay in `.avow`. Nothing prints or logs them, and the folder ignores itself in git. Delete `.avow` to start again with a new business.

## Without the screen

`npx tsx agent.ts` runs the agent once without the screen, and sets up the business first when `.avow` holds none.
