/**
 * 向量存储 — 基于 SQLite 的轻量级向量检索
 */
import { getDb } from './database.js'
import { embedQuery, rankBySimilarity, formatSearchResults } from './embedding.js'

// ===== Schema 初始化 =====

export function initVectorSchema(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS chapter_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      embedding_json TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_chunks_chapter ON chapter_chunks(chapter_number);
    CREATE INDEX IF NOT EXISTS idx_chapter_chunks_hash ON chapter_chunks(content_hash);
  `)
}

// ===== 写入 =====

export interface ChunkRecord {
  chapterNumber: number
  chunkIndex: number
  content: string
  contentHash: string
  embedding: number[]
  tokenCount: number
}

/**
 * 批量写入 chunks（自动按 hash 去重跳过已存在的 chunk）
 */
export function storeChapterChunks(chunks: ChunkRecord[]): number {
  const db = getDb()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO chapter_chunks
      (chapter_number, chunk_index, content, content_hash, embedding_json, token_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  let stored = 0
  const tx = db.transaction((items: ChunkRecord[]) => {
    for (const c of items) {
      const result = insert.run(
        c.chapterNumber,
        c.chunkIndex,
        c.content,
        c.contentHash,
        JSON.stringify(c.embedding),
        c.tokenCount,
      )
      if (result.changes > 0) stored++
    }
  })

  tx(chunks)
  return stored
}

/**
 * 删除指定章节的所有 chunks（用于重索引）
 */
export function deleteChapterChunks(chapterNumber: number): void {
  const db = getDb()
  db.prepare('DELETE FROM chapter_chunks WHERE chapter_number = ?').run(chapterNumber)
}

/**
 * 删除所有 chunks
 */
export function clearAllChunks(): void {
  const db = getDb()
  db.prepare('DELETE FROM chapter_chunks').run()
}

// ===== 查询 =====

interface ChunkRow {
  id: number
  chapter_number: number
  chunk_index: number
  content: string
  content_hash: string
  embedding_json: string
  token_count: number
}

export interface ChunkWithEmbedding {
  id: number
  chapterNumber: number
  chunkIndex: number
  content: string
  embedding: number[]
}

/**
 * 加载全部向量到内存（用于相似度计算）
 * 对于 1000 个 2048 维向量约占用 8MB 内存，完全可接受
 */
function loadAllChunks(): ChunkWithEmbedding[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, chapter_number, chunk_index, content, embedding_json
    FROM chapter_chunks
    ORDER BY chapter_number, chunk_index
  `).all() as ChunkRow[]

  return rows.map(r => ({
    id: r.id,
    chapterNumber: r.chapter_number,
    chunkIndex: r.chunk_index,
    content: r.content,
    embedding: JSON.parse(r.embedding_json) as number[],
  }))
}

/**
 * 语义检索：根据查询文本返回 topK 最相关的章节片段
 * @param queryText 查询文本（通常是章节概要/关键事件/角色名等）
 * @param topK 返回结果数
 * @param excludeChapters 排除的章节号（如当前正在写的章）
 */
export async function searchSimilarChunks(
  queryText: string,
  topK: number = 15,
  excludeChapters: number[] = [],
): Promise<Array<{ chapterNumber: number; chunkIndex: number; content: string; score: number }>> {
  const queryEmbedding = await embedQuery(queryText)
  if (queryEmbedding.length === 0) return []

  const allChunks = loadAllChunks()

  const candidates = allChunks.filter(c => !excludeChapters.includes(c.chapterNumber))

  if (candidates.length === 0) return []

  return rankBySimilarity(queryEmbedding, candidates, topK)
}

/**
 * 语义检索并格式化为 Prompt 上下文
 */
export async function searchRelevantContext(
  queryText: string,
  topK: number = 15,
  excludeChapter?: number,
  maxChars: number = 3000,
): Promise<string> {
  const excludeChapters = excludeChapter !== undefined ? [excludeChapter] : []
  const results = await searchSimilarChunks(queryText, topK, excludeChapters)
  return formatSearchResults(results, maxChars)
}

// ===== 统计 =====

export function getVectorStats(): { totalChunks: number; totalChapters: number; chapterRange: string; totalTokens: number } {
  try {
    const db = getDb()
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM chapter_chunks').get() as { cnt: number }
    const chapterRow = db.prepare(`
      SELECT
        COUNT(DISTINCT chapter_number) as chapters,
        MIN(chapter_number) as minCh,
        MAX(chapter_number) as maxCh,
        SUM(token_count) as totalTokens
      FROM chapter_chunks
    `).get() as { chapters: number; minCh: number | null; maxCh: number | null; totalTokens: number | null }

    return {
      totalChunks: countRow.cnt,
      totalChapters: chapterRow.chapters || 0,
      chapterRange: chapterRow.minCh ? `第${chapterRow.minCh}-${chapterRow.maxCh}章` : '无',
      totalTokens: chapterRow.totalTokens || 0,
    }
  } catch {
    return { totalChunks: 0, totalChapters: 0, chapterRange: '无', totalTokens: 0 }
  }
}
