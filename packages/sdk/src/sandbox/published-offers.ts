import {
  isJobOfferVersion,
  type JobOfferVersion,
  type JobTerms,
  jobTermsMatchOffer,
  type OfferVersion,
  offerItemOf,
  parseOfferVersion,
} from '@avow-finance/spec'
import { readJson, type SandboxStore } from './store.js'

/**
 * The offers a supplier published from its folder, a service's or a job's, as the `services` item
 * keeps them. The services and the mailbox both read them here, so neither depends on how the
 * other writes the file.
 */

/** What a services file that holds something it can't read throws. */
export const unreadableServices = () =>
  new Error("The sandbox's services file holds something it can't read.")

/** The published versions in a services file already read as JSON, oldest first. */
export function readPublished(json: Record<string, unknown>): OfferVersion[] {
  return (Array.isArray(json.published) ? json.published : []).map((v: unknown) => {
    const version = parseOfferVersion(v)
    if (!version.ok) throw unreadableServices()
    return version.value
  })
}

/** The versions this folder published and hasn't withdrawn, oldest first. */
export async function publishedOffers(store: SandboxStore): Promise<OfferVersion[]> {
  const text = await store.read('services')
  return text ? readPublished(readJson(text, 'services')) : []
}

/**
 * The job offer a job order is sold under, by the current version this folder published for the
 * order's kind of work. A job's terms name no offer, so an order for a kind of work with no job
 * offer published is answered null and sold as any job is. One for a kind with an offer published
 * has to be exactly the job that version builds, or this throws and nothing is quoted, so an order
 * built from a version replaced or withdrawn here is never quoted.
 */
export function jobOfferFor(
  terms: JobTerms,
  published: readonly OfferVersion[],
): JobOfferVersion | null {
  const kind = terms.subject.work.kind
  const version = published.filter(isJobOfferVersion).find((v) => offerItemOf(v).name === kind)
  if (!version) return null
  if (!jobTermsMatchOffer(terms, version)) {
    throw new Error(
      `The order's terms aren't the job this business's current offer of ${kind} builds, so nothing was quoted.`,
    )
  }
  return version
}
