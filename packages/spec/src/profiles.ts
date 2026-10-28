/** The timing a factory fixes in every lock it creates, in seconds. */
export interface LockTiming {
  /** The shortest contest window a commitment can have. */
  minContestWindow: bigint
  /** How long Avow has to confirm or refer a report. */
  confirmWindow: bigint
  /** How long a posted ruling waits before it takes effect. */
  rulingDelay: bigint
  /** When, counted from a pause, Avow's ruling key stops ruling and the arbiter can start. */
  rulingKeyEnd: bigint
  /** When, counted from a pause, a charge nobody ruled on resolves. */
  day90: bigint
}

/** Limits that differ between the production factory and the testnet demo factory. */
export interface TermsProfile {
  name: 'production' | 'testnet-demo'
  minContestWindow: bigint
  /** The timing of the locks this profile's factory creates. A supplier accepts no other. */
  lockTiming: LockTiming
}

const HOUR = 3600n
const DAY = 24n * HOUR

/**
 * The intended production limits and lock timing. They're unaudited, and no deployed factory
 * creates locks with this timing yet, so a supplier that uses this profile refuses today's locks.
 */
export const PRODUCTION_PROFILE: TermsProfile = {
  name: 'production',
  minContestWindow: 72n * HOUR,
  lockTiming: {
    minContestWindow: 72n * HOUR,
    confirmWindow: DAY,
    rulingDelay: DAY,
    rulingKeyEnd: 30n * DAY,
    day90: 90n * DAY,
  },
}

/**
 * The testnet demo factory's limits, with dispute timing in minutes so a whole commitment runs in
 * one sitting. That factory doesn't enforce every production limit.
 */
export const TESTNET_DEMO_PROFILE: TermsProfile = {
  name: 'testnet-demo',
  minContestWindow: 600n,
  lockTiming: {
    minContestWindow: 600n,
    confirmWindow: 300n,
    rulingDelay: 300n,
    rulingKeyEnd: 1800n,
    day90: 5400n,
  },
}
