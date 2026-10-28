# @avow-finance/sdk

The TypeScript SDK an agent uses to make commitments backed by Avow reserves. An agent books with a supplier, has Avow approve the reserve, checks the approval against the terms, and funds the reserve from its business's account with its own key, while Avow's relay pays the fee. It then cancels or starts the job and reads what the lock holds.

> **Status:** pre-release and testnet only. The lock it calls is unaudited testnet code, and every interface here may change before 1.0.

## Booking

`createAgent` takes the agent's access key on its business account, the mandate the business's administrator signed for it, the token the lock holds, the terms profile, and a connection to Avow. `book` then does the following.

1. It turns the booking into version 2 terms under the GPU reservation template and refuses terms that break their rules.
2. It makes the commitment's id and a random salt, and signs the terms agreement with its key. The supplier signs the same agreement once it has checked the terms and salt give the agreement's terms hash. A supplier signature from another key is refused before Avow sees it.
3. It asks Avow's reserve check to approve, and passes on Avow's refusal with its decision id.
4. It checks Avow's approval before any money moves. The approval has to be signed for this chain and lock, name this commitment, the supplier's own account, signing key and payout, the lock's token, exactly what the terms map to, and the mandate's hash, caps and the agent's key as the funding key. The lock enforces what the approval says, so these are the checks a supplier's verifier makes too.
5. It funds the reserve in one transaction from the business's account, approving the lock to pull the amount and calling `reserve`.

It returns the commitment with its terms, salt, agreement and approval. Keep the salt private, since showing a section of the terms or checking the commitment later needs it.

`cancel` tells Avow the business cancels, and `start` has Avow timestamp the request, the supplier sign its start receipt, and Avow record the start. Both need the mandate to permit the action. `commitment` reads what the lock holds for a commitment.

## What it talks to

- **Avow.** `AvowApi` is Avow's side of the commitments: the reserve check, the relay that pays fees, and the records of cancellations and starts. Avow's hosted API will implement it over HTTP, with each call signed by the agent's key. Until then the interface serves Avow's demos and tests, and it will change when the API ships.
- **The supplier.** `SupplierConnection` is the agent's channel to one supplier, which the supplier's own integration implements.
- **The chain.** The agent's client reads the lock and sends the funding transaction.

## Fees

The business needs no fee token. `sendSponsored` has the key sign the transaction with `feePayer: true`, and Avow's relay co-signs it only when each call goes to the business's own lock or approves that lock to pull the reserve token. The agent sends the co-signed bytes and tracks their hash from the start, since Tempo's public RPC can answer with an error after a transaction has landed. A sponsored transaction is valid for under half a minute, so one that expires before it lands is signed again, up to three signings in all. An agent whose wallet pays its own fees can pass its own `send` to `createAgent`.

## The lock's interface

`RESERVE_ABI` is the interface of the one lock function an agent's key calls, matched to the lock deployed on Moderato. It's testnet code, unaudited, and a new factory can change it. Knowing it grants nothing. On every call the lock checks Avow's signature over the whole approval, that the account calling is the business and the key signing is the approval's funding key, that the business approved the supplier, and the approval's caps and expiry. Those checks protect a reserve. The lock's source stays private until its audit, and no reserve's safety rests on that.

## The administrator's side

`signMandate` and `signHumanApproval` sign for the business account with its root or an admin key, in Tempo's keychain V2 envelope, which the lock and Avow's API need. A browser passkey signs bare, and the envelope is added for it. `agentKeyTerms` turns a mandate into the key authorization Tempo enforces. Pass `[RESERVE_SELECTOR]` as the lock functions, so `reserve` is the one lock function the key can call.

## Use

```ts
import { createAgent } from '@avow-finance/sdk'
import { TESTNET_DEMO_PROFILE } from '@avow-finance/spec'

// client, key, mandate, token, avow and supplier come from the business's setup.
const agent = createAgent({ client, key, mandate, token, profile: TESTNET_DEMO_PROFILE, avow })

const booked = await agent.book({ supplier, booking, category: 'compute' })
if (!booked.ok) throw new Error(booked.reason)
const { commitmentId } = booked.commitment

// When it's time to run the job, start it. Avow records the supplier's signed start receipt.
await agent.start(commitmentId, supplier)
console.log(await agent.commitment(commitmentId))
```

## Develop

```sh
pnpm --filter @avow-finance/sdk test
AVOW_LIVE_TEMPO=1 pnpm --filter @avow-finance/sdk test
```

The second line also sends a sponsored transaction on Moderato from keys made for the run, which the testnet faucet funds.
