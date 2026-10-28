import {
  type Approval,
  CHARGE_KINDS,
  type ChargeKind,
  canonicalJson,
  type LockTiming,
  type RailToken,
  type ReleaseConsent,
  type ReleaseReason,
} from '@avow-finance/spec'
import { type Address, formatUnits, getAddress, type Hex, keccak256, stringToHex } from 'viem'

export interface DisclosureSection {
  heading: string
  lines: readonly string[]
}

/**
 * What a person sees before the supplier signs. The signing call takes `id` back, so the
 * integration has to fetch this disclosure and confirm it before anything is signed. It can't
 * make a person read it, so an integration shows every section in full.
 */
export interface Disclosure {
  title: string
  /** The EIP-712 digest the signature covers. */
  digest: Hex
  sections: readonly DisclosureSection[]
  /** Set when a release consent names a later report count than the commitment has. */
  preauthorization: { currentCount: number; consentCount: number } | null
  /** The keccak256 of the canonical JSON of everything above. */
  id: Hex
}

/** The id of a disclosure, from everything it shows. */
export function disclosureId(d: Omit<Disclosure, 'id'>): Hex {
  return keccak256(
    stringToHex(
      canonicalJson({
        title: d.title,
        digest: d.digest,
        sections: d.sections.map((s) => ({ heading: s.heading, lines: [...s.lines] })),
        preauthorization: d.preauthorization,
      }),
    ),
  )
}

function seal(d: Omit<Disclosure, 'id'>): Disclosure {
  return { ...d, id: disclosureId(d) }
}

/** A unix time as an ISO 8601 time in UTC, to the second. */
export function formatTime(t: bigint): string {
  return new Date(Number(t) * 1000).toISOString().replace('.000Z', 'Z')
}

/** A duration in the largest whole unit it fits. */
export function formatDuration(seconds: bigint): string {
  const units: [bigint, string][] = [
    [86_400n, 'day'],
    [3600n, 'hour'],
    [60n, 'minute'],
  ]
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0n) {
      const n = seconds / size
      return `${n} ${name}${n === 1n ? '' : 's'}`
    }
  }
  return `${seconds} second${seconds === 1n ? '' : 's'}`
}

/** Base units of a token as an amount of its currency, with the base units beside it. */
export function formatAmount(units: bigint, token: RailToken): string {
  return `${token.currency} ${formatUnits(units, token.decimals)} (${units} base units of ${getAddress(token.token)})`
}

/** Basis points as a percentage. */
export function formatShare(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`
}

const CHARGE_NAMES: Record<ChargeKind, string> = {
  lateCancellation: 'A late cancellation',
  noShow: 'A no-show',
}

const REASON_NAMES: Record<ReleaseReason, string> = {
  kept: 'the commitment was kept',
  supplierFailed: 'the supplier failed to provide the capacity',
}

/** The disclosure for an acceptance, built from the approval the lock holds and the lock's timing. */
export function acceptanceDisclosure(args: {
  digest: Hex
  approval: Approval
  approvalDigest: Hex
  lock: Address
  chainId: number
  account: Address
  token: RailToken
  timing: LockTiming
}): Disclosure {
  const { approval: a, token, timing } = args
  const amount = (units: bigint) => formatAmount(units, token)
  const charges = [...a.charges].sort((x, y) => CHARGE_KINDS[x.kind] - CHARGE_KINDS[y.kind])
  return seal({
    title: 'Accept a reserve',
    digest: args.digest,
    preauthorization: null,
    sections: [
      {
        heading: "What you're accepting",
        lines: [
          `You accept the reserve for commitment ${a.commitmentId} on lock ${getAddress(args.lock)}, chain ${args.chainId}, held for business account ${getAddress(args.account)}.`,
          `Your acceptance binds you to every term of Avow's approval with digest ${args.approvalDigest}, which the lock stores.`,
        ],
      },
      {
        heading: 'Your exposure',
        lines: [
          `The business reserved ${amount(a.amount)}. None of it reaches you unless a charge you report is confirmed and its contest window closes, or a ruling or the day-90 split pays it.`,
          ...charges.map(
            (c) =>
              `${CHARGE_NAMES[c.kind]} can charge up to ${amount(c.most)}, reported from ${formatTime(c.earliest)} and before ${formatTime(a.chargeDeadline)}.`,
          ),
          `Charges pay to ${getAddress(a.payee)}.`,
        ],
      },
      {
        heading: 'Deadlines',
        lines: [
          `Free cancellation ends at ${formatTime(a.freeCancelBy)}. Until then the business can take the whole reserve back without your consent.`,
          `This acceptance has to reach the lock before ${formatTime(a.acceptBy)}.`,
          `Report any charge before ${formatTime(a.chargeDeadline)}.`,
          `With no report, the reserve goes back to the business at ${formatTime(a.releaseDate)}.`,
        ],
      },
      {
        heading: 'Disputes',
        lines: [
          `Avow confirms or refers each report within ${formatDuration(timing.confirmWindow)}, and a report it doesn't answer in time goes to a ruling.`,
          `The business can contest a confirmed charge for ${formatDuration(a.contestWindow)}.`,
          `A contested or referred charge is paused. Avow's ruling key can rule for ${formatDuration(timing.rulingKeyEnd)} after the pause, then the arbiter ${getAddress(a.arbiter)} can rule until ${formatDuration(timing.day90)} after it, and a ruling takes effect ${formatDuration(timing.rulingDelay)} after it's posted.`,
          `A confirmed charge still unruled ${formatDuration(timing.day90)} after the pause pays you ${formatShare(a.day90SupplierShareBps)} of it, and the rest goes back to the business. A charge Avow never confirmed goes back to the business in full.`,
        ],
      },
    ],
  })
}

/** The disclosure for a release consent. */
export function releaseConsentDisclosure(args: {
  digest: Hex
  consent: ReleaseConsent
  lock: Address
  chainId: number
  account: Address
  held: bigint
  token: RailToken | null
  currentCount: number
}): Disclosure {
  const { consent: c } = args
  const held = args.token
    ? formatAmount(args.held, args.token)
    : `${args.held} base units of the lock's token`
  const later = c.reportCount > args.currentCount
  return seal({
    title: 'Consent to release a reserve',
    digest: args.digest,
    preauthorization: later
      ? { currentCount: args.currentCount, consentCount: c.reportCount }
      : null,
    sections: [
      {
        heading: "What you're consenting to",
        lines: [
          `This consent releases everything lock ${getAddress(args.lock)}, chain ${args.chainId}, holds for commitment ${c.commitmentId} back to the business account ${getAddress(args.account)}, ${held} now.`,
          'You give up any charge on the commitment, reported or not.',
          `It records that ${REASON_NAMES[c.reason]}.`,
        ],
      },
      {
        heading: 'Report count',
        lines: later
          ? [
              `It names report count ${c.reportCount}, and the commitment has ${args.currentCount}, so the lock refuses it now.`,
              `Once the commitment has ${c.reportCount} reports, anyone holding this consent can send it and release the reserve until it expires, which gives up the charge in that report. That's preauthorization, so sign it only if you mean to give that charge up in advance.`,
            ]
          : [
              `It names report count ${c.reportCount}, the count the commitment has now. Anyone holding it can send it and release the reserve until it expires, and it stops working if another report is filed first.`,
            ],
      },
      { heading: 'Expiry', lines: [`It stops working at ${formatTime(c.expiry)}.`] },
    ],
  })
}
