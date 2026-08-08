/**
 * Produces a deterministic comparison form without changing the text shown to
 * readers. This intentionally normalizes only formatting and punctuation
 * variants that have equivalent textual meaning for paragraph matching.
 */
export function normalizeText(text: string) {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u3002/g, '.')
    .replace(/[\u3001]/g, ',')
    .replace(/\uFF1A/g, ':')
    .replace(/\uFF1B/g, ';')
    .replace(/\uFF01/g, '!')
    .replace(/\uFF1F/g, '?')
    .replace(/\uFF08/g, '(')
    .replace(/\uFF09/g, ')')
    .replace(/\u3010/g, '[')
    .replace(/\u3011/g, ']')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,.;:!?])/g, '$1')
    .trim()
}

/** FNV-1a over UTF-16 code units. It is deterministic and session-independent. */
export function hashText(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

export function createParagraphFingerprint(text: string) {
  return hashText(normalizeText(text))
}
