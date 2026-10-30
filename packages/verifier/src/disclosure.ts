import {
  type Approval,
  CHARGE_KINDS,
  type ChargeKind,
  type ChargeReport,
  canonicalJson,
  type LockTiming,
  type RailToken,
  type ReleaseConsent,
  type ReleaseReason,
} from '@avow-finance/spec'
import {
  type Address,
  formatUnits,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  stringToHex,
} from 'viem'

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

/** A length of time in days, hours, minutes and seconds, leaving out the parts that are zero. */
export function formatLength(seconds: bigint): string {
  const units: [bigint, string][] = [
    [86_400n, 'day'],
    [3600n, 'hour'],
    [60n, 'minute'],
    [1n, 'second'],
  ]
  const parts: string[] = []
  let rest = seconds
  for (const [size, name] of units) {
    const n = rest / size
    rest %= size
    if (n > 0n) parts.push(`${n} ${name}${n === 1n ? '' : 's'}`)
  }
  const last = parts.pop()
  if (last === undefined) return '0 seconds'
  return parts.length === 0 ? last : `${parts.join(', ')} and ${last}`
}

/** Base units of a token as an amount of its currency, with the base units beside it. */
export function formatAmount(units: bigint, token: RailToken): string {
  return `${token.currency} ${formatUnits(units, token.decimals)} (${units} base units of ${getAddress(token.token)})`
}

/** The token a supplier lists that a lock on its chain holds reserves in, or null when it lists none. */
export function listedToken(
  tokens: readonly RailToken[],
  chainId: number,
  token: Address,
): RailToken | null {
  return tokens.find((t) => t.chainId === chainId && isAddressEqual(t.token, token)) ?? null
}

/** Base units of a lock's token as an amount of its currency, or as base units when it isn't listed. */
export function formatLockAmount(units: bigint, token: RailToken | null): string {
  return token ? formatAmount(units, token) : `${units} base units of the lock's token`
}

/** Basis points as a percentage. */
export function formatShare(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`
}

/** How each kind of charge reads to a person, at the start of a sentence. */
export const CHARGE_NAMES: Record<ChargeKind, string> = {
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
  /** When the acceptance itself stops working. */
  expiry: bigint
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
          `This acceptance stops working at ${formatTime(args.expiry)}, and the lock takes no acceptance from ${formatTime(a.acceptBy)}.`,
          `Report any charge before ${formatTime(a.chargeDeadline)}.`,
          `With no report, the reserve goes back to the business at ${formatTime(a.releaseDate)}.`,
        ],
      },
      {
        heading: 'Disputes',
        lines: [
          `Avow confirms or refers each report within ${formatDuration(timing.confirmWindow)}, and a report it doesn't answer in time goes to a ruling.`,
          `The business can contest a confirmed charge for ${formatDuration(a.contestWindow)}, and a report Avow hasn't confirmed at any time. Avow can also pause a confirmed charge before its contest window closes. Each of these sends the charge to a ruling.`,
          'The commitment takes at most two reports, one at a time.',
          `A contested or referred charge is paused. Avow's ruling key can rule for ${formatDuration(timing.rulingKeyEnd)} after the pause, then the arbiter ${getAddress(a.arbiter)} can rule until ${formatDuration(timing.day90)} after it, and a ruling takes effect ${formatDuration(timing.rulingDelay)} after it's posted.`,
          `A confirmed charge still unruled ${formatDuration(timing.day90)} after the pause pays you ${formatShare(a.day90SupplierShareBps)} of it, and the rest goes back to the business. A charge Avow never confirmed goes back to the business in full.`,
        ],
      },
    ],
  })
}

/** The disclosure for a report of a charge, built from what the lock holds for the commitment. */
export function reportDisclosure(args: {
  digest: Hex
  report: ChargeReport
  lock: Address
  chainId: number
  /** The business account the lock holds the reserve for. */
  account: Address
  /** Where a charge pays, as the lock stores it. */
  payee: Address
  /** The lock's token, or null when the supplier doesn't list it. */
  token: RailToken | null
  chargeDeadline: bigint
  contestWindow: bigint
  day90SupplierShareBps: number
  timing: LockTiming
  /** The reports filed on the commitment before this one. */
  reportCount: number
}): Disclosure {
  const { report: r, timing } = args
  const amount = formatLockAmount(r.amount, args.token)
  return seal({
    title: 'Report a charge',
    digest: args.digest,
    preauthorization: null,
    sections: [
      {
        heading: "What you're reporting",
        lines: [
          `You report ${CHARGE_NAMES[r.kind].toLowerCase()} on commitment ${r.commitmentId} on lock ${getAddress(args.lock)}, chain ${args.chainId}, held for business account ${getAddress(args.account)}.`,
          `It charges ${amount}, paid to ${getAddress(args.payee)}.`,
          `It names the evidence with hash ${r.evidenceHash}, so keep what that hash covers for a ruling.`,
        ],
      },
      {
        heading: 'What happens next',
        lines: [
          `Avow confirms or refers the report within ${formatDuration(timing.confirmWindow)} of the first report of its kind on this commitment, and a report it doesn't answer by then goes to a ruling.`,
          'Once Avow answers the report, or it goes to a ruling unanswered, the lock keeps only the charge and gives the rest of the reserve back to the business.',
          `A confirmed charge pays once its contest window of ${formatDuration(args.contestWindow)} closes, unless the business contests it or Avow pauses it first.`,
          `The business can contest a report Avow hasn't confirmed at any time. A contested, paused or referred charge waits for a ruling, and one still unruled ${formatDuration(timing.day90)} after its pause pays you ${formatShare(args.day90SupplierShareBps)} of it if Avow confirmed it and nothing if Avow didn't.`,
        ],
      },
      {
        heading: 'Reports',
        lines: [
          `This is report ${args.reportCount + 1} of the two the commitment takes, and the lock takes no other report while it stands.`,
          "Your supplier account's root key can withdraw it before Avow answers it and before its deadline.",
        ],
      },
      {
        heading: 'Expiry',
        lines: [
          `It stops working at ${formatTime(r.expiry)}, and the lock takes no report from ${formatTime(args.chargeDeadline)}.`,
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
  /** When the consent was prepared. */
  now: bigint
}): Disclosure {
  const { consent: c } = args
  const held = formatLockAmount(args.held, args.token)
  const later = c.reportCount > args.currentCount
  const until = formatTime(c.expiry)
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
          'You give up any charge on the commitment, reported or not, including one Avow has confirmed.',
          `It records that ${REASON_NAMES[c.reason]}.`,
        ],
      },
      {
        heading: 'Report count',
        lines: later
          ? [
              `It names report count ${c.reportCount}, and the commitment has ${args.currentCount}, so the lock refuses it now.`,
              `Once the commitment has ${c.reportCount} reports, anyone holding this consent can send it until ${until} and release the reserve, which gives up the charge in that report. That's preauthorization, so sign it only if you mean to give that charge up in advance.`,
            ]
          : [
              `It names report count ${c.reportCount}, the count the commitment has now. Anyone holding it can send it until ${until} and release the reserve, and it stops working if another report is filed first.`,
            ],
      },
      {
        heading: 'Expiry',
        lines: [
          `It stops working at ${until}, ${formatLength(c.expiry - args.now)} after it was prepared, or sooner once a ruling is posted or the commitment ends.`,
        ],
      },
    ],
  })
}
