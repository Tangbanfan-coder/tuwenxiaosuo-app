import { FileSharer } from '@capgo/capacitor-file-sharer'
import { Capacitor } from '@capacitor/core'
import { blobToDataUrl, detectImageFormat } from './fileSupport'

const SAVED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const

function extensionFromPath(path: string) {
  const fileName = decodeURIComponent(path.split(/[\\/]/).pop() ?? '')
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return undefined
  const extension = fileName.slice(dot + 1).toLowerCase()
  return SAVED_IMAGE_EXTENSIONS.includes(extension as typeof SAVED_IMAGE_EXTENSIONS[number]) ? extension : undefined
}

function contentTypeForExtension(extension: string) {
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

function safeSavedFileName(title: string) {
  return title.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || '插画'
}

export async function saveImageToDevice(source: string, localUri: string | undefined, title: string): Promise<void> {
  const extension = Capacitor.isNativePlatform() && localUri ? extensionFromPath(localUri) ?? 'png' : undefined
  const fileName = `叙影-${safeSavedFileName(title)}.${extension ?? 'png'}`
  if (Capacitor.isNativePlatform() && localUri) {
    await FileSharer.save({ path: localUri, filename: fileName, contentType: contentTypeForExtension(extension!), android: { saveDirectory: 'pictures', relativePath: '叙影' } })
    return
  }
  const response = await fetch(source)
  if (!response.ok) throw new Error('无法读取图片数据')
  const bytes = new Uint8Array(await (await response.blob()).arrayBuffer())
  const detectedExtension = detectImageFormat(bytes) ?? 'png'
  await FileSharer.save({ base64Data: await blobToDataUrl(new Blob([bytes])), filename: `叙影-${safeSavedFileName(title)}.${detectedExtension}`, contentType: contentTypeForExtension(detectedExtension), android: { saveDirectory: 'pictures', relativePath: '叙影' } })
}
