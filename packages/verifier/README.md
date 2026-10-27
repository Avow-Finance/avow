# @avow-finance/verifier

Lets a supplier check an Avow commitment before it grants capacity, without calling Avow. It reads the signed authorization, the supplier's own copy of the terms and the chain, and nothing else.

> **Status:** pre-release and testnet only. The Tempo chain reader arrives with the lock contract, and `MemoryChain` stands in for it until then.

## What it checks

`verifySupplierAuthorization` refuses with the first reason code that applies, in this order.

1. The envelope names a schema version, message type and chain this code reads.
2. The authorization hasn't expired, and one of Avow's published keys signed it.
3. KYB marked as test data passes only when the supplier's config allows it, which only testnet does.
4. The supplier's terms and the salt produce the signed terms hash, the reserve equals the largest charge, and the contest window meets the supplier's profile.
5. The token is one the supplier accepts for the terms' currency, the amount and deadlines match the terms, the payee is the supplier's own payout address, and the acceptance deadline hasn't passed.
6. On the chain, the lock comes from Avow's factory, it holds a live reserve that matches the authorization, and the agent's key or the account's root key funded it.
7. The agent's key is active, and the mandate hash bound into it matches the one Avow named.
8. When the supplier passes the buyer's signed mandate, the mandate hashes to that value and the buyer's account signed it.
9. The authorization hasn't been used before. Its nonce is recorded only after every other check passes.

## Use

```ts
import { MemoryReplayGuard, TESTNET_DEMO_PROFILE } from '@avow-finance/spec'
import { verifySupplierAuthorization } from '@avow-finance/verifier'

const result = await verifySupplierAuthorization(
  { authorization, terms, now: BigInt(Math.floor(Date.now() / 1000)) },
  {
    config: {
      chainId: 42431,
      avowKeys: [AVOW_AUTHORIZATION_KEY],
      payee: MY_PAYOUT_ADDRESS,
      acceptedTokens: [MY_TOKEN],
      profile: TESTNET_DEMO_PROFILE,
      acceptTestData: true,
    },
    chain,
    replay: new MemoryReplayGuard(),
  },
)
if (!result.ok) throw new Error(result.reason)
```

A production supplier keeps its replay guard in a database, so a restart doesn't forget which authorizations it has seen.
