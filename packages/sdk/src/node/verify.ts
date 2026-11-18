import { checkShared, isPayee, sharedSentences } from '../sandbox/shared.js'

/**
 * `avow-sandbox verify <link> [--payee <address>]`. Checks a commitment someone shared against the
 * chain, as the MCP server's verify tool does, from any folder and with no agent or business.
 * It exits 1 when the chain doesn't back the commitment, so a script can rely on the answer.
 */
export async function verifyCommand(args: readonly string[]): Promise<void> {
  let link: string | null = null
  let payee: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--payee') payee = args[++i] ?? ''
    else if (arg !== undefined && link === null) link = arg
  }
  if (!link) {
    console.error('Give the link someone shared: avow-sandbox verify <link> [--payee <address>]')
    process.exit(1)
  }
  if (payee !== null && !isPayee(payee)) {
    console.error(`${payee} isn't an address`)
    process.exit(1)
  }
  const checked = await checkShared(payee ? { link, payee } : { link })
  for (const line of sharedSentences(checked)) console.log(line)
  if (!checked.standing || checked.paysYou === false) process.exitCode = 1
}
