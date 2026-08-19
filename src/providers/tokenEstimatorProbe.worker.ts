/// <reference lib="webworker" />
import { Tiktoken } from 'js-tiktoken/lite'
import o200kBase from 'js-tiktoken/ranks/o200k_base'

/**
 * Environment probe worker. Real production-built module worker that actually
 * constructs a Tiktoken encoder and encodes Chinese text, so a green result
 * proves two things at once: (1) module workers execute on the target WebView,
 * and (2) the o200k_base ranks are inlined into the worker bundle (a runtime
 * fetch would silently hang offline). Dev-only/debug entry — never wired into
 * normal writing flow.
 */
self.onmessage = () => {
  try {
    const encoder = new Tiktoken(o200kBase)
    const sample = '你好，世界！这是一段用于验证 o200k_base 分词的中文文本。'
    const tokens = encoder.encode(sample).length
    self.postMessage({ ok: true, tokens, source: 'o200k_base', sample })
  } catch (error) {
    self.postMessage({
      ok: false,
      stage: 'encode',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
