# Avow

The commitment layer for autonomous trade.

Avow lets a verified business give its AI agents the authority to make commitments, and backs each commitment with money reserved for one named supplier. A supplier can then accept an agent it has never met, because it can check who is responsible for the agent, what the agent may commit to, and what money stands behind the commitment.

This repository holds the open parts of Avow that developers and suppliers run themselves.

> **Status:** pre-release and testnet only. Nothing here moves real money, and every interface will change before 1.0.

## What's here

| Package | What it does | Status |
| --- | --- | --- |
| `@avow-finance/sdk` | TypeScript SDK for agents: show the business and its limits, check a booking against the mandate, request a reserve, list commitments | In progress, starting with signing for a business account |
| `@avow-finance/mcp-server` | MCP server that gives an agent in Claude, Cursor or any other MCP client the same calls | Planned |
| `@avow-finance/verifier` | Lets a supplier check a commitment's authorization, terms and on-chain reserve without calling Avow | In progress |
| `@avow-finance/spec` | The commitment schema the others share: records, compute terms, signed messages, reason codes and the mandate check | In progress |

Quickstarts will live in `examples/`.

## How a commitment works

1. A business passes verification and names an administrator.
2. The administrator signs a mandate that sets what one agent may commit to, and the agent gets a scoped key on Tempo.
3. The agent asks a supplier to reserve capacity, such as GPU time with a $500 cancellation charge.
4. Avow checks the mandate, and $500 of the business's own money is reserved for that supplier.
5. The supplier verifies the reserve on-chain, accepts it on the lock, and only then grants the capacity. Accepting waits until the verifier can check every term that binds the supplier.
6. When the job completes, the money goes back to the business. A late cancellation pays the agreed charge after a contest window, and never more than the reserve.

Avow is built first on [Tempo](https://tempo.xyz) testnet, with other rails to follow.

## What opens next

`@avow-finance/spec` holds the working schema and terms format under Apache 2.0, because the verifier needs them to check a commitment. The format is provisional and will change after supplier calls, under the rules in that package's README. Once a real counterparty has used it, the written specification will be published in the public domain (CC0). This code isn't that specification and isn't CC0. The reserve contract will be published once it has been audited.

## Develop

You need Node 22.12 or later and pnpm 10.

```sh
pnpm install
pnpm check
```

`pnpm check` runs lint, the build, type checks and tests. See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes get in.

## Security

Please report vulnerabilities privately to contact@avow.finance, never in a public issue. See [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
