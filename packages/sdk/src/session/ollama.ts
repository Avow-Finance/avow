import {
  type ChatTurn,
  type ModelProvider,
  type ModelReply,
  type ModelToolCall,
  ProviderError,
  type ReplyRequest,
} from './provider.js'

/**
 * A model running on this machine through Ollama. Nothing leaves the machine and nothing is
 * billed, so it's the only kind of model the session picks without being asked.
 */

/** Where Ollama listens by default. */
export const OLLAMA_URL = 'http://127.0.0.1:11434'

/** The local models the session supports, in the order it picks one that's pulled. */
export const SUPPORTED_LOCAL_MODELS = ['qwen3:8b', 'llama3.1:8b', 'qwen3:4b'] as const

/** Room for the system prompt, the tools and a job's results, which Ollama's default cuts short. */
const CONTEXT_TOKENS = 16_384

/**
 * The models Ollama has pulled, or null when it isn't answering. It asks only this machine and
 * gives up after two seconds.
 */
export async function localModels(
  base = OLLAMA_URL,
  fetcher: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const response = await fetcher(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return null
    const body = (await response.json()) as { models?: { name?: unknown }[] }
    return (body.models ?? []).flatMap((m) => (typeof m.name === 'string' ? [m.name] : []))
  } catch {
    return null
  }
}

/** What Ollama says a model can do, such as `tools` and `thinking`, or null when it can't say. */
export async function localCapabilities(
  model: string,
  base = OLLAMA_URL,
  fetcher: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const response = await fetcher(`${base}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { capabilities?: unknown }
    return Array.isArray(body.capabilities)
      ? body.capabilities.filter((c): c is string => typeof c === 'string')
      : null
  } catch {
    return null
  }
}

/** An Ollama model name matches a supported one with or without its `:latest` tag. */
export const sameLocalModel = (a: string, b: string) =>
  a.replace(/:latest$/, '') === b.replace(/:latest$/, '')

interface OllamaCall {
  function: { name: string; arguments: unknown }
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaCall[]
  tool_name?: string
}

/** The conversation in Ollama's form. */
function messagesOf(system: string, turns: readonly ChatTurn[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: system }]
  for (const turn of turns) {
    if (turn.role === 'user') out.push({ role: 'user', content: turn.text })
    else if (turn.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: turn.text,
        ...(turn.calls.length > 0
          ? {
              tool_calls: turn.calls.map((c) => ({
                function: { name: c.name, arguments: c.input },
              })),
            }
          : {}),
      })
    } else out.push({ role: 'tool', content: turn.content, tool_name: turn.call.name })
  }
  return out
}

/** One line of Ollama's streamed answer, as far as the session reads it. */
interface Chunk {
  error?: string
  message?: { content?: string; tool_calls?: OllamaCall[] }
  done?: boolean
  done_reason?: string
  eval_count?: number
  eval_duration?: number
}

/**
 * A model Ollama runs, through `/api/chat` with tools and streaming. A model that thinks before
 * answering is asked not to, since the tool loop is what's measured and thinking only slows it.
 */
export function localProvider(options: {
  model: string
  thinks: boolean
  base?: string
  fetch?: typeof fetch
}): ModelProvider {
  const base = options.base ?? OLLAMA_URL
  const fetcher = options.fetch ?? fetch
  const { model } = options
  return {
    kind: 'local',
    model,
    line: `${model} through Ollama on this machine, no charge`,
    reaches: 'this machine',
    async reply(request: ReplyRequest): Promise<ModelReply> {
      const started = performance.now()
      let response: Response
      try {
        response = await fetcher(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: messagesOf(request.system, request.turns),
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            stream: true,
            ...(options.thinks ? { think: false } : {}),
            options: { num_ctx: CONTEXT_TOKENS },
          }),
          ...(request.signal ? { signal: request.signal } : {}),
        })
      } catch (error) {
        if (request.signal?.aborted) throw error
        throw new ProviderError(
          `Ollama isn't answering at ${base}. Open the Ollama app or run ollama serve, then try again.`,
          true,
          { cause: error },
        )
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '')
        if (response.status === 404) {
          throw new ProviderError(
            `Ollama has no model ${model}. Pull it with ollama pull ${model}.`,
            false,
          )
        }
        throw new ProviderError(
          `Ollama answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
          response.status >= 500,
        )
      }
      let text = ''
      const calls: ModelToolCall[] = []
      let firstTokenMs: number | null = null
      let done: Chunk | null = null
      const decoder = new TextDecoder()
      let buffered = ''
      const take = (line: string) => {
        if (!line.trim()) return
        const chunk = JSON.parse(line) as Chunk
        if (chunk.error) throw new ProviderError(`Ollama: ${chunk.error}`, false)
        const piece = chunk.message?.content ?? ''
        const asked = chunk.message?.tool_calls ?? []
        if ((piece || asked.length > 0) && firstTokenMs === null) {
          firstTokenMs = performance.now() - started
        }
        if (piece) {
          text += piece
          request.onText(piece)
        }
        for (const c of asked) {
          calls.push({
            id: `call_${calls.length + 1}`,
            name: c.function.name,
            input: c.function.arguments,
          })
        }
        if (chunk.done) done = chunk
      }
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(bytes, { stream: true })
        let newline = buffered.indexOf('\n')
        while (newline >= 0) {
          take(buffered.slice(0, newline))
          buffered = buffered.slice(newline + 1)
          newline = buffered.indexOf('\n')
        }
      }
      take(buffered)
      const finished = done as Chunk | null
      return {
        text,
        calls,
        native: null,
        stop: calls.length > 0 ? 'tools' : finished?.done_reason === 'length' ? 'length' : 'end',
        timing: {
          firstTokenMs,
          tokens: finished?.eval_count ?? null,
          generatingMs:
            finished?.eval_duration === undefined ? null : finished.eval_duration / 1_000_000,
          totalMs: performance.now() - started,
        },
      }
    },
  }
}
