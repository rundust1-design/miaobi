/**
 * Global SQLite Database Manager
 *
 * 管理 ~/.miaobi/miaobi-global.db — 替代 projects.json + 项目级 .env 配置
 *
 * 表结构:
 *   projects       — 项目注册表（path, name, last_opened, created_at）
 *   project_config — 项目配置（project_path, key, value），如 LLM 凭据
 */
import Database from 'better-sqlite3'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

const GLOBAL_DIR = join(homedir(), '.miaobi')
const GLOBAL_DB_PATH = join(GLOBAL_DIR, 'miaobi-global.db')

/** 路径标准化：去掉末尾分隔符、统一正斜杠 */
export function normPath(p: string): string {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

// ===== 连接管理 =====

let _gdb: Database.Database | null = null

export function getGlobalDb(): Database.Database {
  if (_gdb) return _gdb

  mkdirSync(GLOBAL_DIR, { recursive: true })
  _gdb = new Database(GLOBAL_DB_PATH)
  _gdb.pragma('journal_mode = WAL')
  _gdb.pragma('foreign_keys = ON')

  _gdb.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      last_opened TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_config (
      project_path TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (project_path, key)
    );

    CREATE INDEX IF NOT EXISTS idx_project_config_path ON project_config(project_path);
  `)

  return _gdb
}

export function closeGlobalDb(): void {
  if (_gdb) {
    _gdb.close()
    _gdb = null
  }
}

// ===== 项目注册表 =====

export interface ProjectEntry {
  name: string
  path: string
  lastOpened: string   // ISO date string
  createdAt: string
}

export function listProjects(): ProjectEntry[] {
  const db = getGlobalDb()
  const rows = db.prepare(
    'SELECT path, name, last_opened, created_at FROM projects ORDER BY last_opened DESC'
  ).all() as Array<{ path: string; name: string; last_opened: string; created_at: string }>
  return rows.map(r => ({
    path: r.path,
    name: r.name,
    lastOpened: r.last_opened,
    createdAt: r.created_at,
  }))
}

export function registerProject(projectPath: string, name?: string): ProjectEntry {
  const db = getGlobalDb()
  const normalized = normPath(projectPath)
  const now = new Date().toISOString()

  const existing = db.prepare('SELECT path, name, last_opened, created_at FROM projects WHERE path = ?')
    .get(normalized) as { path: string; name: string; last_opened: string; created_at: string } | undefined

  if (existing) {
    db.prepare('UPDATE projects SET last_opened = ?, name = ? WHERE path = ?')
      .run(now, name || existing.name, normalized)
    return {
      path: existing.path,
      name: name || existing.name,
      lastOpened: now,
      createdAt: existing.created_at,
    }
  }

  const entry: ProjectEntry = {
    name: name || normalized.split('/').pop() || normalized,
    path: normalized,
    lastOpened: now,
    createdAt: now,
  }
  db.prepare('INSERT INTO projects (path, name, last_opened, created_at) VALUES (?, ?, ?, ?)')
    .run(entry.path, entry.name, entry.lastOpened, entry.createdAt)
  return entry
}

export function deleteProject(projectPath: string): void {
  const db = getGlobalDb()
  const normalized = normPath(projectPath)
  db.prepare('DELETE FROM project_config WHERE project_path = ?').run(normalized)
  db.prepare('DELETE FROM projects WHERE path = ?').run(normalized)
}

// ===== 工作区目录（所有项目的父目录） =====

const WORKSPACE_DIR_KEY = 'workspace_dir'
const GLOBAL_SENTINEL = '__global__'

/** 默认工作区 = 用户文档目录下的"妙笔小说" */
const DEFAULT_WORKSPACE = join(homedir(), 'Documents', '妙笔小说')

export function getWorkspaceDir(): string {
  const db = getGlobalDb()
  const row = db.prepare(
    'SELECT value FROM project_config WHERE project_path = ? AND key = ?'
  ).get(GLOBAL_SENTINEL, WORKSPACE_DIR_KEY) as { value: string } | undefined
  return row?.value || DEFAULT_WORKSPACE
}

export function setWorkspaceDir(dir: string): void {
  const db = getGlobalDb()
  db.prepare(
    `INSERT OR REPLACE INTO project_config (project_path, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))`
  ).run(GLOBAL_SENTINEL, WORKSPACE_DIR_KEY, normPath(dir))
}

/** 根据项目名自动生成路径：工作区/项目名 */
export function projectPathFromName(name: string): string {
  const ws = getWorkspaceDir()
  // 清理名称中的非法字符
  const safeName = name.replace(/[<>:"/\\|?*]/g, '_').trim()
  return join(ws, safeName).replace(/\\/g, '/')
}

// ===== 项目配置 =====

export function getProjectConfig(projectPath: string, key: string): string | null {
  const db = getGlobalDb()
  const normalized = normPath(projectPath)
  const row = db.prepare('SELECT value FROM project_config WHERE project_path = ? AND key = ?')
    .get(normalized, key) as { value: string } | undefined
  return row?.value ?? null
}

export function getAllProjectConfig(projectPath: string): Record<string, string> {
  const db = getGlobalDb()
  const normalized = normPath(projectPath)
  const rows = db.prepare('SELECT key, value FROM project_config WHERE project_path = ?')
    .all(normalized) as Array<{ key: string; value: string }>
  const result: Record<string, string> = {}
  for (const r of rows) result[r.key] = r.value
  return result
}

export function setProjectConfig(projectPath: string, key: string, value: string): void {
  const db = getGlobalDb()
  const normalized = normPath(projectPath)
  db.prepare(
    `INSERT OR REPLACE INTO project_config (project_path, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(normalized, key, value)
}

export function setProjectConfigs(projectPath: string, entries: Record<string, string>): void {
  const db = getGlobalDb()
  const normalized = normPath(projectPath)
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO project_config (project_path, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))`
  )
  const tx = db.transaction((pairs: Array<[string, string]>) => {
    for (const [key, value] of pairs) {
      stmt.run(normalized, key, value)
    }
  })
  tx(Object.entries(entries))
}

// ===== 旧数据迁移 =====

const MIGRATION_SENTINEL_KEY = '__migrated_from_legacy__'
const MIGRATION_SENTINEL_PROJECT = '__global__'

/** 解析 .env 文件为 Record<string, string>（手动解析，不依赖 dotenv） */
function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const content = readFileSync(filePath, 'utf-8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      if (key) result[key] = value
    }
  } catch { /* file doesn't exist or can't be read */ }
  return result
}

const MIGRATABLE_KEYS = [
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_MODEL',
  'DEFAULT_WORDS_PER_CHAPTER',
  'DEFAULT_TOTAL_CHAPTERS',
  // 注意：MIAOBI_HOME 不再迁移（现在总是 {projectPath}/.miaobi）
]

export function isMigrationDone(): boolean {
  try {
    const db = getGlobalDb()
    const row = db.prepare(
      'SELECT value FROM project_config WHERE project_path = ? AND key = ?'
    ).get(MIGRATION_SENTINEL_PROJECT, MIGRATION_SENTINEL_KEY) as { value: string } | undefined
    return row?.value === '1'
  } catch {
    return false
  }
}

export function migrateFromLegacy(): { projects: number; configs: number } {
  if (isMigrationDone()) return { projects: 0, configs: 0 }

  const db = getGlobalDb()
  let projectsMigrated = 0
  let configsMigrated = 0

  // Step A: 迁移 projects.json → projects 表
  const registryPath = join(GLOBAL_DIR, 'projects.json')
  if (existsSync(registryPath)) {
    try {
      const raw = readFileSync(registryPath, 'utf-8')
      const entries = JSON.parse(raw) as Array<{ name: string; path: string; lastOpened: string; createdAt: string }>
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO projects (path, name, last_opened, created_at) VALUES (?, ?, ?, ?)'
      )
      const tx = db.transaction((items: typeof entries) => {
        for (const e of items) {
          const normalized = normPath(e.path)
          const info = stmt.run(normalized, e.name, e.lastOpened || new Date().toISOString(), e.createdAt || new Date().toISOString())
          if (info.changes > 0) projectsMigrated++
        }
      })
      tx(entries)
    } catch (e) {
      console.warn('⚠️ 迁移 projects.json 时出错：', e)
    }
  }

  // Step B: 迁移每个项目的 .env → project_config 表
  const allProjects = db.prepare('SELECT path FROM projects').all() as Array<{ path: string }>
  for (const proj of allProjects) {
    // 检查该项目是否已有全局 DB 配置
    const hasConfig = db.prepare(
      'SELECT COUNT(*) as cnt FROM project_config WHERE project_path = ?'
    ).get(proj.path) as { cnt: number }

    if (hasConfig.cnt > 0) continue // 已有配置，跳过

    const envPath = join(proj.path, '.env')
    if (!existsSync(envPath)) continue

    const envVars = parseEnvFile(envPath)
    const configEntries: Record<string, string> = {}

    for (const key of MIGRATABLE_KEYS) {
      if (envVars[key]) {
        configEntries[key] = envVars[key]
      }
    }

    if (Object.keys(configEntries).length > 0) {
      setProjectConfigs(proj.path, configEntries)
      configsMigrated++
    }
  }

  // Step C: 标记迁移完成
  db.prepare(
    'INSERT OR REPLACE INTO project_config (project_path, key, value, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
  ).run(MIGRATION_SENTINEL_PROJECT, MIGRATION_SENTINEL_KEY, '1')

  if (projectsMigrated > 0 || configsMigrated > 0) {
    console.log(`📦 旧数据迁移完成：${projectsMigrated} 个项目 + ${configsMigrated} 个配置 → 全局数据库`)
  }

  return { projects: projectsMigrated, configs: configsMigrated }
}

/** 读取旧 .env 文件作为后备（用于 loadConfig 回退） */
export function readLegacyEnvConfig(projectPath: string): Record<string, string> {
  const envPath = join(normPath(projectPath), '.env')
  if (!existsSync(envPath)) return {}
  const envVars = parseEnvFile(envPath)
  const result: Record<string, string> = {}
  for (const key of MIGRATABLE_KEYS) {
    if (envVars[key]) result[key] = envVars[key]
  }
  return result
}
