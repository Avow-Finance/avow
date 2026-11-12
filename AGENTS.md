# Working in this repo

This repo holds Avow's open packages: the commitment schema, the verifier a supplier runs, the SDK and the MCP server. [CONTRIBUTING.md](CONTRIBUTING.md) applies to every change, from a person or a coding agent. This file is the guide for coding agents, and `CLAUDE.md` imports it, so every agent reads the same rules.

## What Avow is

Avow lets a verified business give its AI agents the authority to make commitments, each backed by money reserved in the business's own lock for one named supplier. A supplier checks a commitment with the open verifier and the chain, without calling Avow, so agents can do business with agents they've never met. Everything here runs on Tempo's Moderato testnet with test dollars.

## Who decides what

The model proposes, Avow checks, and the human signs. Every change keeps that order.

- An agent asks for authority and commits within it. No tool or SDK call an agent can reach approves a request, widens a limit, or revokes another agent.
- The business's administrator approves in the console with a passkey. An approval grants ongoing authority under a mandate until a date, and it approves no single transaction.
- An approval link names a request. It grants nothing to whoever opens it, and the approval binds to the exact agent key and terms the administrator saw.
- Three layers hold an agent to its limits. The mandate check refuses in the SDK and in Avow's API, the lock takes a reserve only with Avow's approval over the terms hash, and Tempo's keychain holds the agent's key to its daily limit and expiry. A revoked key can never be authorized again.
- A mandate holds the suppliers an agent may commit with, the most per commitment, the most reserved at once and when it ends, and the key holds a daily limit. Never present a limit as supported unless one of those layers enforces it.
- The agent's key stays in `.avow` on the machine that made it. Nothing prints it, returns it from a tool or sends it anywhere. The agent's entry points and the MCP server load no module that holds the business's key, and `packages/sdk/src/node/graph.test.ts` pins that.

## How an agent gets authority

1. The agent runs `npx avow-sandbox connect --business <id>`, or calls the MCP server's `connect` tool. Either makes the agent's key, keeps it in `.avow` and asks the business through `connectToBusiness`.
2. The agent gets a pairing code and an approval link, from `approvalLink`, and sends both to its person. The MCP server keeps waiting in the background, and its `status` tool says where the request stands.
3. The administrator opens the link, signs in with the business's passkey, checks the console shows the same code, sets the limits and approves.
4. The agent picks up its authority from Avow. From then on `authority`, `book` and `commitments` act within the mandate, and they refuse before that.

`avow-sandbox mcp add claude-code` adds the server to Claude Code, and `add claude-desktop` to Claude Desktop. The server lives in `packages/sdk/src/node/mcp.ts`.

## Composable commitments

A commitment can rely on another business's commitment. A compute reseller sells 8 H100s to a training agent and books the same capacity from a GPU cloud, so its sale stands on its own purchase.

- **Terms.** A commitment that relies on another uses version 3 terms, which are version 2 terms with a `dependencies` section and a `dependencyCheck` header field. A plain booking keeps version 2, byte for byte. Each entry names the upstream booking by chain, lock, commitment id, side and terms hash.
- **Locks.** Each link is an ordinary bilateral commitment in its own lock. No money moves between locks, and no lock knows about a dependency. Keep dependency logic out of the lock.
- **The check.** `verifyDependencies` in `@avow-finance/verifier` reads the upstream lock and checks provenance, ownership, state, terms and fit, refusing with a `dependency.*` reason code. The buyer runs it before funding, and `prepareAcceptance` runs it before a reseller accepts.
- **What it proves.** A matching upstream booking was accepted when it was checked, and nothing after that. Overselling isn't checked. Docs, comments and demos claim no more than this.
- **Jobs.** The `job/1` template is always version 3, since a job names the compute it runs on. Job terms that name no compute are refused as `dependency.required`, by the customer and by Avow's API with the same code.
- **Sections.** Terms hash in salted sections, so a business can show one section, such as the resource and window, without its prices.

Terms never change after the agreement, and a change is a new commitment that names the one it replaces. Readers refuse a version or a field they don't know. `fern/docs/pages/terms-v3.mdx`, `dependency-check.mdx` and `jobs.mdx` are the reference.

## Layout

| Path | Holds |
| --- | --- |
| `packages/spec` | Records, terms and their templates, signed messages, reason codes and the mandate check |
| `packages/verifier` | The supplier's check of a commitment's authorization, terms and reserve, and the dependency check |
| `packages/sdk` | The agent's and the business's calls, the `avow-sandbox` command and the MCP server |
| `packages/terminal` | What the command line draws |
| `packages/avow-sandbox` | The unscoped name `npx` finds, which runs the SDK's command |
| `examples/starter` | The folder `npx` makes for a new agent, with an `AGENTS.md` of its own for the agent working in it |
| `examples/buyer`, `supplier`, `keeper` | A quickstart for each side |
| `fern/docs/pages` | The developer reference, as MDX |

## Commands

- `pnpm install` installs everything.
- `pnpm check` runs lint, the build, type checks and tests. Packages import each other's built output, so the build runs first. Run it before every commit.
- `pnpm format` fixes formatting.
- `AVOW_LIVE_TEMPO=1 pnpm check` also runs the live tests on Tempo's Moderato testnet. They need no secrets, since they make their keys at run time and fund them from the testnet faucet.

## Rules

- Every change goes through a pull request, with tests for any change in behavior. It needs passing CI and a review before it merges.
- A change that touches settlement or dispute rules, signing, keys, mandates, authority checks, permissions, deployment, or what this repo publishes also needs a maintainer's approval.
- Testnet only. Nothing here moves real money.
- Never commit keys, tokens or `.env` files. Tests make their keys at run time.
- A package stays `"private": true` until it's ready for its first release. Public packages share one version and reach npm only through the Release workflow, which a maintainer runs.
- A change to a signed message, the terms or their canonical form bumps the version of the layer it touches.
- A simulated check or a test business is labelled as one wherever it shows. A dispute being raised is never written up as misconduct.
- Code comments explain themselves and don't point at documents outside this repo.
- Product text uses reserve, commitment, charge, dispute and release, and never bond, coverage, premium, claim or guarantee.
- Reference written for developers goes in `fern/docs/pages/` as MDX and is listed in `fern/docs.yml`, which builds the docs site. Quickstart READMEs stay beside their examples.
- Writing for people (READMEs, docs, release notes) uses no em dashes, no "not X, it's Y" contrasts and no colon reveals, and takes a position.
