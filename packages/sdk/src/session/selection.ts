import { ANTHROPIC_MODEL, anthropicProvider } from './anthropic.js'
import {
  localCapabilities,
  localModels,
  localProvider,
  OLLAMA_URL,
  SUPPORTED_LOCAL_MODELS,
  sameLocalModel,
} from './ollama.js'
import { type ModelProvider, PROVIDER_KINDS } from './provider.js'
import { scriptedProvider } from './scripted.js'

/**
 * Picks the model the session talks to, so nobody is surprised by a bill. An explicit choice wins,
 * and when it can't be used it stays a visible failure and nothing switches. With nothing explicit,
 * only a free model on this machine is picked: Ollama, running, with a supported model pulled. A
 * paid provider runs only once it's chosen, so a key in the environment is never enough. Nothing
 * falls back to the scripted decisions without being asked.
 */

export interface SelectionInput {
  /** `--provider`, or `AVOW_MODEL_PROVIDER`. */
  provider: string | null
  /** `--model`, or `AVOW_MODEL`. */
  model: string | null
  /** `--scripted`. */
  scripted: boolean
  /** The environment, for the Anthropic key, which is only ever read from there. */
  env: Readonly<Record<string, string | undefined>>
  ollamaUrl?: string
  fetch?: typeof fetch
}

export type Selection =
  | { ok: true; provider: ModelProvider; chosen: 'explicit' | 'automatic' }
  | { ok: false; why: string; help: string[] }

/** How to get a model, said when none is ready. */
function helpLines(env: SelectionInput['env']): string[] {
  return [
    `Install Ollama from https://ollama.com, then pull a supported model with ollama pull ${SUPPORTED_LOCAL_MODELS[0]}. It runs on this machine at no charge.`,
    `Or choose Claude with --provider anthropic and ANTHROPIC_API_KEY set in your environment. Each call is billed to that key.${env.ANTHROPIC_API_KEY ? ' The key is set, but the session uses it only when you choose it.' : ''}`,
    'Or run the scripted decisions, the same every run, with --scripted.',
  ]
}

async function local(
  model: string | null,
  explicit: boolean,
  input: SelectionInput,
): Promise<Selection> {
  const base = input.ollamaUrl ?? OLLAMA_URL
  const pulled = await localModels(base, input.fetch)
  if (pulled === null) {
    return {
      ok: false,
      why: explicit
        ? `You chose Ollama, and it isn't answering at ${base}. Open the Ollama app or run ollama serve.`
        : 'No model is ready for the session.',
      help: explicit ? [] : helpLines(input.env),
    }
  }
  const name = model
    ? pulled.find((p) => sameLocalModel(p, model))
    : SUPPORTED_LOCAL_MODELS.map((s) => pulled.find((p) => sameLocalModel(p, s))).find(Boolean)
  if (!name) {
    return model
      ? {
          ok: false,
          why: `Ollama has no model ${model}. Pull it with ollama pull ${model}.`,
          help: [],
        }
      : {
          ok: false,
          why: `Ollama is running with none of the supported models pulled: ${SUPPORTED_LOCAL_MODELS.join(', ')}.`,
          help: helpLines(input.env),
        }
  }
  const capabilities = await localCapabilities(name, base, input.fetch)
  if (capabilities && !capabilities.includes('tools')) {
    return { ok: false, why: `${name} can't call tools, which the session needs.`, help: [] }
  }
  return {
    ok: true,
    provider: localProvider({
      model: name,
      thinks: capabilities?.includes('thinking') ?? false,
      base,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }),
    chosen: explicit ? 'explicit' : 'automatic',
  }
}

export async function selectProvider(input: SelectionInput): Promise<Selection> {
  if (input.scripted) {
    if (input.provider && input.provider !== 'scripted') {
      return {
        ok: false,
        why: `--scripted and --provider ${input.provider} can't both be chosen.`,
        help: [],
      }
    }
    return { ok: true, provider: scriptedProvider(), chosen: 'explicit' }
  }
  const kind = input.provider
  if (kind === null) return local(input.model, input.model !== null, input)
  switch (kind) {
    case 'local':
      return local(input.model, true, input)
    case 'scripted':
      return { ok: true, provider: scriptedProvider(), chosen: 'explicit' }
    case 'anthropic': {
      const apiKey = input.env.ANTHROPIC_API_KEY
      if (!apiKey) {
        return {
          ok: false,
          why: "You chose Anthropic, and ANTHROPIC_API_KEY isn't set in this environment. Set it there, and the session reads it from there only.",
          help: [],
        }
      }
      return {
        ok: true,
        provider: anthropicProvider({
          apiKey,
          model: input.model ?? ANTHROPIC_MODEL,
          ...(input.fetch ? { fetch: input.fetch } : {}),
        }),
        chosen: 'explicit',
      }
    }
    default:
      return {
        ok: false,
        why: `There's no provider ${kind}. Choose one of ${PROVIDER_KINDS.join(', ')}.`,
        help: [],
      }
  }
}
