import { Capacitor } from '@capacitor/core'

export function resolveImageSource(imageUrl?: string, localUri?: string) {
  if (localUri) return Capacitor.convertFileSrc(localUri)
  return imageUrl
}
