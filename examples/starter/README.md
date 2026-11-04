# Starter

One command makes a folder holding `business.ts`, `agent.ts` and a README, and `npm start` in that folder gives its agent $500 of authority on Tempo's Moderato testnet. Developers leave with a small example they can edit and lift into their own agent. [template](template) holds what the folder starts with.

```sh
npx https://try.testnet.avow.finance/create-avow-agent.tgz my-agent
cd my-agent
npm start
```

You need Node 20 or later.

## How it fits together

- `create-avow-agent` copies the template into a new folder and runs `npm install` there.
- The folder depends on `@avow-finance/sdk` and `tsx`. Until the SDK is on npm, the SDK comes from a tarball on the same host, and the folder imports it exactly as it will after the release.
- `npm start` runs the SDK's `avow-sandbox` command, which is the business. It reads `business.ts` in a process of its own and holds the business's root key, sealed under a passphrase the developer chooses. It registers a sandbox business with Avow's API, waits for its test dollars and creates the lock. Before it signs a mandate it shows it, asks for a yes and asks for the passphrase, and it opens the key only for that signature.
- The runner takes whether the business is set up, and which mandate the agent holds, from the chain, since the agent runs as the developer and can write `.avow`. It sets a business up again only after a yes to a question that says what that replaces.
- When the authority in `business.ts` changes, a transaction of its own from the root key revokes every other key the account's keychain still authorizes, access or admin, read from the chain from the block the factory created the lock in, so nothing the agent writes can keep one live. Then a new agent key goes on the account, and each supplier the new mandate drops comes off the lock in its own transaction. Bookings made under the old authority stay held until their release.
- `agent.ts` runs at each press of Enter in a session of its own with no controlling terminal, its output passed through pipes, with only the agent's key, through `@avow-finance/sdk/agent`. Its environment carries the session and nothing of the business's. Once it exits, its whole process group is ended. The runner won't ask for the passphrase while a process in that group is alive, or while it finds another process holding the terminal open. A process that leaves the group, or whose open files the runner can't read, escapes both checks. The prompts keep no history. The agent gets no key, environment variable or signing function from the runner, but a program running as the developer can read what they type, so in production the business key stays off the agent's machine.
- Each run reports to the session through Avow's API. The agent's key signs a run's events, and the root key signs an authority change. The screen at `https://try.testnet.avow.finance/#session=<id>` shows a run starting, the authority changing, each refusal with its reason code, layer and amounts, each commitment, and each acceptance.
- `business.ts` names two limits. **$500 held at once** is what Avow refuses past and the lock checks against Avow's approval. **$1,000 a day moved by the key** is what the business sets on chain and the account's keychain holds. After each run the runner shows what the key can still move today, and `npm run fresh` moves a worn business aside for a fresh one.
- `npm run mcp:claude-code` and `npm run mcp:claude-desktop` add the SDK's `avow-sandbox-mcp` server to Claude against the folder's agent. It runs as the agent with only the agent's key, offers three tools, `authority`, `book` and `commitments`, and posts each call's events to the runner's session marked `mcp`.

## Build the tarballs

```sh
pnpm install
pnpm build
pnpm --filter @avow-examples/starter host
```

This writes `host/create-avow-agent.tgz` and `host/avow-finance-sdk.tgz`. Serve both from the root of https://try.testnet.avow.finance with `Cache-Control: no-cache`, since each new build replaces the files at the same URLs. The SDK tarball carries the spec and the verifier inside it, so npm fetches nothing else from the host. It packs each module the sources make and nothing else a build left behind. Every package inside stays private, so neither tarball can be published to npm. To try a build before it's served, pass `--host http://localhost:8080`, serve `host/` there, and run `npx` against that origin. npx also takes the create tarball from disk with a `file:` prefix, as in `npx file:$PWD/host/create-avow-agent.tgz my-agent`, and the SDK inside it still comes from the origin you passed. A bare path makes npx run the tarball as a script.

## Test

```sh
pnpm --filter @avow-examples/starter test
AVOW_LIVE_TEMPO=1 pnpm --filter @avow-examples/starter test
```

The second line also runs the whole loop on Moderato from keys made for the run. A $200 booking passes and every verifier check passes, a $400 booking is refused by Avow with $300 left of its $500 held at once, and a $250 booking passes as a second commitment. Lowering the authority then revokes the old key on chain. In a second business, two $400 bookings are each cancelled during free cancellation, which leaves the key $200 of its $1,000 a day, so the account's keychain refuses a third $400 that Avow approved. Avow's sandbox pays each run's business its test dollars, so it needs no secrets.

The same line runs two checks that go around the SDK and Avow. In the first, the agent's key sends `reserve` straight to the lock with an approval Avow never signed, and it lands and reverts with `BadSignature`. Then the key tries to let the lock pull more than its daily limit, and the account's keychain refuses with `SpendingLimitExceeded`. In the second, the authority goes down, the node refuses anything the old key signs because the keychain revoked it, the dropped supplier is off the lock, and the new key's calls to the keychain and the lock's supplier list are refused. Neither needs registration, so both run even when the sandbox has no test dollars to pay.
