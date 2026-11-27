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

1. The agent runs `npx avow-sandbox connect`, or calls the MCP server's `connect` tool. Either makes the agent's key, keeps it in `.avow` and asks through `connectToBusiness`. With a business ID it asks that business, signed under its lock. Without one it asks under the factory, and the administrator's approval binds the request to the business whose root key signed the mandate.
2. The agent gets a pairing code and an approval link, from `approvalLink`, and sends both to its person. The MCP server keeps waiting in the background, and its `status` tool says where the request stands.
3. The administrator opens the link, signs in with the business's passkey, checks the console shows the same code, sets the limits and approves.
4. The agent picks up its authority from Avow. From then on `authority`, `check`, `book` and `commitments` act within the mandate, and they refuse before that. `check` says whether a booking would pass without making it.
5. The administrator can later change the agent's limits by signing a mandate that replaces its current one, for the same key. The agent reads its chain of mandates from Avow when it starts and every half minute after, checks they link back to the mandate its key carries with `mandateChainProblem`, acts under the newest, and counts what the earlier ones still hold against its limit.

`verify` needs no authority. It checks a commitment another agent shared, from its `#verify=` link, against the lock through the factories the SDK trusts, and never asks Avow. `MODERATO_FACTORIES` lists them oldest first, so locks from an earlier factory stay checkable after a new one is deployed. `findCommitment` in `@avow-finance/verifier` does the read, and `avow-sandbox verify <link>` does the same check from a terminal.

An agent sells a service with `publish_offer`, `offers` and `sell`, and buys one with `order`, while `orders` shows either side what waits on it. `sandboxServices` in the SDK does the same from code, and `avow-sandbox offer`, `order --offer` and `listen` from a terminal. A supplier's offers stay in its `.avow`, and its agent quotes only a version it finds there with `publishedOffer`, since the offer in an order is the buyer's copy. `fern/docs/pages/services.mdx` is the reference.

A seller's mandate is the authority an administrator signs for one selling agent, bound to its signing key. It says what the agent may sell, the lowest price, how much it may promise, how far ahead, on what charges and to whom. `packages/spec/src/seller-mandate.ts` holds the message and `sellerMandateProblem`, and `seller-mandate-check.ts` holds `checkSellerMandate`, `sellerOfferProblem` and `saleApprovalProblem`. An agent names its own items, so an item's line of limits may only loosen its category's line for every other item, and a mandate that passes hashes one way only. The spec holds a `seller_mandate` approval request for a selling agent to ask for one, which Avow doesn't take yet and no SDK call builds. Its terms are the mandate's without the fields that say which mandate it is and whose, and `carriesOutSellerRequest` says whether a mandate carries an approval out. An agent names what it sells, so an item's name is plain text and a card shows it in quotes after a label of its own. The spec also holds a `sale` request, for the one sale of a service a mandate hands to a person, which Avow doesn't take yet either. It names the signing key, the buyer, the whole offer version and the units, and no terms hash. It lifts no limit, since `checkSellerMandate` holds the sale to every limit before it reads an approval, and whoever records sales keeps an approval to one sale within a day. No job is approved this way. A `TermsAgreement` can name the seller's mandate a sale was agreed under, which signs at version 2 and leaves an agreement that names none at version 1. Naming one proves no check of it, so never present a named mandate as verified. An administrator replaces a seller's mandate with one whose `replaces` names it, and ends a selling agent's authority for good by signing a `SellerKeyRevocation`, which names the agent's signing key and ends every seller's mandate for it, so a revoked key is to be given none again, and nothing refuses one yet. `sellerMandateChainProblem` in `seller-mandate-chain.ts` is the one way to read a key's mandates: they link, the account signed each, they're for the business, account and key the caller expects, since a seller's mandates have no anchor on a chain, and no revocation came with them. It reads only what it's handed, so it can't see a mandate or a revocation its server left out. Where a deployment turns seller's mandates on, Avow's sandbox stores each one sealed and serves it only to its business and its selling agent, and testnet has them off until then. Nothing stores a revocation yet, and no call an agent can reach signs either. `buyerFacingReason` decides what a buyer hears of a refusal, and a reason reaches a buyer only once it's listed in `BUYER_HEARS`. Nothing enforces a seller's mandate yet, so a selling agent's key is still its only limit, and never present a seller's limit as one a person signed or say Avow enforces seller authority. It is to have two enforcing layers, the seller's agent and Avow, and no lock or keychain behind them, so never say a chain holds a seller to it. `fern/docs/pages/seller-mandate.mdx` is the reference.

