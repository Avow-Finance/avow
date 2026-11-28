import { OPENROUTER_URL } from './chat.js'
import { DEFAULT_TRIALS } from './run.js'

/** The run's flags, read where they enter. */
export interface CompatArgs {
  models: string[]
  baseUrl: string
  keyEnv: string
  out: string
  trials: number
}

export function readArgs(argv: readonly string[]): CompatArgs | { error: string } {
  const args: CompatArgs = {
    models: [],
    baseUrl: OPENROUTER_URL,
    keyEnv: 'OPENROUTER_API_KEY',
    out: 'compat-results',
    trials: DEFAULT_TRIALS,
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
    else if (flag === '--trials') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1 || n > 10)
        return { error: '--trials is a whole number from 1 to 10' }
      args.trials = n
    } else return { error: `Unknown flag ${flag}` }
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
