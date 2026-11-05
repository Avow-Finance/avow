import { describe, expect, it } from 'vitest'
import { anthropicProvider } from './anthropic.js'
import { localProvider } from './ollama.js'
import { type ChatTurn, ProviderError } from './provider.js'
import { selectProvider } from './selection.js'
import { toolSpecs } from './tools.js'

/** A response whose body arrives in the pieces given, as a stream does. */
function streamed(pieces: string[], status = 200): Response {
  const bytes = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const p of pieces) controller.enqueue(bytes.encode(p))
        controller.close()
      },
    }),
    { status },
  )
}

/** A fetch that answers once with `answer`, recording each request. */
function fakeFetch(answer: (url: string) => Response) {
  const asked: { url: string; init: RequestInit }[] = []
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    asked.push({ url: String(url), init })
    return answer(String(url))
  }) as typeof fetch
  return { fetcher, asked, body: (i = 0) => JSON.parse(String(asked[i]?.init.body)) }
}

const turns: ChatTurn[] = [
  { role: 'user', text: 'New order 1.' },
  {
    role: 'assistant',
    text: '',
    calls: [{ id: 'call_1', name: 'read_order', input: {} }],
    native: null,
  },
  { role: 'tool', call: { id: 'call_1', name: 'read_order', input: {} }, content: '{}', ok: true },
]

describe('a local model through Ollama', () => {
  it('streams words and tool calls, and asks a thinking model not to think', async () => {
    const lines = [
      { message: { content: 'Book' } },
      { message: { content: 'ing.' } },
      {
        message: {
          content: '',
          tool_calls: [{ function: { name: 'compute_offers', arguments: {} } }],
        },
      },
      { done: true, done_reason: 'stop', eval_count: 12, eval_duration: 600_000_000 },
    ]
    const raw = lines.map((l) => `${JSON.stringify(l)}\n`).join('')
    const f = fakeFetch(() => streamed([raw.slice(0, 20), raw.slice(20, 70), raw.slice(70)]))
    const pieces: string[] = []
    const provider = localProvider({ model: 'qwen3:8b', thinks: true, fetch: f.fetcher })
    const reply = await provider.reply({
      system: 'You book compute.',
      turns,
      tools: toolSpecs('on'),
      onText: (p) => pieces.push(p),
    })
    expect(reply).toMatchObject({
      text: 'Booking.',
      calls: [{ name: 'compute_offers', input: {} }],
      stop: 'tools',
      timing: { tokens: 12, generatingMs: 600 },
    })
    expect(pieces).toEqual(['Book', 'ing.'])
    expect(provider.line).toBe('qwen3:8b through Ollama on this machine, no charge')
    expect(f.asked[0]?.url).toBe('http://127.0.0.1:11434/api/chat')
    const body = f.body()
    expect(body).toMatchObject({ model: 'qwen3:8b', stream: true, think: false })
    expect(body.messages).toEqual([
      { role: 'system', content: 'You book compute.' },
      { role: 'user', content: 'New order 1.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'read_order', arguments: {} } }],
      },
      { role: 'tool', content: '{}', tool_name: 'read_order' },
    ])
    expect(body.tools).toHaveLength(7)
    // A model that doesn't think gets no such option.
    const plain = fakeFetch(() => streamed([`${JSON.stringify({ done: true })}\n`]))
    await localProvider({ model: 'llama3.1:8b', thinks: false, fetch: plain.fetcher }).reply({
      system: '',
      turns,
      tools: [],
      onText: () => {},
    })
    expect(plain.body()).not.toHaveProperty('think')
  })

  it('says how to pull a model Ollama lacks, and that Ollama is down when it is', async () => {
    const missing = fakeFetch(() => new Response('{"error":"model not found"}', { status: 404 }))
    await expect(
      localProvider({ model: 'qwen3:8b', thinks: false, fetch: missing.fetcher }).reply({
        system: '',
        turns,
        tools: [],
        onText: () => {},
      }),
    ).rejects.toThrow('Pull it with ollama pull qwen3:8b')
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    await expect(
      localProvider({ model: 'qwen3:8b', thinks: false, fetch: down }).reply({
        system: '',
        turns,
        tools: [],
        onText: () => {},
      }),
    ).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('Claude through the Messages API', () => {
  const frames = [
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Firm first.' },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Booking h100-firm.' },
    },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'book_compute', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"offer":"h100-' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: 'firm","quantity":1}' },
    },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ]
  const sse = frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('')

  it('streams words and a tool call, and keeps the thinking block to send back as it came', async () => {
    const f = fakeFetch(() => streamed([sse.slice(0, 100), sse.slice(100)]))
    const provider = anthropicProvider({ apiKey: 'test-key', fetch: f.fetcher })
    const reply = await provider.reply({
      system: 'S',
      turns,
      tools: toolSpecs('on'),
      onText: () => {},
    })
    expect(reply).toMatchObject({
      text: 'Booking h100-firm.',
      calls: [{ id: 'toolu_1', name: 'book_compute', input: { offer: 'h100-firm', quantity: 1 } }],
      stop: 'tools',
      timing: { tokens: 40 },
    })
    expect(reply.native).toEqual([
      { type: 'thinking', thinking: 'Firm first.', signature: 'sig' },
      { type: 'text', text: 'Booking h100-firm.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'book_compute',
        input: { offer: 'h100-firm', quantity: 1 },
      },
    ])
    expect(provider.line).toBe('claude-sonnet-5-5 through your Anthropic key, billed to that key')
    const headers = new Headers(f.asked[0]?.init.headers)
    expect(headers.get('x-api-key')).toBe('test-key')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    const body = f.body()
    expect(body).not.toHaveProperty('temperature')
    expect(body.tools[0]).toHaveProperty('input_schema')
    // The tool's result goes back in a user message after the turn that called it.
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{}' }],
    })

    // Replayed, the turn goes back exactly as it came.
    const next = fakeFetch(() => streamed([sse]))
    await anthropicProvider({ apiKey: 'k', fetch: next.fetcher }).reply({
      system: 'S',
      turns: [
        ...turns,
        { role: 'assistant', text: reply.text, calls: reply.calls, native: reply.native },
      ],
      tools: [],
      onText: () => {},
    })
    expect(next.body().messages.at(-1)).toEqual({ role: 'assistant', content: reply.native })
  })

  it('says plainly when the key is refused', async () => {
    const refused = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }),
    )
    await expect(
      anthropicProvider({ apiKey: 'bad', fetch: refused.fetcher }).reply({
        system: '',
        turns,
        tools: [],
        onText: () => {},
      }),
    ).rejects.toThrow("Anthropic's API refused the key in ANTHROPIC_API_KEY.")
  })
})

