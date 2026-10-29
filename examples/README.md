# Examples

Two quickstarts run Avow's flow on Tempo's Moderato testnet against Avow's hosted API. A buyer and a supplier each run one on their own machine, so the flow is proven between two parties Avow doesn't operate. A keeper sends the steps the locks' deadlines bring due, so none of them waits on Avow either.

- [supplier](supplier) is a minimal supplier adapter. It signs terms agreements for agents, asks Avow to authorize each funded reserve, checks Avow's authorization, the buyer's mandate and the lock with the verifier, and sends its acceptance to the lock.
- [buyer](buyer) takes a business from an empty account to a reserve the supplier accepts. It creates the business's lock, signs its agent's mandate, puts the agent's key on the account, enrolls the agent with Avow and books.
- [keeper](keeper) finds every lock a factory created and sends each step that has come due on them, such as returning a kept reserve at its release date, from a key made for the run and with no Avow credentials. A scheduled workflow runs it every 10 minutes.

## The flow

1. The supplier runs `init` and sends Avow the three addresses it prints, to be registered.
2. The buyer runs `init` and sends Avow its account and lock, to be registered. On testnet Avow then sends the account test tUSD to reserve with.
3. The supplier runs `serve`, which stays up.
4. The buyer runs `enroll`, then `book`. The agent agrees terms with the supplier, Avow approves the reserve, the agent funds it while Avow pays the fee, and the supplier accepts it. The supplier grants the capacity once its acceptance lands.
5. At the booking's release date, with nothing reported, Avow's settlement service returns the reserve to the business. When Avow doesn't, the keeper does.

Starting a job, reporting a charge and disputing one come next, once Avow's records for start requests and charge confirmations are settled.

## Running them

You need Node 22.12 or later and pnpm 10. From the repository's root:

```sh
pnpm install
pnpm build
```

Then follow each quickstart's README. Avow gives you the settings it asks for when it registers you.

Each quickstart keeps its keys in a state directory beside where it runs. The keys hold testnet funds only. Keep the directory out of version control and back it up, since the keys can't be made again.
