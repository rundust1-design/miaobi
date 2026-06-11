/**
 * Embedding 模块 — 文本切片 + 向量化 + 语义检索
 */
import { embedTexts, embedSingle } from './llm.js'
import { createHash } from 'node:crypto'

// ===== 文本切片 =====

export interface TextChunk {
  chapterNumber: number
  chunkIndex: number
  content: string
  contentHash: string
  tokenCount: number
}

/**
 * 按段落边界切片，每段约 maxChars 字，相邻 chunk 重叠 overlap 字
 */
export function chunkChapterText(
  text: string,
  chapterNumber: number,
  maxChars: number = 500,
  overlap: number = 100,
): TextChunk[] {
  if (!text || text.trim().length === 0) return []

  // 按空行分段落
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)
  const chunks: TextChunk[] = []
  let chunkIndex = 0
  let currentContent = ''
  let currentTokenCount = 0

  function estimateTokens(s: string): number {
    return Math.ceil(s.length / 1.5)
  }

  function flushChunk() {
    if (currentContent.trim().length === 0) return
    const trimmed = currentContent.trim()
    chunks.push({
      chapterNumber,
      chunkIndex: chunkIndex++,
      content: trimmed,
      contentHash: createHash('md5').update(trimmed).digest('hex'),
      tokenCount: currentTokenCount,
    })
    currentContent = ''
    currentTokenCount = 0
  }

  for (const paragraph of paragraphs) {
    const paraTokens = estimateTokens(paragraph)

    if (currentTokenCount + paraTokens > maxChars && currentContent) {
      flushChunk()
    }

    // 如果单段落大于 maxChars，进一步按句子切分
    if (paraTokens > maxChars) {
      flushChunk()
      const sentences = paragraph.split(/(?<=[。！？.!?])/)
      let sentBuffer = ''
      let sentTokens = 0
      for (const sentence of sentences) {
        const st = estimateTokens(sentence)
        if (sentTokens + st > maxChars && sentBuffer) {
          chunks.push({
            chapterNumber,
            chunkIndex: chunkIndex++,
            content: sentBuffer.trim(),
            contentHash: createHash('md5').update(sentBuffer.trim()).digest('hex'),
            tokenCount: sentTokens,
          })
          sentBuffer = sentence
          sentTokens = st
        } else {
          sentBuffer += sentence
          sentTokens += st
        }
      }
      if (sentBuffer.trim()) {
        chunks.push({
          chapterNumber,
          chunkIndex: chunkIndex++,
          content: sentBuffer.trim(),
          contentHash: createHash('md5').update(sentBuffer.trim()).digest('hex'),
          tokenCount: sentTokens,
        })
      }
    } else {
      currentContent += (currentContent ? '\n\n' : '') + paragraph
      currentTokenCount += paraTokens
    }
  }

  flushChunk()

  // 添加重叠：每个 chunk 后追加前一个 chunk 尾部 overlap 字
  // （在生成阶段处理，此处仅标记）
  return chunks
}

// ===== 向量化 =====

/**
 * 批量向量化文本块（自动分批，每批最多 20 条）
 */
export async function embedChunks(chunks: TextChunk[]): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>()
  const BATCH_SIZE = 20

  const unhashed = chunks.filter(c => c.content.trim().length > 0)

  for (let i = 0; i < unhashed.length; i += BATCH_SIZE) {
    const batch = unhashed.slice(i, i + BATCH_SIZE)
    const texts = batch.map(c => c.content)
    const vectors = await embedTexts(texts)

    for (let j = 0; j < batch.length; j++) {
      if (vectors[j]) {
        result.set(batch[j].contentHash, vectors[j])
      }
    }
  }

  return result
}

// ===== 向量计算 =====

/** 计算两个向量的余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 对候选集按余弦相似度排序，返回 topK */
export function rankBySimilarity(
  queryEmbedding: number[],
  candidates: Array<{ id: number; chapterNumber: number; chunkIndex: number; content: string; embedding: number[] }>,
  topK: number = 15,
): Array<{ id: number; chapterNumber: number; chunkIndex: number; content: string; score: number }> {
  const scored = candidates.map(c => ({
    id: c.id,
    chapterNumber: c.chapterNumber,
    chunkIndex: c.chunkIndex,
    content: c.content,
    score: cosineSimilarity(queryEmbedding, c.embedding),
  }))

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).filter(s => s.score > 0.3)
}

/**
 * 格式化检索结果为 Prompt 可用的上下文字符串
 */
export function formatSearchResults(
  results: Array<{ chapterNumber: number; chunkIndex: number; content: string; score: number }>,
  maxChars: number = 3000,
): string {
  if (results.length === 0) return '（未找到相关上下文）'

  const lines: string[] = []
  let totalChars = 0

  for (const r of results) {
    const header = `【第${r.chapterNumber}章·片段${r.chunkIndex + 1} 相似度:${(r.score * 100).toFixed(0)}%】`
    const body = r.content.slice(0, 400)
    const block = header + '\n' + body

    if (totalChars + block.length > maxChars) break
    lines.push(block)
    totalChars += block.length
  }

  return `【语义检索相关上下文（共 ${results.length} 条，展示前 ${lines.length} 条）】\n` + lines.join('\n\n')
}

// ===== 语义检索入口 =====

/**
 * 给定查询文本，从候选集中返回 topK 最相关的 chunks
 * 由 vector-db.ts 调用
 */
export async function embedQuery(query: string): Promise<number[]> {
  if (!query || query.trim().length === 0) return []
  return embedSingle(query.trim())
}
