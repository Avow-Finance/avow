# Starter

One command makes a folder holding `agent.ts` and a README, and `npm start` in that folder gives its agent $500 of authority on Tempo's Moderato testnet. Developers leave with a small example they can edit and lift into their own agent. [template](template) holds what the folder starts with.

```sh
npx https://try.testnet.avow.finance/create-avow-agent.tgz my-agent
cd my-agent
npm start
```

You need Node 20 or later.

## How it fits together

- `create-avow-agent` copies the template into a new folder and runs `npm install` there.
- The folder depends on `@avow-finance/sdk` and `tsx`. Until the SDK is on npm, the SDK comes from a tarball on the same host, and `agent.ts` imports it exactly as it will after the release.
- `npm start` runs the SDK's `avow-sandbox` command. It runs `agent.ts` once to set up, which ends as soon as the agent's mandate is enrolled, then opens the screen for a new session and runs `agent.ts` again at each press of Enter.
- `sandbox.agent` does the setup. In Node it keeps the business's keys in `.avow` in the working folder, makes the root key there, registers a sandbox business with Avow's API, waits for its test dollars, creates the lock, and signs and enrolls the mandate. When the authority in `agent.ts` changes, the next run signs a new mandate for a new agent key and enrolls it.
- Each run reports to the session through Avow's API, signed by the business's root key. The screen at `https://try.testnet.avow.finance/#session=<id>` shows a run starting, the authority changing, each refusal with its reason code, layer and amounts, each commitment, and each acceptance.

## Build the tarballs

```sh
pnpm install
pnpm build
pnpm --filter @avow-examples/starter host
```

This writes `host/create-avow-agent.tgz` and `host/avow-finance-sdk.tgz`. Serve both from the root of https://try.testnet.avow.finance with `Cache-Control: no-cache`, since each new build replaces the files at the same URLs. The SDK tarball carries the spec and the verifier inside it, so npm fetches nothing else from the host. Every package inside stays private, so neither tarball can be published to npm. To try a build before it's served, pass `--host http://localhost:8080`, serve `host/` there, and run `npx` against that origin.

## Test

```sh
pnpm --filter @avow-examples/starter test
AVOW_LIVE_TEMPO=1 pnpm --filter @avow-examples/starter test
```

The second line also runs the whole loop on Moderato from keys made for the run. A $200 booking passes, a $400 booking is refused by Avow with $300 of authority left, and a $250 booking passes as a second commitment. Raising the authority then enrolls a new mandate. Avow's sandbox pays the run's business its test dollars, so it needs no secrets.
