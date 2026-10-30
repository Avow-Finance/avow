# Examples

Two quickstarts run Avow's flow on Tempo's Moderato testnet against Avow's hosted API. A buyer and a supplier each run one on their own machine, so the flow is proven between two parties Avow doesn't operate. A keeper sends the steps the locks' deadlines bring due on recent commitments, so those don't wait on Avow either.

- [supplier](supplier) is a minimal supplier adapter. It signs terms agreements for agents, asks Avow to authorize each funded reserve, checks Avow's authorization, the buyer's mandate and the lock with the verifier, and sends its acceptance to the lock. It reports a charge on a booking cancelled late or never used.
- [buyer](buyer) takes a business from an empty account to a reserve the supplier accepts. It creates the business's lock, signs its agent's mandate, puts the agent's key on the account, enrolls the agent with Avow and books. It cancels a booking too.
- [keeper](keeper) finds every lock a factory created and sends each step that has come due on a side reserved within its lookback, two weeks by default, such as returning a kept reserve at its release date. It sends from a key made for the run, with no Avow credentials, and a scheduled workflow runs it every 10 minutes.

## The flow

1. The supplier runs `init` and sends Avow the three addresses it prints, to be registered.
2. The buyer runs `init` and sends Avow its account and lock, to be registered. On testnet Avow then sends the account test tUSD to reserve with.
3. The supplier runs `serve`, which stays up.
4. The buyer runs `enroll`, then `book`. The agent agrees terms with the supplier, Avow approves the reserve, the agent funds it while Avow pays the fee, and the supplier accepts it. The supplier grants the capacity once its acceptance lands.
5. At the booking's release date, with nothing reported, Avow's settlement service returns the reserve to the business. When Avow doesn't, the keeper does.
6. A booking cancelled late takes another path. The buyer runs `cancel` once free cancellation has ended, and Avow records when. The supplier runs `report`, and Avow confirms the late-cancellation charge, since it recorded the cancellation once free cancellation had ended and before the charge deadline. Once the contest window closes, the charge pays the supplier at most the late-cancellation amount, and the rest of the reserve goes back to the business. Before free cancellation ends, `cancel` takes the whole reserve back on the lock instead.

Starting a job and disputing a charge come next.

## Running them

You need Node 22.12 or later and pnpm 10. From the repository's root:

```sh
pnpm install
pnpm build
```

Then follow each quickstart's README. Avow gives you the settings it asks for when it registers you.

Each quickstart keeps its keys in a state directory beside where it runs. The keys hold testnet funds only. Keep the directory out of version control and back it up, since the keys can't be made again.
