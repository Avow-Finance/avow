/**
 * The header an agent's requests carry to say which client it runs in, such as the MCP client it was
 * started from or the terminal. The agent reports it about itself, outside the signature, so a
 * reader shows it as what the agent says and never relies on it.
 */
export const CLIENT_HEADER = 'avow-client'

/** What a client label may hold: up to 60 letters, digits, spaces and a little punctuation. */
const CLIENT_LABEL = /^[A-Za-z0-9 ._()/:-]{1,60}$/

/** A client label as an agent sent it, trimmed, or null when there's none or it isn't one. */
export function clientLabelOf(raw: string | null | undefined): string | null {
  const label = raw?.trim()
  return label && CLIENT_LABEL.test(label) ? label : null
}
