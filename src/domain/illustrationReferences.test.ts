import { describe, expect, it } from 'vitest'
import type { CharacterAsset, IllustrationAsset } from './models'
import { resolveIllustrationReferences } from './illustrationReferences'

function character(overrides: Partial<CharacterAsset> = {}): CharacterAsset {
  return {
    id: 'character-1', projectId: 'project-1', name: '林昭', role: '主角', narrativePronoun: 'she',
    identity: { ageAndBuild: '', fixedTraits: [] }, appearance: { defaultLook: '', wardrobe: '' },
    continuity: { revision: 1, referenceImageUrl: 'data:image/png;base64,AA==' }, portraitStatus: 'confirmed', status: 'confirmed', createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

function illustration(overrides: Partial<IllustrationAsset> = {}): IllustrationAsset {
  return {
    id: 'illustration-1', projectId: 'project-1', title: '林昭在雨中', prompt: '林昭站在雨夜街头', referenceCharacterIds: [], status: 'planned', createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

describe('resolveIllustrationReferences', () => {
  it('blocks an explicitly declared reference that is not confirmed', () => {
    const result = resolveIllustrationReferences(illustration({ referenceCharacterIds: ['character-1'] }), [character({ status: 'draft', portraitStatus: 'review' })])
    expect(result).toMatchObject({ ready: false })
    expect(result.ready ? '' : result.reason).toContain('尚未确认')
  })

  it('automatically uses the only confirmed reference when the visual plan has no IDs', () => {
    const source = character()
    expect(resolveIllustrationReferences(illustration(), [source])).toEqual({ ready: true, characters: [source], usesReferences: true })
  })

  it('uses only named characters when multiple reference images exist', () => {
    const lin = character()
    const gu = character({ id: 'character-2', name: '顾遥' })
    expect(resolveIllustrationReferences(illustration(), [lin, gu])).toEqual({ ready: true, characters: [lin], usesReferences: true })
  })

  it('blocks ambiguous multi-reference plans instead of uploading all sources', () => {
    const result = resolveIllustrationReferences(illustration({ title: '雨夜', prompt: '一名角色走进街头' }), [character(), character({ id: 'character-2', name: '顾遥' })])
    expect(result).toMatchObject({ ready: false })
    expect(result.ready ? '' : result.reason).toContain('多个角色参考图')
  })

  it('allows ordinary generation when the project has no reference images', () => {
    const result = resolveIllustrationReferences(illustration(), [character({ continuity: { revision: 0, referenceStyleMode: 'project' }, status: 'draft' })])
    expect(result).toEqual({ ready: true, characters: [], usesReferences: false })
  })
})
