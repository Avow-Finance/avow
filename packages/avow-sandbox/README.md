# avow-sandbox

The command that connects your agent to Avow's testnet sandbox.

```sh
npx avow-sandbox connect --name "My agent"
```

The command makes your agent's key on this machine, asks for authority and prints a pairing code and a link. Open the link, sign in or set up your business, and approve once the code there matches. Add `--business <id>`, from the Business page of the Avow console, to ask one business only. Add `--sell` to let the agent quote and accept jobs for your business.

It runs the command from [`@avow-finance/sdk`](https://www.npmjs.com/package/@avow-finance/sdk), so `npx avow-sandbox help` lists everything else it does. Testnet only. Nothing here moves real money.
