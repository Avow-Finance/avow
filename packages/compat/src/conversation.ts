import type { ChatModel, Message, ToolDef, Usage } from './chat.js'

/** What answers the model's tool calls: the MCP server in a run, a fake world in tests. */
export interface Toolbox {
  readonly tools: readonly ToolDef[]
  /** What the server tells every client it starts in, which the model hears first. */
  readonly instructions: string
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>
}

export interface ToolResult {
  text: string
  structured: Record<string, unknown> | null
  isError: boolean
}

/** One tool call the model made, in the user turn it made it in. */
export interface Step {
  turn: number
  name: string
  /** Null when the model's arguments weren't a JSON object, and then nothing was called. */
  args: Record<string, unknown> | null
  result: ToolResult
}

export interface Transcript {
  steps: Step[]
  /** The model's last words in each user turn, in order. */
  answers: string[]
  /** Why the conversation ended early, or null when the model answered every turn. */
  stopped: string | null
  usage: Usage
  served: string[]
}

export interface ConverseOptions {
  model: ChatModel
  toolbox: Toolbox
  system: string
  /** What the person says, one turn each, every one after the model answered the one before. */
  asks: readonly string[]
  /** The most model calls the whole conversation may take. */
  maxCalls: number
}

/** Runs one conversation and records every call, answer and refusal in it, for code to grade. */
export async function converse(o: ConverseOptions): Promise<Transcript> {
  const messages: Message[] = [{ role: 'system', content: o.system }]
  const t: Transcript = {
    steps: [],
    answers: [],
    stopped: null,
    usage: { promptTokens: 0, completionTokens: 0, cost: 0 },
    served: [],
  }
  const known = new Set(o.toolbox.tools.map((tool) => tool.name))
  let calls = 0
  try {
    for (const [turn, ask] of o.asks.entries()) {
      messages.push({ role: 'user', content: ask })
      for (;;) {
        if (calls === o.maxCalls) {
          t.stopped = `reached ${o.maxCalls} model calls`
          return t
        }
        calls++
        const reply = await o.model.complete(messages, o.toolbox.tools)
        add(t, reply.usage)
        if (reply.served && !t.served.includes(reply.served)) t.served.push(reply.served)
        if (reply.calls.length === 0) {
          messages.push({ role: 'assistant', content: reply.content })
          t.answers.push(reply.content)
          break
        }
        messages.push({
          role: 'assistant',
          content: reply.content === '' ? null : reply.content,
          tool_calls: reply.calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        })
        for (const c of reply.calls) {
          const args = argsOf(c.arguments)
          const result: ToolResult =
            args === null
              ? { text: 'The arguments have to be a JSON object.', structured: null, isError: true }
              : !known.has(c.name)
                ? { text: `There is no tool named ${c.name}.`, structured: null, isError: true }
                : await o.toolbox.call(c.name, args).catch(
                    (error: unknown): ToolResult => ({
                      text: error instanceof Error ? error.message : String(error),
                      structured: null,
                      isError: true,
                    }),
                  )
          t.steps.push({ turn, name: c.name, args, result })
          messages.push({ role: 'tool', tool_call_id: c.id, content: result.text })
        }
      }
    }
  } catch (error) {
    t.stopped = error instanceof Error ? error.message : String(error)
  }
  return t
}

function argsOf(raw: string): Record<string, unknown> | null {
  try {
    // Some models send an empty string for a tool that takes nothing.
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function add(t: Transcript, u: Usage | null) {
  if (!u) return
  t.usage.promptTokens += u.promptTokens
  t.usage.completionTokens += u.completionTokens
  // A total stays known only while every call reported its cost.
  t.usage.cost = t.usage.cost === null || u.cost === null ? null : t.usage.cost + u.cost
}
