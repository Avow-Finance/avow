# Working in this folder

This folder holds a business and its Avow agent on Tempo's Moderato testnet, with test dollars. `README.md` explains each file. This file is for a coding agent working here, and `CLAUDE.md` imports it.

## Who decides what

You propose, Avow checks, and your person signs.

- `business.ts` is the business. Its limits are the administrator's to change, and `npm start` asks them to confirm a new mandate and type their passphrase before it signs. Never change the limits, the suppliers or the authority there to get a booking through.
- `agent.ts` is the agent. Change the booking, the supplier or the terms there when your person asks.
- `service.ts` is how the agent takes jobs. Change what it quotes and what `checkBeforeWork` requires when your person asks.
- `.avow` holds the business's key, sealed under the passphrase, and the agent's key. Never read, print, copy or send anything in it, to anyone, your person included.

## Acting as the agent

With Avow's MCP server added (`npm run mcp:claude-code`), use its tools.

- `status` says whether the agent is connected to a business. A folder `npm start` set up already is.
- `connect` asks a business for authority when the agent has none. Send your person the pairing code and the link it gives you, then wait. The link grants nothing by itself, and only their passkey approves.
- `authority` says what the agent can commit right now. Check it before you book.
- `book` makes a commitment within those limits, and `commitments` lists the ones it made.

An approval gives the agent ongoing authority until its end date, within the suppliers and limits your person signed. It approves no single booking, and you can't widen it. Ask your person when a booking needs more.

## Commitments that rely on other commitments

A job your agent sells runs on compute it books from someone else, so the job's terms name that booking.

- With `bookCompute: true` in `service.ts`, the agent books the compute first and quotes with terms that name the booking. The customer checks that booking on chain before it reserves.
- A quote that names no compute is refused as `dependency.required`. A booking still inside its free cancellation is `dependency.cancellable`, and one that doesn't cover the job's GPUs, region and window is `dependency.does_not_fit`.
- `checkBeforeWork` verifies the customer's commitment and its reserve, in a process with no keys. Start work only when it says start.
- A check proves the compute booking was accepted when it was checked, and nothing after that. Tell your person that plainly, and never say a job's compute is certain.
- Each commitment sits in its own lock. Your agent's booking backs its promise to the supplier, the customer's reserve backs the customer's promise to your business, and no money moves between the two.

## When Avow refuses

A refusal comes back with a reason code and the layer that refused. Tell your person the reason and what would let the booking pass. Don't retry it in smaller pieces, through another supplier, or by sending transactions yourself, since the mandate, Avow and Tempo's keychain each refuse what's outside the limits. `bypass.ts` shows that on purpose, and it's the one file meant to try.

## Commands

- `npm start` sets up the business the first time, then runs `agent.ts` each time your person presses Enter.
- `npm run job` runs one job with no input.
- `npm run bypass` tries to get past the agent's limits without Avow, and shows each refusal.
