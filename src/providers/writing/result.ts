import type { NarrativePronoun, VisualPlan, WritingCharacterPlan, WritingSceneNotes, WritingTurnResult } from '../../domain/models'

interface RawWritingResult {
  assistant_note?: unknown
  chapter_action?: unknown
  prose?: {
    chapter_title?: unknown
    paragraphs?: unknown
  }
  chapter_summary?: unknown
  scene_notes?: {
    time?: unknown
    location?: unknown
    pov_character?: unknown
    characters_present?: unknown
    events?: unknown
    state_changes?: unknown
    relationship_changes?: unknown
    knowledge_changes?: unknown
    new_foreshadowing_texts?: unknown
    resolved_foreshadowing_ids?: unknown
    /** Compatibility with model responses produced before stable ids existed. */
    clues_planted?: unknown
    clues_resolved?: unknown
    unresolved_threads?: unknown
  } | null
  visual_plan?: {
    title?: unknown
    prompt?: unknown
    style_prompt?: unknown
    negative_prompt?: unknown
    action?: unknown
    body_language?: unknown
    expression?: unknown
    gaze?: unknown
    camera?: unknown
    motion?: unknown
    scene_anchor?: {
      key?: unknown
      location?: unknown
      time_period?: unknown
      fixed_elements?: unknown
      lighting?: unknown
      palette?: unknown
    } | null
    characters?: unknown
  } | null
}

export function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []
}

function normalizeNarrativePronoun(value: unknown): NarrativePronoun {
  const pronoun = stringValue(value).toLocaleLowerCase()
  return pronoun === 'she' || pronoun === 'he' || pronoun === 'ta' || pronoun === 'name'
    ? pronoun
    : 'name'
}

function normalizeCharacter(value: unknown): WritingCharacterPlan | null {
  if (!value || typeof value !== 'object') return null
  const character = value as Record<string, unknown>
  const name = stringValue(character.name)
  if (!name) return null
  return {
    name,
    role: stringValue(character.role) || '角色',
    narrativePronoun: normalizeNarrativePronoun(character.narrative_pronoun ?? character.narrativePronoun),
    ageAndBuild: stringValue(character.age_and_build),
    fixedTraits: stringArray(character.fixed_traits),
    defaultLook: stringValue(character.default_look),
    wardrobe: stringValue(character.wardrobe),
  }
}

function normalizeVisualPlan(value: RawWritingResult['visual_plan']): VisualPlan | undefined {
  if (!value || typeof value !== 'object') return undefined
  const prompt = stringValue(value.prompt)
  if (!prompt) return undefined
  const characters = Array.isArray(value.characters)
    ? value.characters.map(normalizeCharacter).filter((character): character is WritingCharacterPlan => Boolean(character))
    : []
  return {
    title: stringValue(value.title) || '本轮关键场景',
    prompt,
    stylePrompt: stringValue(value.style_prompt),
    negativePrompt: stringValue(value.negative_prompt),
    action: stringValue(value.action) || undefined,
    bodyLanguage: stringValue(value.body_language) || undefined,
    expression: stringValue(value.expression) || undefined,
    gaze: stringValue(value.gaze) || undefined,
    camera: stringValue(value.camera) || undefined,
    motion: stringValue(value.motion) || undefined,
    sceneAnchor: normalizeSceneAnchor(value.scene_anchor),
    characters,
  }
}

function normalizeSceneAnchor(value: NonNullable<RawWritingResult['visual_plan']>['scene_anchor']) {
  if (!value || typeof value !== 'object') return undefined
  const key = stringValue(value.key).toLocaleLowerCase().replace(/\s+/g, '-').slice(0, 120)
  const location = stringValue(value.location)
  const timePeriod = stringValue(value.time_period)
  const fixedElements = stringArray(value.fixed_elements)
  if (!key || !location || !timePeriod || !fixedElements.length) return undefined
  return {
    key,
    location,
    timePeriod,
    fixedElements,
    lighting: stringValue(value.lighting),
    palette: stringValue(value.palette),
  }
}

export function extractJson(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回可解析的写作结果')
  return JSON.parse(trimmed.slice(start, end + 1)) as RawWritingResult
}

function stripJsonFragments(content: string) {
  let withoutCodeBlocks = content.replace(/```(?:json)?\s*[\s\S]*?```/gi, ' ')
  let output = ''
  let depth = 0
  let inString = false
  let escape = false
  for (const character of withoutCodeBlocks) {
    if (depth === 0) {
      if (!inString && character === '{') {
        depth = 1
        output += ' '
        continue
      }
      output += character
    } else if (inString) {
      if (escape) escape = false
      else if (character === '\\') escape = true
      else if (character === '"') inString = false
    } else if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth++
    } else if (character === '}') {
      depth--
    }
  }
  return output
}

/**
 * Projects the prose paragraph strings out of the model's still-incomplete
 * JSON response. The transport remains provider-agnostic; only the writing
 * UI needs this protocol-aware view while the final parser still validates
 * the complete response.
 */
