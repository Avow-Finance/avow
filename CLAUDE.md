# Working in this repo

This is the public half of Avow: the TypeScript SDK, the MCP server and the verifier. The lock contract, the API and the product docs live in the private avow-core repo.

## Commands

- `pnpm install` installs everything.
- `pnpm check` runs lint, type checks and tests. Run it before every commit.
- `pnpm format` fixes formatting.

## Rules

- Every change goes through a pull request with tests, and CI must pass.
- Testnet only. Nothing here moves real money.
- Never commit keys, tokens or `.env` files.
- Packages stay `"private": true` until their first release.
- Product text uses reserve, commitment, charge, dispute and release, and never bond, coverage, premium, claim or guarantee.
- Writing for people (READMEs, docs, release notes) uses no em dashes, no "not X, it's Y" contrasts and no colon reveals, and takes a position.
