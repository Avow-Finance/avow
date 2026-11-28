import { OPENROUTER_URL } from './chat.js'

/** The run's flags, read where they enter. */
export interface CompatArgs {
  models: string[]
  baseUrl: string
  keyEnv: string
  out: string
}

export function readArgs(argv: readonly string[]): CompatArgs | { error: string } {
  const args: CompatArgs = {
    models: [],
    baseUrl: OPENROUTER_URL,
    keyEnv: 'OPENROUTER_API_KEY',
    out: 'compat-results',
  }
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` }
    if (flag === '--model')
      args.models.push(
        ...value
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
      )
    else if (flag === '--base-url') args.baseUrl = value
    else if (flag === '--key-env') args.keyEnv = value
    else if (flag === '--out') args.out = value
    else return { error: `Unknown flag ${flag}` }
  }
  if (args.models.length === 0) return { error: 'Name at least one model with --model' }
  try {
    if (new URL(args.baseUrl).protocol !== 'https:') return { error: '--base-url has to be https' }
  } catch {
    return { error: `${args.baseUrl} isn't a URL` }
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(args.keyEnv))
    return { error: '--key-env names a variable, such as OPENROUTER_API_KEY' }
  return args
}
