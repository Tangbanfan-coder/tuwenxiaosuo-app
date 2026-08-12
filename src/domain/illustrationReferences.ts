import type { CharacterAsset, IllustrationAsset } from './models'

export type IllustrationReferenceResolution =
  | { ready: true; characters: CharacterAsset[]; usesReferences: boolean }
  | { ready: false; characters: CharacterAsset[]; reason: string }

function hasReferenceImage(character: CharacterAsset) {
  return Boolean(character.continuity.referenceImageUrl || character.continuity.localUri)
}

function isConfirmedReference(character: CharacterAsset | undefined) {
  return Boolean(character && character.status === 'confirmed' && hasReferenceImage(character))
}

function includesWholeCharacterName(text: string, name: string) {
  const normalizedName = name.trim().toLocaleLowerCase()
  return normalizedName.length > 0 && text.toLocaleLowerCase().includes(normalizedName)
}

/**
 * This is the sole policy for deciding whether an illustration may make an
 * image request and which source images belong to that request.
 */
export function resolveIllustrationReferences(
  illustration: IllustrationAsset,
  characters: readonly CharacterAsset[],
): IllustrationReferenceResolution {
  if (illustration.referenceCharacterIds.length) {
    const selected: CharacterAsset[] = []
    for (const id of illustration.referenceCharacterIds) {
      const character = characters.find((item) => item.id === id)
      if (!character) return { ready: false, characters: [], reason: '视觉计划指定的角色档案不存在，无法生成插画。' }
      if (!isConfirmedReference(character)) return { ready: false, characters: [], reason: `角色“${character.name}”的参考图尚未确认或图片不可用。请在角色资产中补全档案并确认。` }
      selected.push(character)
    }
    return { ready: true, characters: selected, usesReferences: true }
  }

  const candidates = characters.filter(hasReferenceImage)
  if (!candidates.length) return { ready: true, characters: [], usesReferences: false }
  if (candidates.length === 1) {
    const [character] = candidates
    if (character.status !== 'confirmed') return { ready: false, characters: [], reason: `作品唯一的参考图属于“${character.name}”，请先在角色资产中确认后再生成。` }
    return { ready: true, characters: [character], usesReferences: true }
  }

  const source = `${illustration.title}\n${illustration.prompt}`
  const matches = candidates.filter((character) => includesWholeCharacterName(source, character.name))
  if (!matches.length) return { ready: false, characters: [], reason: '作品有多个角色参考图，但画面描述未写出完整角色名。请在视觉计划中注明角色后再生成。' }
  const unavailable = matches.find((character) => character.status !== 'confirmed')
  if (unavailable) return { ready: false, characters: [], reason: `画面中的“${unavailable.name}”参考图尚未确认或图片不可用。请在角色资产中确认。` }
  return { ready: true, characters: matches, usesReferences: true }
}
