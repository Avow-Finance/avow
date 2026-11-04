import { httpSupplier, type SupplierConnection } from '../supplier.js'
import type { SandboxSupplier } from './store.js'

/** The suppliers a business names, checked: at least one, each id once, each an http(s) URL. */
export function checkSuppliers(suppliers: readonly SandboxSupplier[]): SandboxSupplier[] {
  if (suppliers.length === 0) throw new RangeError('The agent needs at least one supplier')
  const ids = new Set<string>()
  for (const s of suppliers) {
    if (typeof s.id !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(s.id)) {
      throw new RangeError(`${String(s.id)} isn't a supplier's business id`)
    }
    if (ids.has(s.id)) throw new RangeError(`${s.id} is listed twice`)
    ids.add(s.id)
    const url = new URL(s.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new RangeError(`${s.url} isn't an http or https URL`)
    }
  }
  return suppliers.map((s) => ({ id: s.id, url: s.url }))
}

/** Connects to a supplier's adapter and checks its profile names the supplier expected. */
export async function connectSupplier(
  s: SandboxSupplier,
  send: typeof fetch,
): Promise<SupplierConnection> {
  const connection = await httpSupplier(s.url, send)
  if (connection.profile.businessId !== s.id) {
    throw new Error(
      `The supplier at ${s.url} says it's ${connection.profile.businessId}, not ${s.id}, so the agent won't commit to it.`,
    )
  }
  return connection
}
