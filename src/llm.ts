import OpenAI from 'openai'
import { getConfig } from './config.js'

let client: OpenAI | null = null
let cachedBaseUrl = ''
let cachedApiKey = ''

export function getLLMClient(): OpenAI {
  const cfg = getConfig()
  // 当配置变更后重建客户端（baseUrl/apiKey 变化时）
  if (client && cfg.llm.baseUrl === cachedBaseUrl && cfg.llm.apiKey === cachedApiKey) {
    return client
  }
  client = new OpenAI({
    baseURL: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
  })
  cachedBaseUrl = cfg.llm.baseUrl
  cachedApiKey = cfg.llm.apiKey
  return client
}

export interface LLMCallOptions {
  thinking?: boolean
  responseFormat?: { type: 'json_object' | 'text' }
  onChunk?: (chunk: string) => void
  signal?: AbortSignal
}

/**
 * 流式调用 LLM，返回完整文本（自动去除 <think> 标签）
 */
export async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  options?: LLMCallOptions,
): Promise<string> {
  const openai = getLLMClient()
  const cfg = getConfig()

  const stream = await openai.chat.completions.create({
    model: cfg.llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: true,
    // 不传 response_format：多数国产模型不支持 json_object 模式
    // JSON 输出要求在 system prompt 中写明即可
  }, {
    signal: options?.signal,
  })

  let fullContent = ''
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) {
      fullContent += delta
      options?.onChunk?.(delta)
      process.stdout.write(delta) // 实时输出
    }
  }
  process.stdout.write('\n')

  // 去除思维链标签
  const cleaned = fullContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
  return cleaned
}

/**
 * 非流式调用（用于 JSON 输出等场景）
 */
export async function callLLMNonStreaming(
  systemPrompt: string,
  userPrompt: string,
  options?: { responseFormat?: { type: 'json_object' | 'text' } },
): Promise<string> {
  const openai = getLLMClient()
  const cfg = getConfig()

  const response = await openai.chat.completions.create({
    model: cfg.llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: options?.responseFormat
      ? { type: options.responseFormat.type as 'json_object' | 'text' }
      : undefined,
  })

  const content = response.choices[0]?.message?.content || ''
  return content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
}
