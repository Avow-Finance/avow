/**
 * The schema version in every signed message's EIP-712 domain. Readers refuse a message whose
 * domain names a version they don't know (acceptance test 5).
 */
export const SCHEMA_VERSION = '1'

/** The versions this package can read. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = [SCHEMA_VERSION]

/** The EIP-712 domain name of every Avow message. */
export const DOMAIN_NAME = 'Avow'

/** The version of the mandate check in `checkMandate`, recorded on every decision. */
export const POLICY_VERSION = 'mandate-check/1'

export function isSupportedSchemaVersion(version: string): boolean {
  return SUPPORTED_SCHEMA_VERSIONS.includes(version)
}
