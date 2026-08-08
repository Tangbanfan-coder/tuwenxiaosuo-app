import type { Foreshadowing, SceneNotes, WritingSceneNotes } from './models'
import { normalizeText } from './paragraphs'

/** Formatting-only comparison form for the legacy text compatibility path. */
export function normalizeForeshadowingText(value: string) {
  return normalizeText(value).toLocaleLowerCase()
}

export function createForeshadowing(text: string): Foreshadowing {
  return {
    id: `foreshadowing-${crypto.randomUUID()}`,
    text: text.trim(),
  }
}

function normalizedForeshadowing(record: Foreshadowing): Foreshadowing | undefined {
  const id = record.id.trim()
  const text = record.text.trim()
  if (!id || !text) return undefined
  const aliases = record.aliases?.map((alias) => alias.trim()).filter(Boolean)
  return aliases?.length ? { id, text, aliases } : { id, text }
}

function uniqueIds(ids: readonly string[]) {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const id of ids) {
    const normalized = id.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
  }
  return unique
}

/** Returns the currently open records using only durable resolution ids. */
export function collectOpenForeshadowings(notesList: Iterable<SceneNotes>) {
  const open = new Map<string, Foreshadowing>()
  for (const notes of notesList) {
    for (const record of notes.foreshadowingPlanted) {
      const normalized = normalizedForeshadowing(record)
      if (normalized) open.set(normalized.id, normalized)
    }
    for (const id of uniqueIds(notes.resolvedForeshadowingIds)) open.delete(id)
  }
  return open
}

/**
 * Legacy text can resolve a record only when formatting-normalized text (or an
 * explicit alias) identifies exactly one currently open record.
 */
export function findUniqueLegacyForeshadowingMatch(records: Iterable<Foreshadowing>, legacyText: string) {
  const target = normalizeForeshadowingText(legacyText)
  if (!target) return undefined

  const matches = new Map<string, Foreshadowing>()
  for (const record of records) {
    const candidates = [record.text, ...(record.aliases ?? [])]
    if (candidates.some((candidate) => normalizeForeshadowingText(candidate) === target)) {
      matches.set(record.id, record)
    }
  }
  return matches.size === 1 ? matches.values().next().value : undefined
}

export interface ForeshadowingReconciliationInput {
  foreshadowingPlanted: Foreshadowing[]
  resolvedForeshadowingIds: string[]
  legacyResolvedForeshadowingTexts?: string[]
}

export interface ForeshadowingReconciliationResult {
  foreshadowingPlanted: Foreshadowing[]
  resolvedForeshadowingIds: string[]
  legacyUnmatchedResolvedForeshadowingTexts?: string[]
}

/**
 * Accepts only known stable ids on the main path. Text matching is restricted
 * to legacy responses and only succeeds for one exact normalized candidate.
 */
export function reconcileForeshadowing(
  priorNotes: Iterable<SceneNotes>,
  input: ForeshadowingReconciliationInput,
): ForeshadowingReconciliationResult {
  const foreshadowingPlanted = input.foreshadowingPlanted
    .map(normalizedForeshadowing)
    .filter((record): record is Foreshadowing => Boolean(record))
  const active = collectOpenForeshadowings(priorNotes)

  // This also supports migration of a legacy scene that happened to plant and
  // resolve the same text in its own notes. New model output cannot know ids
  // created here because the application assigns them after parsing.
  for (const record of foreshadowingPlanted) active.set(record.id, record)

  const resolved = new Set<string>()
  for (const id of uniqueIds(input.resolvedForeshadowingIds)) {
    if (!active.has(id)) continue
    resolved.add(id)
    active.delete(id)
  }

  const unmatchedLegacyTexts: string[] = []
  const resolvedLegacyTextIds = new Map<string, string>()
  for (const legacyText of input.legacyResolvedForeshadowingTexts ?? []) {
    const normalized = normalizeForeshadowingText(legacyText)
    if (!normalized) continue
    const previouslyResolvedId = resolvedLegacyTextIds.get(normalized)
    if (previouslyResolvedId) {
      resolved.add(previouslyResolvedId)
      continue
    }
    const match = findUniqueLegacyForeshadowingMatch(active.values(), legacyText)
    if (!match) {
      unmatchedLegacyTexts.push(legacyText)
      continue
    }
    resolvedLegacyTextIds.set(normalized, match.id)
    resolved.add(match.id)
    active.delete(match.id)
  }

  return {
    foreshadowingPlanted,
    resolvedForeshadowingIds: Array.from(resolved),
    ...(unmatchedLegacyTexts.length ? { legacyUnmatchedResolvedForeshadowingTexts: unmatchedLegacyTexts } : {}),
  }
}

/** Materializes model output into durable scene notes and assigns new ids locally. */
export function materializeWritingSceneNotes(notes: WritingSceneNotes, priorNotes: Iterable<SceneNotes>): SceneNotes {
  const reconciliation = reconcileForeshadowing(priorNotes, {
    foreshadowingPlanted: notes.newForeshadowingTexts
      .map((text) => text.trim())
      .filter(Boolean)
      .map(createForeshadowing),
    resolvedForeshadowingIds: notes.resolvedForeshadowingIds,
    legacyResolvedForeshadowingTexts: notes.legacyResolvedForeshadowingTexts,
  })
  return {
    time: notes.time,
    location: notes.location,
    povCharacter: notes.povCharacter,
    charactersPresent: notes.charactersPresent,
    events: notes.events,
    stateChanges: notes.stateChanges,
    relationshipChanges: notes.relationshipChanges,
    knowledgeChanges: notes.knowledgeChanges,
    unresolvedThreads: notes.unresolvedThreads,
    ...reconciliation,
  }
}