A sandbox business starts a check of itself and reads where it stands with `sandboxBusinessChecks` in the SDK, signed by the account's root key, so no tool an agent can reach starts or reads one. On testnet the checker runs in its own sandbox and every check is simulated. A check changes no standing of the business and no limit on its agents, and a pass lists a sandbox supplier's account in the testnet's supplier registry. Neither makes a business verified, so never call one that. `fern/docs/pages/business-check.mdx` is the reference.

A sandbox business gets more test dollars once a day with `sandboxTopUp` in the SDK, the MCP server's `top_up` tool or `avow-sandbox top-up`, signed by the account's root key or by any agent the business approved and hasn't revoked. The faucet sends them to the business's account and never its lock, so a top-up changes no mandate and no limit, and that's why an agent may ask. `fern/docs/pages/top-ups.mdx` is the reference.

When an agent needs authority it doesn't hold, it asks, and Avow stores the ask as an approval request in `packages/spec/src/approval-request.ts`: its kind, the exact terms, a reason code from a fixed list, and the basis Avow read when it arrived. Only the account's root key decides one, by signing an `ApprovalDecision` over the request id, business, agent, terms, basis and expiry, and a request whose basis changed before it applies becomes stale. Approved isn't usable for a change to an agent's authority, and an agent acts on what it asked for only once the request is active. A `sale` request changes nothing, so it's usable while it's approved, once, within a day. No tool or SDK call an agent can reach decides a request. `fern/docs/pages/approval-requests.mdx` is the reference.

A negotiation thread is the signed record of how two agents reach terms, from the buyer's proposal to an agreement or a decline, and a fixed-price order is the shortest one. `packages/spec/src/negotiation.ts` holds its moves and the rules for each, and `threadProblem` there replays a thread read from anyone else before its state is trusted. A decline for a replaced offer is never a reason to order the replacing version unchecked. Nothing carries threads yet, and no offer opens a term to bargaining, so never say agents negotiate on Avow. An agreed thread is no commitment until the supplier's acceptance is on the buyer's lock. `fern/docs/pages/negotiation.mdx` is the reference.

`avow-sandbox mcp add` adds the server to Claude Code, Claude Desktop, Cursor, VS Code or Codex, and `add config` prints the block any other MCP client reads. The server lives in `packages/sdk/src/node/mcp.ts`, and setting it up in each client in `mcp-clients.ts`.

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
| `packages/supplier` | The adapter a supplier runs: agreements, acceptances, reports, the webhook and the local check |
| `packages/terminal` | What the command line draws |
| `packages/avow-sandbox` | The unscoped name `npx` finds, which runs the SDK's command |
| `skills/avow-commitments` | The Agent Skill that tells an agent when a commitment is the right tool, kept in step with the MCP tools by a test |
| `examples/starter` | The folder `npx` makes for a new agent, with an `AGENTS.md` of its own for the agent working in it |
| `examples/buyer`, `keeper` | A quickstart for the buyer and the keeper |
| `fern/docs/pages` | The developer reference, as MDX |

## Commands

- `pnpm install` installs everything.
- `pnpm check` runs lint, the build, type checks and tests. Packages import each other's built output, so the build runs first. Run it before every commit.
- `pnpm format` fixes formatting.
- `AVOW_LIVE_TEMPO=1 pnpm check` also runs the live tests on Tempo's Moderato testnet. They need no secrets, since they make their keys at run time and fund them from the testnet faucet.

## Rules

- Every change goes through a pull request, with tests for any change in behavior. It needs passing CI and a review before it merges.
- A change also needs a maintainer's approval when it touches keys or code that signs with them, the workflows, what this repo publishes to npm, or these rules, and when it turns enforcement of a rule on or loosens a check the SDK or the verifier already enforces. Any other change to settlement or dispute rules, mandates, authority checks or permissions needs an independent review, with every finding fixed, before it merges.
- Testnet only. Nothing here moves real money.
- Never commit keys, tokens or `.env` files. Tests make their keys at run time.
- A package stays `"private": true` until it's ready for its first release. Public packages share one version and reach npm only through the Release workflow, which a maintainer runs.
- A change to a signed message, the terms or their canonical form bumps the version of the layer it touches.
- A simulated check or a test business is labelled as one wherever it shows. A dispute being raised is never written up as misconduct.
- Code comments explain themselves and don't point at documents outside this repo.
- Product text uses reserve, commitment, charge, dispute and release, and never bond, coverage, premium, claim or guarantee.
- Reference written for developers goes in `fern/docs/pages/` as MDX and is listed in `fern/docs.yml`, which builds the docs site. Quickstart READMEs stay beside their examples.
- Writing for people (READMEs, docs, release notes) uses no em dashes, no "not X, it's Y" contrasts and no colon reveals, and takes a position.
