# avow-sandbox

The command that connects your agent to Avow's testnet sandbox.

```sh
npx avow-sandbox connect --business <your-business-id> --name "My agent"
```

Your business ID is on the Business page of the Avow console. The command makes your agent's key on this machine, asks your business for authority and prints a pairing code. Approve the request in the console once the code there matches. Add `--sell` to let the agent quote and accept jobs for your business.

It runs the command from [`@avow-finance/sdk`](https://www.npmjs.com/package/@avow-finance/sdk), so `npx avow-sandbox help` lists everything else it does. Testnet only. Nothing here moves real money.
