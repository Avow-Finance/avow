# Your Avow agent

This folder gives an AI agent $500 of authority to commit a business, and shows you what it can and can't commit you to. You can drive it from `agent.ts`, or from Claude. It runs on Tempo's Moderato testnet with test dollars, so nothing here moves real money.

## Run it

```sh
npm start
```

The first time, `npm start` sets up your business on your machine. You choose a passphrase, and your business's key is sealed under it in `.avow`, a folder git ignores. The business registers with Avow's sandbox, waits for its $1,500 of test dollars and creates its lock. Then `npm start` shows you the mandate it's about to sign for your agent, asks you to confirm it and type the passphrase, and signs. It opens a screen that shows each run as it happens, and waits for you. The screen stays the same when you restart `npm start`. A day later, or for a fresh business, it opens a new one and asks for your passphrase once, so your business's key can sign your agent's authority there.

Each time you press Enter, it runs `agent.ts` once. Afterwards it shows what your agent's key can still move today, of its $1,000 a day.

## Two files, two sides

`business.ts` is your business. It names two limits and the suppliers your agent can book with. Only `npm start` reads it, and it asks you before it signs anything new from it.

- **$500 held at once** is the most your agent can hold in bookings at the same time. Avow refuses a booking past it, and the lock checks each reserve against Avow's approval.
- **$1,000 a day moved by the key** is the most your agent's key can move in a day. Your business sets it on chain, and your account's keychain holds the key to it whatever Avow approves.

`agent.ts` is your agent. It names the booking, the supplier and the terms, and it runs in a process of its own that holds only the agent's key, and `npm start` hands it no key, environment variable or signing function of your business's. It imports `@avow-finance/sdk/agent`, which has no way to open the business's key, sign a mandate or change the authority.

## What to try

1. Press Enter. The agent books 8 H100s for an hour with a $200 reserve. It prints the commitment's reference and a link anyone can open to check it. Your machine then runs the open verifier. It checks Avow's approval against your terms and your mandate, checks that a lock Avow's factory made holds the commitment and enforces your terms, and checks that your agent's key is on your account under your mandate. Then the supplier accepts.
2. Change `reserve` in `agent.ts` to 400 and press Enter. Your agent has $300 left of its $500 held at once, so Avow refuses the reserve and no money moves. You see the reason code, the layer that refused it, the amounts and when the same booking could pass. The SDK checks nothing past the mandate, so the refusal comes from Avow.
3. Change `reserve` to 250 and press Enter. It fits, so the agent makes a second commitment under the same authority.
4. Change `authority` in `business.ts` and press Enter. `npm start` asks you to confirm the new mandate and type the passphrase. It revokes every other key on your account, read from the chain, so no old key can sign for you again, and enrolls a new one. Bookings made under the old authority stay held in the lock until their release, and it lists them.

Each reserve sits in your business's own lock, for one named supplier, until the booking's window ends. Then it goes back to the business.

## Drive it from Claude

Your agent can take its bookings from Claude too, with three tools. `authority` says what it can commit right now, `book` books, and `commitments` lists what it made with a link to check each. The tools run as your agent with only its key, through the same SDK calls `agent.ts` makes, and each call shows on the screen marked as Claude's.

Run `npm start` once first, so your business has an agent. Then add the tools with one line.

```sh
npm run mcp:claude-code      # then run claude in this folder
npm run mcp:claude-desktop   # then restart Claude Desktop
```

With nothing else held, ask Claude to book $200 of GPU compute, and it's reserved and accepted. Ask it to book another $400, and Avow refuses it with $300 left of your $500 held at once. Claude gets the same reason code, layer and sentence you'd see, and the sentence says when the same booking could pass, here once a held booking ends or is cancelled, or once your business raises the authority.

## What holds

An agent that skips every check in its own code meets the same refusal from Avow, and the same daily limit on its key, as long as it never holds your business's key. The lock takes no reserve without Avow's approval, and your account's keychain holds the agent's key to the daily limit your business set on chain. Here only `npm start` uses your business's key, sealed under your passphrase. Your agent gets no key, environment variable or signing function from it, but a program running as you can read what you type. Before each passphrase `npm start` refuses when it finds another program holding your terminal open, and it can't find every such program, so in production the business key stays off the agent's machine.

## A fresh business

Your agent's key can move $1,000 a day, and reserves you cancel still count against it. When it runs low, `npm start` says so.

```sh
npm run fresh
```

That moves your business aside, keys and all, to a folder named `.avow-` and the time, and sets up a fresh one with a full day.

## Without the screen

`npx tsx agent.ts` runs your agent once without the screen, once `npm start` has set up your business.
