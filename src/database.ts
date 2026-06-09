import Database from 'better-sqlite3'
import { join } from 'node:path'
import { getConfig } from './config.js'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  const cfg = getConfig()
  const dbPath = join(cfg.miaobiHome, 'miaobi.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  initSchema()
  return db
}

function initSchema(): void {
  const d = db!

  d.exec(`
    CREATE TABLE IF NOT EXISTS project_core (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS novel_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blueprints (
      chapter_number INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      role TEXT DEFAULT '发展',
      purpose TEXT DEFAULT '',
      key_events TEXT DEFAULT '',
      characters TEXT DEFAULT '[]',
      suspense_hook TEXT DEFAULT '',
      user_guidance TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      notes_updated_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      source TEXT DEFAULT 'write',
      content TEXT NOT NULL DEFAULT '',
      word_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(chapter_number, version)
    );

    CREATE TABLE IF NOT EXISTS characters (
      name TEXT PRIMARY KEY,
      role TEXT DEFAULT 'supporting',
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      background TEXT DEFAULT '',
      abilities TEXT DEFAULT '',
      motivation TEXT DEFAULT '',
      relationships TEXT DEFAULT '',
      arc TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      cs_location TEXT DEFAULT '',
      cs_power_level TEXT DEFAULT '',
      cs_physical_state TEXT DEFAULT '',
      cs_mental_state TEXT DEFAULT '',
      cs_key_items TEXT DEFAULT '',
      cs_recent_events TEXT DEFAULT '',
      cs_updated_at_chapter INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

// ===== 项目核心（架构）=====

export function saveProjectCore(key: string, content: string): void {
  const d = getDb()
  d.prepare(`INSERT OR REPLACE INTO project_core (key, content, updated_at) VALUES (?, ?, datetime('now'))`).run(key, content)
}

export function getProjectCore(key: string): string | null {
  const d = getDb()
  const row = d.prepare(`SELECT content FROM project_core WHERE key = ?`).get(key) as { content: string } | undefined
  return row?.content || null
}

export function getAllProjectCore(): Record<string, string> {
  const d = getDb()
  const rows = d.prepare(`SELECT key, content FROM project_core`).all() as Array<{ key: string; content: string }>
  const result: Record<string, string> = {}
  for (const r of rows) result[r.key] = r.content
  return result
}

// ===== 全局配置 =====

export function saveConfig(key: string, value: string): void {
  const d = getDb()
  d.prepare(`INSERT OR REPLACE INTO novel_config (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(key, value)
}

export function getConfigValue(key: string): string | null {
  const d = getDb()
  const row = d.prepare(`SELECT value FROM novel_config WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value || null
}

export function getAllConfig(): Record<string, string> {
  const d = getDb()
  const rows = d.prepare(`SELECT key, value FROM novel_config`).all() as { key: string; value: string }[]
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  return map
}

// ===== 章节蓝图 =====

export interface Blueprint {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  suspenseHook: string
  userGuidance: string
  notes: string
  notesUpdatedAt: string
}

export function saveBlueprint(bp: Blueprint): void {
  const d = getDb()
  d.prepare(`INSERT OR REPLACE INTO blueprints
    (chapter_number, title, role, purpose, key_events, characters, suspense_hook, user_guidance, notes, notes_updated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(bp.chapterNumber, bp.title, bp.role, bp.purpose, bp.keyEvents, JSON.stringify(bp.characters), bp.suspenseHook, bp.userGuidance, bp.notes, bp.notesUpdatedAt)
}

export function saveAllBlueprints(blueprints: Blueprint[]): void {
  const d = getDb()
  const stmt = d.prepare(`INSERT OR REPLACE INTO blueprints
    (chapter_number, title, role, purpose, key_events, characters, suspense_hook, user_guidance, notes, notes_updated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
  const tx = d.transaction((bps: Blueprint[]) => {
    for (const bp of bps) {
      stmt.run(bp.chapterNumber, bp.title, bp.role, bp.purpose, bp.keyEvents, JSON.stringify(bp.characters), bp.suspenseHook, bp.userGuidance, bp.notes, bp.notesUpdatedAt)
    }
  })
  tx(blueprints)
}

export function getBlueprint(chapterNumber: number): Blueprint | null {
  const d = getDb()
  const row = d.prepare(`SELECT * FROM blueprints WHERE chapter_number = ?`).get(chapterNumber) as Record<string, unknown> | undefined
  if (!row) return null
  return rowToBlueprint(row)
}

export function getAllBlueprints(): Blueprint[] {
  const d = getDb()
  const rows = d.prepare(`SELECT * FROM blueprints ORDER BY chapter_number`).all() as Array<Record<string, unknown>>
  return rows.map(rowToBlueprint).sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export function getBlueprintCount(): number {
  const d = getDb()
  const row = d.prepare(`SELECT COUNT(*) as cnt FROM blueprints`).get() as { cnt: number }
  return row.cnt
}

function rowToBlueprint(row: Record<string, unknown>): Blueprint {
  let characters: string[] = []
  try {
    characters = JSON.parse(row.characters as string) as string[]
  } catch { /* ignore */ }
  return {
    chapterNumber: row.chapter_number as number,
    title: row.title as string || '',
    role: row.role as string || '发展',
    purpose: row.purpose as string || '',
    keyEvents: row.key_events as string || '',
    characters,
    suspenseHook: row.suspense_hook as string || '',
    userGuidance: row.user_guidance as string || '',
    notes: row.notes as string || '',
    notesUpdatedAt: row.notes_updated_at as string || '',
  }
}

// ===== 草稿 =====

export interface DraftRecord {
  id: number
  chapterNumber: number
  version: number
  source: string
  content: string
  wordCount: number
  status: string
}

export function createDraft(chapterNumber: number, version: number, source: string, content: string): DraftRecord {
  const d = getDb()
  const result = d.prepare(`INSERT INTO drafts (chapter_number, version, source, content, word_count, status)
    VALUES (?, ?, ?, ?, ?, 'draft')`).run(chapterNumber, version, source, content, content.length)
  return { id: Number(result.lastInsertRowid), chapterNumber, version, source, content, wordCount: content.length, status: 'draft' }
}

export function getNextDraftVersion(chapterNumber: number): number {
  const d = getDb()
  const row = d.prepare(`SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM drafts WHERE chapter_number = ?`).get(chapterNumber) as { next_version: number }
  return row.next_version
}

export function getDraftById(id: number): DraftRecord | null {
  const d = getDb()
  const row = d.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: row.id as number,
    chapterNumber: row.chapter_number as number,
    version: row.version as number,
    source: row.source as string,
    content: row.content as string,
    wordCount: row.word_count as number,
    status: row.status as string,
  }
}

export function getLatestDraft(chapterNumber: number): DraftRecord | null {
  const d = getDb()
  const row = d.prepare(`SELECT * FROM drafts WHERE chapter_number = ? ORDER BY version DESC LIMIT 1`).get(chapterNumber) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: row.id as number,
    chapterNumber: row.chapter_number as number,
    version: row.version as number,
    source: row.source as string,
    content: row.content as string,
    wordCount: row.word_count as number,
    status: row.status as string,
  }
}

export function getFinalizedDraft(chapterNumber: number): DraftRecord | null {
  const d = getDb()
  const row = d.prepare(`SELECT * FROM drafts WHERE chapter_number = ? AND status = 'finalized' ORDER BY version DESC LIMIT 1`).get(chapterNumber) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: row.id as number,
    chapterNumber: row.chapter_number as number,
    version: row.version as number,
    source: row.source as string,
    content: row.content as string,
    wordCount: row.word_count as number,
    status: row.status as string,
  }
}

export function updateDraftContent(id: number, content: string): void {
  const d = getDb()
  d.prepare(`UPDATE drafts SET content = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?`).run(content, content.length, id)
}

export function updateDraftStatus(id: number, status: string): void {
  const d = getDb()
  d.prepare(`UPDATE drafts SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id)
}

// ===== 角色 =====

export interface CharacterState {
  location: string
  powerLevel: string
  physicalState: string
  mentalState: string
  keyItems: string
  recentEvents: string
  updatedAtChapter: number
}

export interface Character {
  name: string
  role: string
  gender: string
  age: string
  appearance: string
  personality: string
  background: string
  abilities: string
  motivation: string
  relationships: string
  arc: string
  notes: string
  currentState: CharacterState
}

export function getAllCharacters(): Character[] {
  const d = getDb()
  const rows = d.prepare(`SELECT * FROM characters`).all() as Array<Record<string, unknown>>
  return rows.map(row => ({
    name: row.name as string,
    role: row.role as string,
    gender: row.gender as string,
    age: row.age as string,
    appearance: row.appearance as string,
    personality: row.personality as string,
    background: row.background as string,
    abilities: row.abilities as string,
    motivation: row.motivation as string,
    relationships: row.relationships as string,
    arc: row.arc as string,
    notes: row.notes as string,
    currentState: {
      location: row.cs_location as string || '',
      powerLevel: row.cs_power_level as string || '',
      physicalState: row.cs_physical_state as string || '',
      mentalState: row.cs_mental_state as string || '',
      keyItems: row.cs_key_items as string || '',
      recentEvents: row.cs_recent_events as string || '',
      updatedAtChapter: row.cs_updated_at_chapter as number || 0,
    },
  }))
}

export function saveCharacter(char: Character): void {
  const d = getDb()
  d.prepare(`INSERT OR REPLACE INTO characters
    (name, role, gender, age, appearance, personality, background, abilities, motivation, relationships, arc, notes,
     cs_location, cs_power_level, cs_physical_state, cs_mental_state, cs_key_items, cs_recent_events, cs_updated_at_chapter, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(char.name, char.role, char.gender, char.age, char.appearance, char.personality, char.background,
      char.abilities, char.motivation, char.relationships, char.arc, char.notes,
      char.currentState.location, char.currentState.powerLevel, char.currentState.physicalState,
      char.currentState.mentalState, char.currentState.keyItems, char.currentState.recentEvents,
      char.currentState.updatedAtChapter)
}

export function updateCharacterState(name: string, state: CharacterState): void {
  const d = getDb()
  d.prepare(`UPDATE characters SET
    cs_location=?, cs_power_level=?, cs_physical_state=?, cs_mental_state=?, cs_key_items=?, cs_recent_events=?, cs_updated_at_chapter=?, updated_at=datetime('now')
    WHERE name=?`)
    .run(state.location, state.powerLevel, state.physicalState, state.mentalState, state.keyItems, state.recentEvents, state.updatedAtChapter, name)
}

// ===== 审稿 =====

export function saveReview(draftId: number, content: string): void {
  const d = getDb()
  d.prepare(`INSERT INTO reviews (draft_id, content) VALUES (?, ?)`).run(draftId, content)
}

export function getLatestReview(draftId: number): { content: string } | null {
  const d = getDb()
  const row = d.prepare(`SELECT content FROM reviews WHERE draft_id = ? ORDER BY id DESC LIMIT 1`).get(draftId) as { content: string } | undefined
  return row || null
}

// ===== 修稿 =====

export function saveRevision(draftId: number, content: string): void {
  const d = getDb()
  d.prepare(`INSERT INTO revisions (draft_id, content, status) VALUES (?, ?, 'pending')`).run(draftId, content)
}

export function getPendingRevisions(draftId: number): Array<{ id: number; content: string; draftId: number }> {
  const d = getDb()
  return d.prepare(`SELECT id, content, draft_id as draftId FROM revisions WHERE draft_id = ? AND status = 'pending' ORDER BY id DESC`).all(draftId) as Array<{ id: number; content: string; draftId: number }>
}

export function markRevisionMerged(revisionId: number): void {
  const d = getDb()
  d.prepare(`UPDATE revisions SET status = 'merged' WHERE id = ?`).run(revisionId)
}

/** 获取角色状态摘要字符串（用于写稿 Prompt） */
export function getCharacterStatesSummary(): string {
  const chars = getAllCharacters()
  if (chars.length === 0) return '（暂无角色状态档案）'
  const states = chars.map(c =>
    `${c.name}（${c.role}）| 境界：${c.currentState.powerLevel || '未知'} | 位置：${c.currentState.location || '未知'} | 身体：${c.currentState.physicalState || '正常'} | 心理：${c.currentState.mentalState || '正常'} | 道具：${c.currentState.keyItems || '无'} | 最近：第${c.currentState.updatedAtChapter}章 ${c.currentState.recentEvents || ''}`
  )
  return `【角色状态档案】\n${states.join('\n')}`
}

/** 获取章节要点时间线（用于写稿上下文） */
export function getChapterNotesTimeline(currentChapter: number): string {
  const FULL_WINDOW = 5
  const MAX_CHARS = 3000
  const lines: string[] = []
  const allBps = getAllBlueprints()

  for (const bp of allBps) {
    if (bp.chapterNumber >= currentChapter) continue
    const isRecent = bp.chapterNumber >= currentChapter - FULL_WINDOW
    if (isRecent && bp.notes?.trim()) {
      lines.push(`【第${bp.chapterNumber}章 ${bp.title}】\n${bp.notes.trim()}`)
    } else {
      lines.push(`【第${bp.chapterNumber}章 ${bp.title}】`)
    }
  }

  let result = lines.join('\n\n')
  if (result.length > MAX_CHARS) {
    result = result.slice(-MAX_CHARS)
  }
  return result || '（无章节要点）'
}

/** 获取上章结尾文本 */
export function getPreviousChapterEnding(currentChapter: number): string {
  const prevDraft = getFinalizedDraft(currentChapter - 1)
  if (!prevDraft?.content) return '（无前文）'
  return prevDraft.content.slice(-1000)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
