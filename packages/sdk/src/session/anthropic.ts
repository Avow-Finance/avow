import {
  type ChatTurn,
  type ModelProvider,
  type ModelReply,
  type ModelToolCall,
  ProviderError,
  type ReplyRequest,
} from './provider.js'

/**
 * A Claude model through Anthropic's Messages API, with the developer's own key. Every call is
 * billed to that key, so the session runs it only when the developer chose it.
 */

/** The model the session asks for when the developer names none. */
export const ANTHROPIC_MODEL = 'claude-sonnet-5-5'

const API = 'https://api.anthropic.com/v1/messages'
const VERSION = '2023-06-01'
const MAX_TOKENS = 4096

/** One block of an assistant's message, as the API gives it and takes it back. */
type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

type Content =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

interface Message {
  role: 'user' | 'assistant'
  content: string | (Block | Content)[]
}

/**
 * The conversation in the API's form. Each assistant turn goes back exactly as it came, thinking
 * blocks and their signatures included, and the results of its tool calls go together in the next
 * user message, with anything the developer typed after them.
 */
function messagesOf(turns: readonly ChatTurn[]): Message[] {
  const out: Message[] = []
  let pending: Content[] = []
  const flush = () => {
    if (pending.length > 0) out.push({ role: 'user', content: pending })
    pending = []
  }
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      flush()
      const blocks = Array.isArray(turn.native)
        ? (turn.native as Block[])
        : [
            ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
            ...turn.calls.map((c) => ({
              type: 'tool_use' as const,
              id: c.id,
              name: c.name,
              input: c.input,
            })),
          ]
      out.push({ role: 'assistant', content: blocks })
    } else if (turn.role === 'tool') {
      pending.push({
        type: 'tool_result',
        tool_use_id: turn.call.id,
        content: turn.content,
        ...(turn.ok ? {} : { is_error: true }),
      })
    } else pending.push({ type: 'text', text: turn.text })
  }
  flush()
  return out
}

interface StreamEvent {
  type: string
  index?: number
  content_block?: Block & { input?: unknown }
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    thinking?: string
    signature?: string
    stop_reason?: string
  }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

/** A refusal from the API, said plainly, and whether trying again later can work. */
function refusalOf(status: number, body: string): ProviderError {
  let message = body.slice(0, 300)
  try {
    message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? message
  } catch {}
  if (status === 401) {
    return new ProviderError("Anthropic's API refused the key in ANTHROPIC_API_KEY.", false)
  }
  if (status === 404) {
    return new ProviderError(`Anthropic's API has no model by that name: ${message}`, false)
  }
  return new ProviderError(
    `Anthropic's API answered ${status}: ${message}`,
    status === 429 || status >= 500,
  )
}

/**
 * A Claude model, through the Messages API with tools and streaming. The key comes from the
 * environment the session runs in and goes only to Anthropic, in the request's header.
 */
export function anthropicProvider(options: {
  apiKey: string
  model?: string
  fetch?: typeof fetch
}): ModelProvider {
  const model = options.model ?? ANTHROPIC_MODEL
  const fetcher = options.fetch ?? fetch
  return {
    kind: 'anthropic',
    model,
    line: `${model} through your Anthropic key, billed to that key`,
    reaches: 'Anthropic',
    async reply(request: ReplyRequest): Promise<ModelReply> {
      const started = performance.now()
      const body = JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: request.system,
        messages: messagesOf(request.turns),
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        stream: true,
      })
      let response: Response | null = null
      // A rate limit or an overloaded API gets two more tries, a little apart.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await fetcher(API, {
            method: 'POST',
            headers: {
              'x-api-key': options.apiKey,
              'anthropic-version': VERSION,
              'content-type': 'application/json',
            },
            body,
            ...(request.signal ? { signal: request.signal } : {}),
          })
        } catch (error) {
          if (request.signal?.aborted) throw error
          throw new ProviderError("Anthropic's API didn't answer.", true, { cause: error })
        }
        if (response.ok) break
        const refused = refusalOf(response.status, await response.text().catch(() => ''))
        if (!refused.retryable || attempt === 2) throw refused
        await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)))
      }
      if (!response?.body) throw new ProviderError("Anthropic's API answered with no body.", true)

      const blocks: (Block & { json?: string })[] = []
      let text = ''
      let stop = 'end_turn'
      let tokens: number | null = null
      let firstTokenMs: number | null = null
      const handle = (event: StreamEvent) => {
        if (event.type === 'error') {
          const overloaded = event.error?.type === 'overloaded_error'
          throw new ProviderError(
            `Anthropic's API: ${event.error?.message ?? 'an error'}`,
            overloaded,
          )
        }
        if (
          event.type === 'content_block_start' &&
          event.content_block &&
          event.index !== undefined
        ) {
          const b = event.content_block
          blocks[event.index] = b.type === 'tool_use' ? { ...b, input: {}, json: '' } : { ...b }
        } else if (event.type === 'content_block_delta' && event.index !== undefined) {
          const b = blocks[event.index]
          const d = event.delta ?? {}
          if (firstTokenMs === null) firstTokenMs = performance.now() - started
          if (b?.type === 'text' && d.type === 'text_delta' && d.text) {
            b.text += d.text
            text += d.text
            request.onText(d.text)
          } else if (b?.type === 'tool_use' && d.type === 'input_json_delta') {
            b.json = (b.json ?? '') + (d.partial_json ?? '')
          } else if (b?.type === 'thinking' && d.type === 'thinking_delta') {
            b.thinking += d.thinking ?? ''
          } else if (b?.type === 'thinking' && d.type === 'signature_delta') {
            b.signature = (b.signature ?? '') + (d.signature ?? '')
          }
        } else if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) stop = event.delta.stop_reason
          if (event.usage?.output_tokens !== undefined) tokens = event.usage.output_tokens
        }
      }
      const decoder = new TextDecoder()
      let buffered = ''
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(bytes, { stream: true })
        let gap = buffered.indexOf('\n\n')
        while (gap >= 0) {
          const frame = buffered.slice(0, gap)
          buffered = buffered.slice(gap + 2)
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('')
          if (data) handle(JSON.parse(data) as StreamEvent)
          gap = buffered.indexOf('\n\n')
        }
      }

      const calls: ModelToolCall[] = []
      const native: Block[] = []
      for (const b of blocks) {
        if (!b) continue
        if (b.type === 'tool_use') {
          let input: unknown = {}
          try {
            input = b.json ? JSON.parse(b.json) : {}
          } catch {
            // Input that isn't JSON goes to the tool layer as it is, which refuses it.
            input = b.json
          }
          calls.push({ id: b.id, name: b.name, input })
          native.push({ type: 'tool_use', id: b.id, name: b.name, input })
        } else native.push(b)
      }
      return {
        text,
        calls,
        native,
        stop: stop === 'tool_use' ? 'tools' : stop === 'max_tokens' ? 'length' : 'end',
        timing: { firstTokenMs, tokens, generatingMs: null, totalMs: performance.now() - started },
      }
    },
  }
}
