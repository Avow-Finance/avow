import type { ToolSpec } from './tools.js'

/**
 * One interface for every model the session can talk to. The session keeps the conversation in
 * this neutral shape and each provider maps it to its own wire form, so the tool layer, the
 * executor and the eval never depend on which model is speaking.
 */

/** The providers the session knows, as `--provider` names them. */
export const PROVIDER_KINDS = ['local', 'anthropic', 'scripted'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

/** A tool call a model asked for, with the id its provider pairs the result by. */
export interface ModelToolCall {
  id: string
  name: string
  /** The model's input as its provider parsed it. It's untrusted until the tool layer reads it. */
  input: unknown
}

/** One turn of the conversation, as the session replays it to the provider. */
export type ChatTurn =
  | { role: 'user'; text: string }
  | {
      role: 'assistant'
      text: string
      calls: readonly ModelToolCall[]
      /** What the provider needs to replay the turn exactly, such as Anthropic's content blocks. */
      native: unknown
    }
  | { role: 'tool'; call: ModelToolCall; content: string; ok: boolean }

/** What one model turn gave back. */
export interface ModelReply {
  text: string
  calls: ModelToolCall[]
  native: unknown
  /** Whether the model ended its turn, asked for tools, or ran out of room. */
  stop: 'end' | 'tools' | 'length'
  /** Timings for the eval's speed report, when the provider measures them. */
  timing: ReplyTiming | null
}

export interface ReplyTiming {
  /** Milliseconds from the request to the first piece of the reply. */
  firstTokenMs: number | null
  /** Tokens the model generated, and the milliseconds it spent generating them. */
  tokens: number | null
  generatingMs: number | null
  totalMs: number
}

export interface ReplyRequest {
  system: string
  turns: readonly ChatTurn[]
  tools: readonly ToolSpec[]
  /** Each piece of the model's words as it arrives, for the terminal to draw. */
  onText: (piece: string) => void
  signal?: AbortSignal
}

export interface ModelProvider {
  readonly kind: ProviderKind
  /** The model's id, which names every line it speaks. */
  readonly model: string
  /** The line the session shows before the first call: the model, where it runs and who pays. */
  readonly line: string
  /** Whether the conversation leaves this machine, and for whom. */
  readonly reaches: 'this machine' | 'Anthropic'
  reply(request: ReplyRequest): Promise<ModelReply>
}

/** A provider that failed, with what the developer can do about it. */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** Whether asking again later can work, as after a rate limit or a model still loading. */
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ProviderError'
  }
}
