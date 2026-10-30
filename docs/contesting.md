# Contesting a charge

A business that disagrees with a charge its supplier reported contests it on its own lock. The contest pauses the charge, so nothing is paid until someone rules, and the ruling rests on the records, the business's reason and its statement. This page fixes the six reasons and what each answers, the statement and its hash, and how the statement reaches Avow. `@avow-finance/spec` implements every rule here.

## When the lock takes a contest

The lock takes one contest per commitment from the business account, in two cases.

- **A pending charge**, which Avow has confirmed, until its contest window closes. The window opens when Avow confirms the report and lasts the commitment's `contestWindow`, and the lock judges it by the chain's clock.
- **A report Avow hasn't confirmed or referred**, at any time. A contest before the report's deadline leaves the supplier free to withdraw the report. A contest after it makes the report final, and the pause dates from the deadline.

Anything else the lock refuses. It refuses a contest that names a report other than the latest with `WrongReport`, a second contest with `AlreadyContested`, a closed window with `TooLate`, and a commitment with no pending charge and no standing report with `WrongState`. A contest stays on record when the supplier withdraws the report, and a later report on the same commitment pauses at once.

## The six reasons

Every contest names one reason by its code. The lock takes the code and logs it, and code 0 names no reason.

| Reason | Code | Answers | Means |
| --- | --- | --- | --- |
| `never_cancelled` | 1 | A late cancellation | The business never cancelled |
| `cancelled_in_time` | 2 | A late cancellation | The business cancelled before free cancellation ended |
| `job_started` | 3 | A no-show | The business showed up and the job started |
| `supplier_did_not_provide` | 4 | A no-show | The supplier didn't provide what the terms promise |
| `wrong_charge` | 5 | Any charge | The charge is the wrong kind or the wrong amount |
| `other` | 6 | Any charge | Another reason, which the statement sets out |

A contest can't be taken back, and its reason stays on the chain, so a reason should answer the kind of charge the supplier reported. A no-show can't have been a late cancellation, so `never_cancelled` never answers one. When none of the four specific reasons fits, `wrong_charge` and `other` answer any charge. The lock itself takes any code.

`CONTEST_REASONS` holds the table, `answersCharge` says whether a reason answers a kind, and `contestReasonOf` reads a code back as a reason.

## The statement

The statement is the business's account in its own words, with what it contests.

| Field | Type | Value |
| --- | --- | --- |
| `commitmentId` | 32 bytes of hex | The commitment contested |
| `side` | `buyer` or `supplier` | The side the charge is on. This release reserves only the buyer's |
| `reportNumber` | 1 or 2 | The report contested, which is the lock's `reportCount` when the business contests |
| `reason` | One of the six names | The reason above |
| `text` | string | The business's account |

The text has some character that isn't white space, and no control character but tab, line feed and carriage return. It's well-formed Unicode, at most 4,000 bytes of UTF-8, which is about 600 words of English and half as many characters of text in a script that takes two bytes a character. It's hashed exactly as written, with no trimming and no normalizing, so the business keeps the exact text it contested with.

## Its encoding and hash

The statement's canonical JSON is RFC 8785, as the terms use. It holds exactly the five fields with their keys sorted, the commitment id in lower case, the report number as a JSON number and non-ASCII characters as UTF-8 without escapes. `encodeContestStatement` writes it.

The statement hash is

```
keccak256(abi.encode(string "avow:contest-statement:v1", string canonicalJson))
```

which `contestStatementHash` computes. The label names the format's version, and keeps a statement's hash from ever matching a hash of the terms. A change to the statement's fields, its encoding or its hashing takes a new label.

[`packages/spec/vectors/contest-statement-v1.json`](../packages/spec/vectors/contest-statement-v1.json) holds worked examples, with the canonical JSON and the hash of each. One of them carries non-ASCII letters, an emoji, quotes, a backslash, a tab and both kinds of line break, so an implementation that escapes or normalizes text hashes it differently.

## Sending the contest

The contest carries the reason's code and the statement hash to the lock in one of two ways.

- **From the root key.** The business account calls `contest(commitmentId, side, reportNumber, reasonCode, statementHash)` on its lock with its root key, and pays its own fee.
- **As a signed action.** The root key or an admin key signs a `BusinessAction` with the action `contest`, as `contestAction` builds it, and any account can send it to the lock's `businessAction`.

Either way the lock logs `Paused(commitmentId, side, termsHash, cause, pausedAt, reasonCode, evidenceHash, returned)` with the cause 3, a contest, and the statement hash as `evidenceHash`.

## Giving Avow the statement

The chain holds the statement's hash, and Avow needs the text to rule on. The business account's root key signs a request, as [signed requests](../packages/spec/signed-requests.md) set out, to

```
POST /v1/commitments/{commitmentId}/contest-statements
```

with the statement and the transaction that carried the contest.

```json
{
  "contestedIn": "0x…",
  "statement": {
    "commitmentId": "0x…",
    "reason": "job_started",
    "reportNumber": 1,
    "side": "buyer",
    "text": "Our agent sent the start request at 14:02 and the supplier receipted it at 14:03."
  }
}
```

Avow checks that the signer is the account of the business that owns the request's lock, and that the commitment is one it approved on that lock. It reads the transaction, and records the statement only when the transaction succeeded and holds that lock's `Paused` event for the commitment and side, caused by a contest, with the statement's reason code and hash. It answers with the statement's hash and when it first recorded the statement.

```json
{ "recordedAt": "1800000060", "statementHash": "0x…" }
```

A commitment has one contest, so it has one statement. Posting the same statement again, with any request id, gets the first answer and records nothing more, which makes posting again always safe. Another statement can't match the hash on the chain, so Avow refuses it.

| Status | Code | When |
| --- | --- | --- |
| 400 | `message.invalid` | The body isn't a statement and a transaction hash, or the statement names another commitment than the path |
| 400 | `contest.statement_invalid` | The statement's text breaks the rules above |
| 401 | `request.signer_unknown` | The signer isn't the account of the business that owns the request's lock |
| 404 | `commitment.unknown` | Avow approved no such commitment on that lock |
| 409 | `contest.not_on_chain` | The transaction failed, isn't on the chain yet, or holds no contest of this commitment from that lock |
| 409 | `contest.statement_mismatch` | The contest on the chain names another reason or statement hash |
| 503 | `service.unavailable` | Avow couldn't read its records or the chain, so it recorded nothing |

When posting fails, the contest still stands and the charge stays paused, and the business posts the same statement again later.

## After the contest

The charge stays paused until a ruling. Avow's ruling key can rule from the pause until the pause plus the lock's `rulingKeyEnd`, which is 30 minutes on testnet and 30 days in production. Then the commitment's arbiter can rule until the pause plus the lock's `day90`. A ruling takes effect after the lock's `rulingDelay`, and a charge nobody rules on resolves at day 90, paying the supplier the day-90 share of a charge Avow confirmed and nothing of one it didn't.