function proseParagraphsArrayStart(content: string) {
  const proseKey = /"prose"\s*:\s*\{/i.exec(content)
  if (!proseKey || proseKey.index === undefined) return undefined
  const proseStart = content.indexOf('{', proseKey.index)
  if (proseStart < 0) return undefined

  let depth = 1
  let inString = false
  let escaped = false
  for (let index = proseStart + 1; index < content.length; index++) {
    const character = content[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      const keyStart = index + 1
      let keyEnd = keyStart
      let keyEscaped = false
      for (; keyEnd < content.length; keyEnd++) {
        const keyCharacter = content[keyEnd]
        if (keyEscaped) keyEscaped = false
        else if (keyCharacter === '\\') keyEscaped = true
        else if (keyCharacter === '"') break
      }
      const key = content.slice(keyStart, keyEnd)
      const afterKey = content.slice(keyEnd + 1)
      if (depth === 1 && key === 'paragraphs') {
        const arrayOffset = /^\s*:\s*\[/.exec(afterKey)?.[0].lastIndexOf('[')
        if (arrayOffset !== undefined && arrayOffset >= 0) return keyEnd + 1 + arrayOffset
      }
      index = keyEnd
      continue
    }
    if (character === '{') depth++
    else if (character === '}') {
      depth--
      if (depth === 0) return undefined
    }
  }
  return undefined
}

function projectedProseParagraphs(content: string, includePartial: boolean) {
  const arrayStart = proseParagraphsArrayStart(content)
  if (arrayStart === undefined) return []

  const values: string[] = []
  let raw = ''
  let inString = false
  let escaped = false

  const decodeFragment = (value: string) => {
    try {
      return JSON.parse(`"${value}"`) as string
    } catch {
      return value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    }
  }

  for (let index = arrayStart + 1; index < content.length; index++) {
    const character = content[index]
    if (!inString) {
      if (character === '"') {
        inString = true
        raw = ''
      } else if (character === ']') {
        break
      }
      continue
    }

    if (escaped) {
      raw += character
      escaped = false
    } else if (character === '\\') {
      raw += character
      escaped = true
    } else if (character === '"') {
      values.push(decodeFragment(raw))
      raw = ''
      inString = false
    } else {
      raw += character
    }
  }

  if (includePartial && inString && raw) values.push(decodeFragment(raw))
  return values.filter((value) => value.trim())
}

export function projectStreamingProse(content: string) {
  const paragraphs = projectedProseParagraphs(content, true)
  if (!paragraphs.length) {
    const trimmed = content.trimStart()
    return trimmed.startsWith('{') || trimmed.startsWith('```') ? '' : content
  }
  return paragraphs.join('\n\n')
}

function normalizeSceneNotes(value: RawWritingResult['scene_notes']): WritingSceneNotes | undefined {
  if (!value || typeof value !== 'object') return undefined
  const notes = value as Record<string, unknown>
  const charactersPresent = Array.isArray(notes.characters_present)
    ? notes.characters_present.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const events = Array.isArray(notes.events)
    ? notes.events.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const stateChanges = Array.isArray(notes.state_changes)
    ? notes.state_changes
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        character: stringValue(item.character),
        aspect: stringValue(item.aspect ?? item.aspects ?? '其他'),
        state: stringValue(item.state),
      }))
      .filter((item) => Boolean(item.character && item.state))
    : []
  const knowledgeChanges = Array.isArray(notes.knowledge_changes)
    ? notes.knowledge_changes
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({ character: stringValue(item.character), nowKnows: stringValue(item.now_knows ?? item.nowKnows) }))
      .filter((item) => Boolean(item.character && item.nowKnows))
    : []
  return {
    time: stringValue(notes.time) || undefined,
    location: stringValue(notes.location) || undefined,
    povCharacter: stringValue(notes.pov_character) || undefined,
    charactersPresent,
    events,
    stateChanges,
    knowledgeChanges,
    relationshipChanges: Array.isArray(notes.relationship_changes)
      ? notes.relationship_changes.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [],
    newForeshadowingTexts: [
      ...stringArray(notes.new_foreshadowing_texts),
      ...stringArray(notes.clues_planted),
    ],
    resolvedForeshadowingIds: stringArray(notes.resolved_foreshadowing_ids),
    ...(stringArray(notes.clues_resolved).length
      ? { legacyResolvedForeshadowingTexts: stringArray(notes.clues_resolved) }
      : {}),
    unresolvedThreads: Array.isArray(notes.unresolved_threads)
      ? notes.unresolved_threads.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [],
  }
}

export function parseWritingResult(content: string): WritingTurnResult {
  let parsed: RawWritingResult | undefined
  try {
    const candidate = extractJson(content)
    if (stringArray(candidate.prose?.paragraphs).length) {
      parsed = candidate
    }
  } catch {
    // Fall through to plain-text handling.
  }
  if (parsed) {
    return {
      assistantNote: stringValue(parsed.assistant_note) || '正文已完成，并整理了本轮视觉计划。',
      chapterAction: parsed.chapter_action === 'new' ? 'new' : 'continue',
      chapterTitle: stringValue(parsed.prose?.chapter_title) || undefined,
      paragraphs: stringArray(parsed.prose?.paragraphs),
      chapterSummary: stringValue(parsed.chapter_summary) || undefined,
      sceneNotes: normalizeSceneNotes(parsed.scene_notes),
      visualPlan: normalizeVisualPlan(parsed.visual_plan),
    }
  }
  const projectedParagraphs = projectedProseParagraphs(content, false)
  if (projectedParagraphs.length) {
    return {
      assistantNote: '模型的结构化结果不完整，已保存可确认的正文；本轮没有自动创建视觉计划。',
      chapterAction: 'continue',
      paragraphs: projectedParagraphs,
    }
  }
  const paragraphs = stripJsonFragments(content).split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean)
  if (!paragraphs.length) throw new Error('模型没有返回可解析的写作结果')
  return {
    assistantNote: '模型返回了普通文本，已作为正文保存；本轮没有自动创建视觉计划。',
    chapterAction: 'continue',
    paragraphs,
  }
}
