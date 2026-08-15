// Compatibility entry point. Consumers keep this import path while image
// generation, persistence, rendering, and device export remain independent.
export { generateNativeImageAsset, type NativeImageGenerationRequest } from './imageAssets/nativeGeneration'
export { persistImageAsset, recoverPersistedImageAsset } from './imageAssets/persistence'
export { resolveImageSource } from './imageAssets/display'
export { saveImageToDevice } from './imageAssets/deviceExport'
export type { ImageAssetOrigin, ImageAssetPersistenceStage, ImageAssetPersistenceStageCallback, StoredImageSource } from './imageAssets/fileSupport'
