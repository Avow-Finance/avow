/**
 * Data the session hands its own processes, as JSON that keeps every bigint a bigint. Only the
 * session writes it, so it's read back as it was written. What a process hands back is read by a
 * parser of its own, never this.
 */

const BIG = '$bigint'

export function encodeData(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? { [BIG]: v.toString() } : v))
}

export function decodeData(text: string): unknown {
  return JSON.parse(text, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v)
      if (keys.length === 1 && keys[0] === BIG && typeof v[BIG] === 'string') return BigInt(v[BIG])
    }
    return v
  })
}
