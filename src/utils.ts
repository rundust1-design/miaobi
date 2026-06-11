/**
 * 通用工具函数
 */

/** 去除 DeepSeek 等模型的 thinking 标签（XML 格式 + 非标准前缀格式） */
export function stripThinkingTags(text: string): string {
  if (!text) return text
  // 1. <thinking>...</thinking> XML 标签（DeepSeek V3/V4 标准格式）
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  // 2.  thinking...（R1 旧格式：空格前缀 + thinking，以  或 response 结尾）
  text = text.replace(/ thinking[\s\S]*?(?:\s\sresponse|$)/gi, '')
  return text.trim()
}

/** 容错 JSON 解析：剥离 Markdown 代码块 + 自动截取有效 JSON 边界 */
export function parseJSON<T>(text: string): T {
  let cleanText = text
    .replace(/```json?\n?/gi, '')
    .replace(/```\n?/gi, '')
    .trim()

  // 截取第一个 { 或 [ 到最后一个 } 或 ]
  const firstBrace = cleanText.indexOf('{')
  const firstBracket = cleanText.indexOf('[')
  const lastBrace = cleanText.lastIndexOf('}')
  const lastBracket = cleanText.lastIndexOf(']')

  if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    cleanText = cleanText.substring(firstBrace, lastBrace + 1)
  } else if (firstBracket !== -1 && lastBracket !== -1) {
    cleanText = cleanText.substring(firstBracket, lastBracket + 1)
  }

  try {
    return JSON.parse(cleanText) as T
  } catch {
    throw new Error(`JSON 解析失败。末尾内容: ${cleanText.slice(-200)}`)
  }
}

/** 估算 Token 数（中文约 1.5 字符/token） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5)
}

/** 格式化日志时间戳 */
export function timestamp(): string {
  return new Date().toISOString().slice(11, 19)
}

/** 日志辅助 */
export function log(msg: string): void {
  console.log(`[${timestamp()}] ${msg}`)
}

/** 安全的文件名（替换非法字符） */
export function safeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_')
}
