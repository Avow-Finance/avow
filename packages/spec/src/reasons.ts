/**
 * Reason codes for every decision Avow makes and every refusal a verifier returns. Each code is
 * a stable string a machine can act on, with a sentence for a person.
 */
export const REASON_CODES = {
  approved: 'Every check passed',
  'business.unverified': 'The business has no current KYB attestation',
  'business.test_data': 'The KYB attestation is test data, which only testnet accepts',
  'administrator.no_authority': "The administrator's authority to bind the business isn't recorded",
  'agent.revoked': "The agent's key is revoked",
  'agent.key_mismatch': "The request didn't come from the mandate's agent key",
  'mandate.invalid': 'The mandate names neither suppliers nor categories, or its caps conflict',
  'mandate.signature_invalid':
    "The mandate's signature doesn't match the business's administrator, so it was changed or forged",
  'mandate.missing':
    "The supported acceptance path needs the buyer's signed mandate, and none was given",
  'mandate.expired': 'The mandate has expired',
  'mandate.revoked': 'The mandate is revoked',
  'mandate.action_not_permitted': "The mandate doesn't permit this action",
  'mandate.supplier_not_allowed': "The supplier isn't on the mandate's list",
  'mandate.category_not_allowed': "The category isn't on the mandate's list",
  'mandate.currency_not_allowed': "The terms' currency isn't the mandate's",
  'mandate.token_not_allowed': "The lock's token isn't one the mandate allows",
  'mandate.over_payment_limit': "The amount is above the mandate's payment limit for the token",
  'mandate.over_commitment_cap': 'The amount is above the cap per commitment',
  'mandate.over_open_reserves_cap': "The amount would take open reserves above the mandate's cap",
  'mandate.ends_before_window': 'The mandate expires before the booking window ends',
  'approval.human_required': 'The mandate asks the administrator to approve this reserve',
  'approval.human_invalid':
    "The administrator's approval is forged, expired, used already, or names another amount or supplier",
  'terms.invalid': "The terms don't parse",
  'terms.reserve_mismatch': "The reserve doesn't equal the largest charge in the terms",
  'terms.deadlines_out_of_order': "The terms' deadlines are out of order",
  'terms.contest_window_short': 'The contest window is shorter than this profile allows',
  'terms.hash_mismatch': "The terms and salt don't produce the signed terms hash",
  'terms.currency_mismatch': "The terms' currency isn't the one the lock's token stands for",
  'terms.incomplete':
    "The supplier's terms don't carry every term it would be bound by, such as the day-90 share and the arbiter, so Avow's approval can't be checked against them",
  'terms.dispute_invalid':
    "The terms' arbiter is missing or zero, or the day-90 share is outside 0 to 10,000 basis points",
  'message.schema_unknown': "The message's schema version or type isn't one this code reads",
  'message.invalid':
    "The message doesn't parse as its schema version, or its fields don't fit together",
  'message.validity_too_long': 'The message stays valid longer than this reader allows',
  'message.wrong_chain': 'The message was signed for another chain',
  'message.wrong_contract': 'The message was signed for another lock',
  'message.expired': 'The message has expired',
  'message.replayed': 'The message has been used before',
  'message.signature_invalid': "The signature doesn't match the message",
  'message.signer_unknown':
    "The signature doesn't come from one of Avow's published keys, so the message was changed or signed by someone else",
  'authorization.payee_mismatch': "The payee isn't the supplier's own payout address",
  'authorization.terms_mismatch': "The authorization's amount or deadlines differ from the terms",
  'authorization.commitment_mismatch':
    'The authorization is for another commitment than the one the supplier agreed to',
  'authorization.mandate_mismatch':
    "The mandate given isn't the one the authorization names, or names another account or agent key",
  'authorization.accept_by_passed':
    'The acceptance deadline has passed, so the reserve can no longer be accepted',
  'authorization.token_not_accepted':
    "The reserve's token isn't one the supplier accepts for the terms' currency",
  'approval.commitment_mismatch':
    "Avow's approval is for another commitment than the one the supplier agreed to",
  'approval.parties_mismatch':
    "Avow's approval names another supplier account, signing key or payout address than the supplier's own",
  'approval.terms_mismatch':
    "Avow's approval differs from the supplier's terms in its side, token, amount, deadlines, contest window or terms hash",
  'approval.charges_mismatch':
    "Avow's approval carries other charges than the supplier's terms set",
  'approval.dispute_mismatch':
    "Avow's approval names another arbiter or day-90 share than the supplier's terms",
  'approval.mandate_mismatch':
    "Avow's approval names another mandate, other caps or another funding key than the buyer's mandate and Avow's authorization",
  'consent.not_releasable':
    "The commitment isn't in a state a supplier's consent can release, or it has a ruling",
  'consent.count_passed':
    'The commitment already has more reports than the consent names, so the lock would never take it',
  'consent.count_out_of_range': 'The consent names a report count no commitment can reach',
  'chain.reserve_missing': 'No reserve for this commitment is on-chain',
  'chain.reserve_mismatch': 'The on-chain reserve differs from the authorization',
  'chain.reserve_accepted': 'The reserve has already been accepted',
  'chain.lock_unknown': "The lock isn't running the code Avow's factory deploys",
  'chain.agent_key_inactive':
    "The agent's key isn't on the chain, is revoked, or expires before the commitment's release date",
  'chain.mandate_mismatch': "The agent key's authorization on-chain carries a different mandate",
  'chain.approval_mismatch':
    'The lock holds this reserve under another approval than the one given, or stores other terms than it names',
  'chain.lock_timing_unexpected':
    "The lock's dispute timing or token isn't what the supplier's profile accepts",
  'chain.supplier_mismatch':
    "The commitment on the lock names another supplier account than this supplier's",
} as const

export type ReasonCode = keyof typeof REASON_CODES

export function describeReason(code: ReasonCode): string {
  return REASON_CODES[code]
}
