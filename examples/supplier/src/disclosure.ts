import type { Disclosure } from '@avow-finance/verifier'

/**
 * Shows a disclosure in full before the supplier signs. The quickstart confirms for its person, and
 * a real integration shows this and waits for a yes.
 */
export function showDisclosure(disclosure: Disclosure, log: (line: string) => void) {
  log(`${disclosure.title} (disclosure ${disclosure.id})`)
  for (const section of disclosure.sections) {
    log(`  ${section.heading}`)
    for (const line of section.lines) log(`    ${line}`)
  }
}
