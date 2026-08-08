import type { HttpTransport, RequestAuth, TransportRequest } from './types'
import { secretStore } from './secretStore'

export class TransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'TransportError'
  }
}

export class BrowserFetchTransport implements HttpTransport {
  private async prepareRequest({ headers, auth }: { headers?: Record<string, string>; auth?: RequestAuth }) {
    const requestHeaders = { ...headers }
    if (auth?.kind === 'bearer') {
      const apiKey = await secretStore.get(auth.secretRef)
      if (!apiKey) throw new TransportError('请填写 API Key')
      requestHeaders.Authorization = `Bearer ${apiKey}`
    }
    return requestHeaders
  }

  async request<T>({ url, method, headers, auth, body, timeoutMs = 15_000 }: TransportRequest) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

    try {
      const requestHeaders = await this.prepareRequest({ headers, auth })

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

  async stream(request: TransportRequest, onDelta: (delta: string) => void) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000)

    try {
      const requestHeaders = await this.prepareRequest(request)

      const response = await fetch(request.url, {
        method: request.method,
        headers: requestHeaders,
        body: request.body,
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

      if (!response.body) throw new TransportError('接口未返回流式内容，请检查模型是否支持 stream')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let collected = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }
            const delta = parsed.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta) {
              collected += delta
              onDelta(delta)
            }
          } catch {
            // Ignore malformed SSE frames; some gateways emit keep-alive lines.
          }
        }
      }
      return collected
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
