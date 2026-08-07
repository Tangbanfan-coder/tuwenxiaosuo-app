import type { HttpTransport, TransportRequest } from './types'
import { secretStore } from './secretStore'

export class TransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'TransportError'
  }
}

export class BrowserFetchTransport implements HttpTransport {
  async request<T>({ url, method, headers, auth, body, timeoutMs = 15_000 }: TransportRequest) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

    try {
      const requestHeaders = { ...headers }
      if (auth?.kind === 'bearer') {
        const apiKey = await secretStore.get(auth.secretRef)
        if (!apiKey) throw new TransportError('请填写 API Key')
        requestHeaders.Authorization = `Bearer ${apiKey}`
      }

      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body,
        signal: controller.signal,
      })

      if (!response.ok) {
        let detail = ''
        try {
          const payload = await response.clone().json() as { error?: { message?: unknown } | unknown; message?: unknown }
          const errorObject = payload.error && typeof payload.error === 'object' ? payload.error as { message?: unknown } : undefined
          const candidate = errorObject?.message ?? payload.message ?? (typeof payload.error === 'string' ? payload.error : undefined)
          if (typeof candidate === 'string' && candidate.trim()) detail = `：${candidate.trim()}`
        } catch {
          // Some gateways return an HTML or empty error body; keep the HTTP status.
        }
        throw new TransportError(`接口返回 HTTP ${response.status}${detail}`, response.status)
      }

      return {
        status: response.status,
        data: await response.json() as T,
      }
    } catch (error) {
      if (error instanceof TransportError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new TransportError('连接超时，请检查 API URL')
      }
      throw new TransportError('无法连接接口；Web 预览也可能受到 CORS 限制')
    } finally {
      window.clearTimeout(timeout)
    }
  }
}

export const browserTransport = new BrowserFetchTransport()
