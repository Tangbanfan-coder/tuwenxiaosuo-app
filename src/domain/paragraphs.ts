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

const REPEATED_WRITING_MIN_LENGTH = 80
const REPEATED_WRITING_TAIL_LENGTH = 1_200

/**
 * Returns whether generated prose appears to be a copy of text that is
 * already in the chapter.  This is deliberately conservative: short output
 * and ordinary partial phrase reuse are allowed, while an exact long copy or
 * a long suffix copy is rejected.
 *
 * `replacedParagraphs` is used by regeneration, where the chapter contains
 * the old turn and the candidate is going to replace that turn.  A model can
 * otherwise return the complete old turn followed by its new text; adopting
 * that candidate would append the old turn twice.  The complete-prefix check
 * is kept here with the regular overlap rule so continuation and regeneration
 * share one comparison policy.
 */
export function hasWritingContentOverlap(
  existingChapterContent: string,
  generatedParagraphs: readonly string[],
  replacedParagraphs: readonly string[] = [],
) {
  const existing = normalizeText(existingChapterContent)
  const generated = normalizeText(generatedParagraphs.join('\n\n'))
  const tail = existing.slice(-Math.min(existing.length, REPEATED_WRITING_TAIL_LENGTH))

  const longCopy = generated.length >= REPEATED_WRITING_MIN_LENGTH
    && (existing.includes(generated) || tail.length >= REPEATED_WRITING_MIN_LENGTH && generated.includes(tail))

  if (longCopy) return true

  // A long replaced turn is an unambiguous copy even when the model puts a
  // short preface before it.  Require extra text as well, so an unchanged
  // candidate remains a valid (if unhelpful) alternative rather than being
  // rejected by this guard alone.
  const replaced = normalizeText(replacedParagraphs.join('\n\n'))
  if (replaced.length >= REPEATED_WRITING_MIN_LENGTH) {
    return generated.length > replaced.length && generated.includes(replaced)
  }

  // Short replaced turns only trigger when they are a complete prefix.  This
  // avoids treating a normal candidate that happens to reuse a brief phrase
  // as a duplicate.
  if (!replacedParagraphs.length) return false
  return replaced.length > 0 && generated.length > replaced.length && generated.startsWith(replaced)
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
