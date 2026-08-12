import type { IllustrationAsset } from './models'

function hasUsableImage(illustration: IllustrationAsset) {
  return Boolean(illustration.imageUrl || illustration.localUri)
}

/** Selects the nearest earlier completed illustration from the exact same anchored set. */
export function resolvePreviousSceneIllustration(
  current: IllustrationAsset,
  illustrations: readonly IllustrationAsset[],
) {
  const key = current.sceneAnchor?.key.trim()
  if (!key) return undefined
  return illustrations
    .filter((candidate) => (
      candidate.id !== current.id
      && candidate.projectId === current.projectId
      && candidate.status === 'ready'
      && hasUsableImage(candidate)
      && candidate.sceneAnchor?.key.trim() === key
      && candidate.createdAt < current.createdAt
    ))
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0]
}
