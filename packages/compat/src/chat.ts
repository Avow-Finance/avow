/**
 * A model behind an OpenAI-compatible chat completions endpoint, such as OpenRouter, which serves
 * Claude, GPT and open-weight models under one API. The conversation stays in that wire form, since
 * every model the check runs speaks it.
 */

/** A tool as the model sees it, from the MCP server's list. */
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A tool call as the model wrote it. Its arguments are the model's raw text, untrusted. */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface Usage {
  promptTokens: number
  completionTokens: number
  /** Dollars, when the endpoint reports what the call cost, as OpenRouter does. */
  cost: number | null
}

export interface Completion {
  content: string
  calls: ToolCall[]
  usage: Usage | null
  /** The model the endpoint says answered, with its version, which can differ from the one asked. */
  served: string | null
}

export interface ChatModel {
  /** The model as the run asked for it. */
  readonly id: string
  complete(messages: readonly Message[], tools: readonly ToolDef[]): Promise<Completion>
}

/** An endpoint that answered with something other than a completion. */
export class ChatError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'

const ATTEMPTS = 4
const TIMEOUT_MS = 180_000

export interface OpenAiCompatibleOptions {
  baseUrl: string
  apiKey: string
  model: string
  fetch?: typeof fetch
  /** Milliseconds to wait before attempt n, from the second on. Tests make it zero. */
  backoff?: (attempt: number) => number
}

export function openAiCompatible(options: OpenAiCompatibleOptions): ChatModel {
  const { apiKey, model } = options
  const base = options.baseUrl.replace(/\/+$/, '')
  const send = options.fetch ?? fetch
  const backoff = options.backoff ?? ((n: number) => 2000 * 2 ** (n - 2))
  // OpenRouter reports each call's cost only when asked. Other endpoints may refuse the field.
  const reportsCost = new URL(base).hostname === 'openrouter.ai'
  // Nothing this module surfaces may carry the key, even an endpoint echoing it back.
  const scrub = (text: string) => (apiKey === '' ? text : text.split(apiKey).join('[key]'))

  async function once(body: string): Promise<Completion> {
    let response: Response
    try {
      response = await send(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'x-title': 'Avow compatibility check',
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new ChatError(
        scrub(`The endpoint isn't answering: ${error instanceof Error ? error.message : error}`),
        true,
      )
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new ChatError(
        scrub(`The endpoint answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`),
        response.status === 429 || response.status >= 500,
      )
    }
    return readCompletion(text, scrub)
  }

  return {
    id: model,
    async complete(messages, tools) {
      const body = JSON.stringify({
        model,
        messages,
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
        temperature: 0,
        ...(reportsCost ? { usage: { include: true } } : {}),
      })
      for (let attempt = 1; ; attempt++) {
        try {
          return await once(body)
        } catch (error) {
          if (!(error instanceof ChatError) || !error.retryable || attempt === ATTEMPTS) throw error
          await new Promise((resolve) => setTimeout(resolve, backoff(attempt + 1)))
        }
      }
    },
  }
}

/** Reads a completion where it enters, so the rest of the check holds only typed values. */
export function readCompletion(text: string, scrub: (s: string) => string = (s) => s): Completion {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ChatError(scrub(`The endpoint answered with no JSON: ${text.slice(0, 200)}`), true)
  }
  const root = record(parsed)
  // OpenRouter can answer 200 with an error from the model's own provider.
  const failed = record(root?.error)
  if (failed) {
    const code = typeof failed.code === 'number' ? failed.code : 0
    throw new ChatError(
      scrub(`The endpoint answered with an error: ${String(failed.message ?? 'no message')}`),
      code === 429 || code >= 500,
    )
  }
  const choice = record(Array.isArray(root?.choices) ? root.choices[0] : null)
  const message = record(choice?.message)
  if (!message)
    throw new ChatError(scrub(`The endpoint answered with no message: ${text.slice(0, 200)}`), true)
  const calls: ToolCall[] = []
  for (const [i, raw] of (Array.isArray(message.tool_calls) ? message.tool_calls : []).entries()) {
    const call = record(raw)
    const fn = record(call?.function)
    if (!fn || typeof fn.name !== 'string') continue
    calls.push({
      id: typeof call?.id === 'string' && call.id !== '' ? call.id : `call_${i + 1}`,
      name: fn.name,
      arguments:
        typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    })
  }
  const usage = record(root?.usage)
  return {
    content: typeof message.content === 'string' ? message.content : '',
    calls,
    usage: usage
      ? {
          promptTokens: count(usage.prompt_tokens),
          completionTokens: count(usage.completion_tokens),
          cost: typeof usage.cost === 'number' ? usage.cost : null,
        }
      : null,
    served: typeof root?.model === 'string' ? root.model : null,
  }
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
