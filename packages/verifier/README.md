# @avow-finance/verifier

Lets a supplier check an Avow commitment before it grants capacity, and accept it, without calling Avow. It reads the signed authorization, the buyer's signed mandate, the supplier's own record of what it agreed to and the chain, and nothing else.

> **Status:** pre-release and testnet only. `tempoChainReader` reads the lock and the keychain on Tempo, and `MemoryChain` stands in for the chain in tests.

## What it checks

`verifySupplierAuthorization` refuses with the first reason code that applies, in this order.

1. The envelope names a schema version, message type and chain this code reads. The authorization hasn't expired, stays valid for no more than five minutes, and one of Avow's published keys signed it.
2. It's for the commitment the supplier agreed to, with the terms hash the supplier signed. KYB marked as test data passes only where the supplier allows it, and only on a testnet.
3. The supplier's terms and the salt produce that terms hash, the reserve equals the largest charge, the contest window meets the supplier's profile, and the terms name an arbiter and a day-90 share from 0 to 10,000.
4. The token is one the supplier accepts for the terms' currency, the amount and deadlines match the terms, the payee is the supplier's own payout address, and the acceptance deadline hasn't passed.
5. On the chain, the lock comes from Avow's factory and holds a reserve for this commitment that nobody has accepted yet and that matches the authorization. The agent's key or the account's root key funded it.
6. The agent's key is active, lasts until the release date, and carries the mandate hash Avow named, in the transaction the authorization points to.
7. When the supplier passes the buyer's signed mandate, the mandate hashes to that value, the buyer's account signed it in Tempo's keychain envelope, and its own limits allow this reserve.
8. The commitment hasn't passed this check before. That's recorded only after every other check passes.

It throws, rather than refusing, when the setup is wrong, such as a chain reader for another chain or test data on a chain that isn't a testnet.

## Accepting

An acceptance binds the supplier to everything in Avow's approval, so a supplier gets one to sign only from `prepareAcceptance`, and signs it only with `signAcceptance`. `prepareAcceptance` refuses with the first reason that applies.

1. Avow's authorization passes every check above, with the buyer's signed mandate required. It names the buyer and the mandate the supplier's own terms agreement names, and the mandate is that buyer's. A mandate that's forged, expired, revoked with its agent key, or that doesn't allow this supplier, category, currency, token or amount refuses.
2. Avow's approval names the commitment the supplier agreed to, the supplier's own account, signing key and payout, and the token, amount, deadlines, contest window, terms hash, charges, day-90 share and arbiter of the supplier's own terms.
3. It names the mandate the authorization names, that mandate's two caps, and a funding key that's the mandate's agent key or the account's root key and that funded the reserve.
4. The lock stores the digest of exactly this approval and the same terms, and its token and dispute timing are the ones the supplier's profile accepts.

Then it builds the acceptance, which names the lock's digest of the approval and expires within ten minutes, and a disclosure for the person who approves the signature. The disclosure states the reserve and what each charge can take and from when, who receives charges, the free-cancellation and acceptance deadlines, the charge deadline and the release date, and the dispute terms: Avow's confirmation window, the contest window, how long Avow's ruling key and then the arbiter can rule, when a ruling takes effect, and the supplier's day-90 share. `signAcceptance` takes the disclosure's id back, so nothing is signed until an integration has fetched the disclosure and the person has confirmed it. It signs only the frozen object `prepareAcceptance` returned, so a copy or an edit throws, and it refuses a key other than the signing key the approval names.

## Release consents

A release consent gives the reserve back to the business, and the lock takes it only while the commitment's report count equals the count it names. It gives up the supplier's charge, a reported or confirmed one included. Nothing caps how long a consent lasts, so its disclosure states the exact expiry and how long that is from when it was prepared. `prepareReleaseConsent` reads the commitment from the lock and refuses another supplier's commitment, one the lock wouldn't release on consent, a consent that has expired, and a count the commitment has passed or can never reach. A consent for a later count than the commitment has becomes valid once reports reach it. That's preauthorization, so its disclosure says so, and `signReleaseConsent` refuses to sign it without `preauthorize: true` as well as the disclosure's id. Like `signAcceptance`, it signs only the frozen object its prepare call returned. The consent is signed by the supplier account's root key or an admin key, in Tempo's keychain envelope, and the signature is checked against the chain before it's returned.

## What this doesn't protect

These checks are an application-level gate. They protect a supplier that signs only what `prepareAcceptance` and `prepareReleaseConsent` return. The lock checks a signature and a digest, so it takes a correctly signed acceptance or consent however it was built, and a supplier whose signing tool skips this library gets none of these checks.

The checks also rest on things the verifier doesn't prove.

- **The node.** Everything read from the chain comes through the node the reader talks to, so a supplier reads through a node it chose.
- **The pinned factory.** A lock counts as Avow's only when the factory the supplier configured says it created it.
- **Avow's signature.** The authorization stands for the business's KYB, for a person's approval when the mandate asks for one, and for any revocation Avow recorded off the chain.
- **The supplier's own records.** The terms, the agreed commitment and the supplier's account, key and payout come from the supplier, so a wrong record checks the wrong terms.
- **The mandate's contents.** The supplier sees the buyer's whole mandate, including its other suppliers, categories and caps.
- **The lock after the read.** The prepare calls read the lock once. Before an acceptance lands, the reserve can still go back to the business, and the lock then refuses the acceptance, so a supplier grants capacity only once the acceptance's receipt shows it landed.
- **The person.** The disclosure is only as good as the screen that shows it. The library can make an integration fetch it, but it can't make a person read it, and code that holds the signing key can always sign without this library.

## Use

```ts
import { TESTNET_DEMO_PROFILE } from '@avow-finance/spec'
import { prepareAcceptance, signAcceptance, tempoChainReader } from '@avow-finance/verifier'

const chain = tempoChainReader(client, { factory: AVOW_FACTORY })
const config = {
  chainId: 42431,
  avowKeys: [AVOW_AUTHORIZATION_KEY],
  businessId: MY_BUSINESS_ID,
  payee: MY_PAYOUT_ADDRESS,
  account: MY_ACCOUNT,
  signingKey: MY_SIGNING_KEY_ADDRESS,
  acceptedTokens: [MY_TOKEN],
  profile: TESTNET_DEMO_PROFILE,
  acceptTestData: true,
}
// From the terms agreement this supplier signed for the booking.
const agreed = { commitmentId, termsHash, category: 'compute', buyerBusinessId, mandateHash }
const now = BigInt(Math.floor(Date.now() / 1000))

const prepared = await prepareAcceptance(
  { authorization, approval, mandate, agreed, terms, now },
  { config, chain },
)
if (!prepared.ok) throw new Error(prepared.reason)

// Show every section of prepared.disclosure, and sign only once the person confirms it.
const acceptance = await signAcceptance(prepared, signingKey, {
  disclosureId: prepared.disclosure.id,
})
// Send the acceptance to the lock, wait for the transaction's receipt, then grant the capacity.
```

Accept on the lock before granting anything. Until acceptance lands, the reserve can still go back to the buyer, for example when the buyer revokes the agent or the acceptance deadline passes. Even after it lands, the business can take the whole reserve back until the free-cancellation deadline.

`verifySupplierAuthorization` passes each commitment once, so a supplier that uses it keeps the first successful result, and keeps its replay guard in a database so a restart doesn't forget which commitments have passed. `prepareAcceptance` records nothing, since the lock takes one acceptance per reserve.
