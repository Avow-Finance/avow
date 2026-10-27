# @avow-finance/verifier

Lets a supplier check an Avow commitment before it grants capacity, without calling Avow. It reads the signed authorization, the supplier's own record of what it agreed to and the chain, and nothing else.

> **Status:** pre-release and testnet only. The Tempo chain reader arrives with the lock contract, and `MemoryChain` stands in for it until then. `readAgentKey` and `tempoKeychainCheck` already read Tempo.

## What it checks

`verifySupplierAuthorization` refuses with the first reason code that applies, in this order.

1. The envelope names a schema version, message type and chain this code reads. The authorization hasn't expired, stays valid for no more than five minutes, and one of Avow's published keys signed it.
2. It's for the commitment the supplier agreed to, with the terms hash the supplier signed. KYB marked as test data passes only where the supplier allows it, and only on a testnet.
3. The supplier's terms and the salt produce that terms hash, the reserve equals the largest charge, and the contest window meets the supplier's profile.
4. The token is one the supplier accepts for the terms' currency, the amount and deadlines match the terms, the payee is the supplier's own payout address, and the acceptance deadline hasn't passed.
5. On the chain, the lock comes from Avow's factory and holds a reserve for this commitment that nobody has accepted yet and that matches the authorization. The agent's key or the account's root key funded it.
6. The agent's key is active, lasts until the release date, and carries the mandate hash Avow named, in the transaction the authorization points to.
7. When the supplier passes the buyer's signed mandate, the mandate hashes to that value, the buyer's account signed it in Tempo's keychain envelope, and its own limits allow this reserve.
8. The commitment hasn't passed this check before. That's recorded only after every other check passes.

It throws, rather than refusing, when the setup is wrong, such as a chain reader for another chain or test data on a chain that isn't a testnet.

## Use

```ts
import { MemoryReplayGuard, TESTNET_DEMO_PROFILE } from '@avow-finance/spec'
import { prepareAcceptance, verifySupplierAuthorization } from '@avow-finance/verifier'

const result = await verifySupplierAuthorization(
  {
    authorization,
    // From the terms agreement this supplier signed for the booking.
    agreed: { commitmentId, termsHash, category: 'compute' },
    terms,
    now: BigInt(Math.floor(Date.now() / 1000)),
  },
  {
    config: {
      chainId: 42431,
      avowKeys: [AVOW_AUTHORIZATION_KEY],
      businessId: MY_BUSINESS_ID,
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
// Keep this result. The verifier passes each commitment only once.

// The acceptance to sign. This refuses for now, as "Accepting" below explains.
const prepared = prepareAcceptance({
  approval,
  terms,
  domain: { chainId: 42431, verifyingContract: result.lock },
})
if (!prepared.ok) throw new Error(prepared.reason)
// Sign prepared.acceptance with the supplier's signing key, send it to the lock, wait for the
// transaction's receipt, then grant the capacity.
```

Accept on the lock before granting anything. Until acceptance lands, the reserve can still go back to the buyer, for example when the buyer revokes the agent or the acceptance deadline passes.

The verifier passes each commitment once, so a supplier keeps the first successful result, and keeps its replay guard in a database so a restart doesn't forget which commitments have passed.

## Accepting

An acceptance binds the supplier to everything in Avow's approval, so a supplier gets one to sign only from `prepareAcceptance`. It is to check every term that binds the supplier against the supplier's own agreed values, then the approval's digest against the one the lock stored, and to refuse when any of them is missing or differs. Those terms are the amount, the token, the deadlines, the contest window, the charges, the day-90 share, the arbiter and the terms hash, with the supplier's own account, signing key and payout. The rest of the approval, such as the mandate hash, the caps, the funding key, the nonce and the expiry, belongs to the business and Avow, and the supplier needs it only to compute the digest.

The supplier's terms don't carry the day-90 share or the arbiter yet, so for now `prepareAcceptance` refuses every request with `terms.incomplete`, and a supplier can't accept a reserve through the verifier.
