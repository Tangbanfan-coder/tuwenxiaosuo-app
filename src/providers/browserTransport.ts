import { Capacitor, CapacitorHttp } from '@capacitor/core'
import type { HttpTransport, RequestAuth, TransportRequest } from './types'
import { secretStore } from './secretStore'

interface CapFormDataEntry {
  key: string
  value: string
  type: 'base64File' | 'string'
  contentType?: string
  fileName?: string
}

interface NativeChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>
}

function errorDetail(payload: unknown): string {
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (!trimmed) return ''
    try {
      return errorDetail(JSON.parse(trimmed)) || trimmed
    } catch {
      return trimmed
    }
  }
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as { error?: { message?: unknown } | unknown; message?: unknown }
  const errorObject = record.error && typeof record.error === 'object'
    ? record.error as { message?: unknown }
    : undefined
  const candidate = errorObject?.message ?? record.message ?? record.error
  return typeof candidate === 'string' ? candidate.trim() : ''
}

function isTimeoutError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (!error || typeof error !== 'object') return false
  const record = error as { name?: unknown; code?: unknown; message?: unknown }
  const description = [record.name, record.code, record.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  return /timeout|timed out|sockettimeoutexception|超时/i.test(description)
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function convertFormData(form: FormData): Promise<CapFormDataEntry[]> {
  const entries: CapFormDataEntry[] = []
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      entries.push({ key, value, type: 'string' })
      continue
    }
    entries.push({
      key,
      value: await blobToBase64(value),
      type: 'base64File',
      contentType: value.type || 'application/octet-stream',
      fileName: value.name || 'file',
    })
  }
  return entries
}

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
    if (Capacitor.isNativePlatform()) {
      try {
        const requestHeaders = await this.prepareRequest({ headers, auth })
        const formDataBody = typeof FormData !== 'undefined' && body instanceof FormData
        if (formDataBody && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-type')) {
          requestHeaders['Content-Type'] = 'multipart/form-data'
        }
        const response = await CapacitorHttp.request({
          url,
          method,
          headers: requestHeaders,
          data: formDataBody ? await convertFormData(body) : body,
          dataType: formDataBody ? 'formData' : undefined,
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
          responseType: 'json',
        })
        if (response.status < 200 || response.status >= 300) {
          const detail = errorDetail(response.data)
          throw new TransportError(`接口返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`, response.status)
        }
        return { status: response.status, data: response.data as T }
      } catch (error) {
        if (error instanceof TransportError) throw error
        if (isTimeoutError(error)) throw new TransportError('连接超时，请检查 API URL')
        throw new TransportError('无法连接接口，请检查网络与 API URL')
      }
    }

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
          const candidate = errorDetail(await response.clone().json())
          if (candidate) detail = `：${candidate}`
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
    const nativeWebViewStream = Capacitor.isNativePlatform() && request.androidTransport === 'webview-stream'
    if (Capacitor.isNativePlatform() && !nativeWebViewStream) {
      let payload: unknown
      try {
        payload = typeof request.body === 'string' ? JSON.parse(request.body) : request.body
      } catch {
        throw new TransportError('原生端无法解析流式请求内容')
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TransportError('原生端无法解析流式请求内容')
      }
      const response = await this.request<NativeChatResponse>({
        ...request,
        body: JSON.stringify({ ...payload, stream: false }),
      })
      const content = response.data.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new TransportError('接口未返回完整文本内容，请检查模型响应格式')
      }
      onDelta(content)
      return content
    }

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
          const candidate = errorDetail(await response.clone().json())
          if (candidate) detail = `：${candidate}`
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
      if (nativeWebViewStream) {
        throw new TransportError('流式连接失败，中转站可能未允许 CORS。请在文本模型设置中关闭“流式输出”后手动重试；本次没有自动重发。')
      }
      if (isTimeoutError(error)) {
        throw new TransportError('连接超时，请检查 API URL')
      }
      throw new TransportError('无法连接接口；Web 预览也可能受到 CORS 限制')
    } finally {
      window.clearTimeout(timeout)
    }
  }
}

export const browserTransport = new BrowserFetchTransport()