describe('choosing the model', () => {
  /** An Ollama that has these models pulled, each able to call tools, or none answering. */
  const ollama = (pulled: string[] | null, capabilities = ['completion', 'tools']) =>
    (async (url: string | URL | Request) => {
      if (pulled === null) throw new TypeError('fetch failed')
      if (String(url).endsWith('/api/tags')) {
        return Response.json({ models: pulled.map((name) => ({ name })) })
      }
      return Response.json({ capabilities })
    }) as typeof fetch
  const base = { provider: null, model: null, scripted: false, env: {} }

  it('picks only a supported model pulled on this machine on its own', async () => {
    const picked = await selectProvider({ ...base, fetch: ollama(['llama3.1:8b', 'qwen3:8b']) })
    expect(picked).toMatchObject({
      ok: true,
      chosen: 'automatic',
      provider: { kind: 'local', model: 'qwen3:8b' },
    })
    const none = await selectProvider({ ...base, fetch: ollama(['mistral:7b']) })
    expect(none).toMatchObject({ ok: false })
  })

  it('never turns to a paid model unless it was chosen, whatever the environment holds', async () => {
    const env = { ANTHROPIC_API_KEY: 'sk-test' }
    const picked = await selectProvider({ ...base, env, fetch: ollama(null) })
    if (picked.ok) throw new Error('nothing should be picked')
    expect(picked.why).toBe('No model is ready for the session.')
    expect(picked.help.join(' ')).toContain(
      'The key is set, but the session uses it only when you choose it.',
    )
    expect(picked.help.join(' ')).toContain('--scripted')
    const chosen = await selectProvider({
      ...base,
      env,
      provider: 'anthropic',
      fetch: ollama(null),
    })
    expect(chosen).toMatchObject({ ok: true, chosen: 'explicit', provider: { kind: 'anthropic' } })
  })

  it('keeps an explicit choice that fails a failure, and switches to nothing else', async () => {
    const noKey = await selectProvider({
      ...base,
      provider: 'anthropic',
      fetch: ollama(['qwen3:8b']),
    })
    expect(noKey).toMatchObject({ ok: false, help: [] })
    const notPulled = await selectProvider({
      ...base,
      provider: 'local',
      model: 'qwen3:4b',
      fetch: ollama(['qwen3:8b']),
    })
    expect(notPulled).toMatchObject({
      ok: false,
      why: 'Ollama has no model qwen3:4b. Pull it with ollama pull qwen3:4b.',
    })
    const noTools = await selectProvider({
      ...base,
      provider: 'local',
      fetch: ollama(['qwen3:8b'], ['completion']),
    })
    expect(noTools).toMatchObject({
      ok: false,
      why: "qwen3:8b can't call tools, which the session needs.",
    })
    const unknown = await selectProvider({
      ...base,
      provider: 'hosted',
      fetch: ollama(['qwen3:8b']),
    })
    expect(unknown).toMatchObject({ ok: false })
  })

  it('runs the scripted decisions only when asked for them', async () => {
    const scripted = await selectProvider({ ...base, scripted: true, fetch: ollama(null) })
    expect(scripted).toMatchObject({ ok: true, provider: { kind: 'scripted', model: 'scripted' } })
  })
})
