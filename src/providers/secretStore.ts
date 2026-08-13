import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Capacitor } from '@capacitor/core'
import type { SecretRef } from './types'

export interface SecretStore {
  get(ref: SecretRef): Promise<string | null>
  set(ref: SecretRef, value: string): Promise<void>
  remove(ref: SecretRef): Promise<void>
  has(ref: SecretRef): Promise<boolean>
}

const WEB_KEY_PREFIX = 'illustrated-story-chat_'

function readWebValue(ref: SecretRef) {
  try {
    return localStorage.getItem(`${WEB_KEY_PREFIX}${ref}`)
  } catch {
    return null
  }
}

function writeWebValue(ref: SecretRef, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(`${WEB_KEY_PREFIX}${ref}`)
    else localStorage.setItem(`${WEB_KEY_PREFIX}${ref}`, value)
  } catch {
    // Private browsing or blocked storage: the in-memory cache still works
    // for this session.
  }
}

class AdaptiveSecretStore implements SecretStore {
  private readonly values = new Map<SecretRef, string>()
  private readonly native = Capacitor.isNativePlatform()
  private readonly ready = this.native
    ? SecureStorage.setKeyPrefix('illustrated-story-chat_')
    : Promise.resolve()

  async get(ref: SecretRef) {
    if (this.native) {
      await this.ready
      return SecureStorage.getItem(ref)
    }
    const persisted = readWebValue(ref)
    if (persisted !== null) return persisted
    return this.values.get(ref) ?? null
  }

  async set(ref: SecretRef, value: string) {
    if (this.native) {
      await this.ready
      await SecureStorage.setItem(ref, value)
      return
    }
    this.values.set(ref, value)
    writeWebValue(ref, value)
  }

  async remove(ref: SecretRef) {
    if (this.native) {
      await this.ready
      await SecureStorage.removeItem(ref)
      return
    }
    this.values.delete(ref)
    writeWebValue(ref, null)
  }

  async has(ref: SecretRef) {
    return (await this.get(ref)) !== null
  }
}

export const secretStore: SecretStore = new AdaptiveSecretStore()
