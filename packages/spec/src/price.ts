import { GPU_RESERVATION, gpuWindowPrice } from './gpu-reservation.js'
import { JOB } from './job.js'
import { SERVICE, servicePrice } from './service.js'
import type { AnyTerms } from './terms.js'
import { isTermsV1 } from './terms-v1.js'
import type { ChainedTerms } from './types.js'

/**
 * What one commitment's price comes to under its terms, in micros of their currency, whichever
 * template they use. A service's is its price per unit times the units booked, a job's is its one
 * fixed price, and a GPU reservation's is its rate for every GPU over the whole window, which is
 * the most its usage can come to. Version 1 terms read as a GPU reservation. The lock never reads
 * a price, so this is what the mandate check holds to a mandate's price limit. It takes terms that
 * `validateTerms` or `validateChainedTerms` passed.
 */
export function termsPrice(terms: AnyTerms | ChainedTerms): bigint {
  if (isTermsV1(terms)) {
    return gpuWindowPrice(terms.price.perGpuHour, terms.resource.count, terms.windowDuration)
  }
  switch (terms.template) {
    case SERVICE:
      return servicePrice(terms)
    case JOB:
      return terms.consideration.amount
    case GPU_RESERVATION:
      return gpuWindowPrice(
        terms.consideration.amount,
        terms.subject.resource.count,
        terms.subject.windowDuration,
      )
    default: {
      const unknown: never = terms
      void unknown
      throw new RangeError('No price is defined for terms under this template')
    }
  }
}
