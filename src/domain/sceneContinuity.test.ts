import { describe, expect, it } from 'vitest'
import type { IllustrationAsset } from './models'
import { resolvePreviousSceneIllustration } from './sceneContinuity'

function illustration(id: string, createdAt: number, overrides: Partial<IllustrationAsset> = {}): IllustrationAsset {
  return {
    id, projectId: 'project-1', title: id, prompt: id, referenceCharacterIds: [], status: 'ready',
    localUri: `file://${id}.png`, createdAt, updatedAt: createdAt,
    sceneAnchor: { key: 'balcony-night', location: '公寓阳台', timePeriod: '夜晚', fixedElements: ['白色栏杆'], lighting: '室内暖光', palette: '蓝金' },
    ...overrides,
  }
}

describe('resolvePreviousSceneIllustration', () => {
  it('chooses the nearest earlier ready image with the exact same scene key', () => {
    const current = illustration('current', 30, { status: 'planned', localUri: undefined })
    expect(resolvePreviousSceneIllustration(current, [illustration('old', 10), illustration('nearest', 20), current])?.id).toBe('nearest')
  })

  it('ignores different scenes, failed images, current and future images', () => {
    const current = illustration('current', 30, { status: 'planned', localUri: undefined })
    const candidates = [
      illustration('different', 29, { sceneAnchor: { ...current.sceneAnchor!, key: 'street-night' } }),
      illustration('failed', 28, { status: 'failed' }),
      illustration('future', 40),
      current,
    ]
    expect(resolvePreviousSceneIllustration(current, candidates)).toBeUndefined()
  })

  it('does not infer continuity for legacy records without anchors', () => {
    expect(resolvePreviousSceneIllustration(illustration('current', 30, { sceneAnchor: undefined }), [illustration('old', 10)])).toBeUndefined()
  })
})
