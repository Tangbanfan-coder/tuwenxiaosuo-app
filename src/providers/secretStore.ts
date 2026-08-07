import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Capacitor } from '@capacitor/core'
import type { SecretRef } from './types'

export interface SecretStore {
  get(ref: SecretRef): Promise<string | null>
  set(ref: SecretRef, value: string): Promise<void>
  remove(ref: SecretRef): Promise<void>
  has(ref: SecretRef): Promise<boolean>
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
    return this.values.get(ref) ?? null
  }

  async set(ref: SecretRef, value: string) {
    if (this.native) {
      await this.ready
      await SecureStorage.setItem(ref, value)
      return
    }
    this.values.set(ref, value)
  }

  async remove(ref: SecretRef) {
    if (this.native) {
      await this.ready
      await SecureStorage.removeItem(ref)
      return
    }
    this.values.delete(ref)
  }

  async has(ref: SecretRef) {
    return (await this.get(ref)) !== null
  }
}

export const secretStore: SecretStore = new AdaptiveSecretStore()
