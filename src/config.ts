import { config } from 'dotenv'
import { resolve, join, normalize } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

// ===== 全局项目注册表 =====
const GLOBAL_DIR = join(homedir(), '.miaobi')
const REGISTRY_PATH = join(GLOBAL_DIR, 'projects.json')

/** 路径标准化：去掉末尾分隔符、统一反斜杠 */
function normPath(p: string): string {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

export interface ProjectEntry {
  name: string
  path: string
  lastOpened: string  // ISO date string
  createdAt: string
}

function readRegistry(): ProjectEntry[] {
  try {
    if (existsSync(REGISTRY_PATH)) {
      return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'))
    }
  } catch { /* ignore */ }
  return []
}

function writeRegistry(entries: ProjectEntry[]): void {
  mkdirSync(GLOBAL_DIR, { recursive: true })
  writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2), 'utf-8')
}

export function listProjects(): ProjectEntry[] {
  return readRegistry()
}

export function registerProject(projectPath: string, name?: string): ProjectEntry {
  const normalized = normPath(projectPath)
  const entries = readRegistry()
  // 也标准化已有条目路径以防止旧脏数据
  for (const e of entries) e.path = normPath(e.path)
  const existing = entries.find(e => e.path === normalized)
  const now = new Date().toISOString()
  if (existing) {
    existing.lastOpened = now
    if (name) existing.name = name
    writeRegistry(entries)
    return existing
  }
  const entry: ProjectEntry = {
    name: name || normalized.split('/').pop() || normalized,
    path: normalized,
    lastOpened: now,
    createdAt: now,
  }
  entries.push(entry)
  writeRegistry(entries)
  return entry
}

// ===== 动态配置 =====

export interface MiaobiConfig {
  llm: {
    baseUrl: string
    apiKey: string
    model: string
    embedding: {
      baseUrl: string
      apiKey: string
      model: string
    }
  }
  writing: {
    wordsPerChapter: number
    totalChapters: number
  }
  miaobiHome: string
  projectPath: string
}

/** 重新加载项目 .env + 重建配置缓存 */
function loadConfig(projectPath: string): MiaobiConfig {
  const envPath = resolve(projectPath, '.env')
  if (existsSync(envPath)) {
    config({ path: envPath, override: true })
  }

  const miaobiHome = process.env.MIAOBI_HOME || join(projectPath, '.miaobi')
  mkdirSync(miaobiHome, { recursive: true })

  return {
    llm: {
      baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.LLM_API_KEY || '',
      model: process.env.LLM_MODEL || 'gpt-4o',
      embedding: {
        baseUrl: process.env.EMBEDDING_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
        apiKey: process.env.EMBEDDING_API_KEY || process.env.LLM_API_KEY || '',
        model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      },
    },
    writing: {
      wordsPerChapter: parseInt(process.env.DEFAULT_WORDS_PER_CHAPTER || '3000'),
      totalChapters: parseInt(process.env.DEFAULT_TOTAL_CHAPTERS || '100'),
    },
    miaobiHome,
    projectPath,
  }
}

let _config: MiaobiConfig | null = null
let _noProject = true // 启动时不自动绑定项目

/** 取消自动默认项目：启动后必须手动选择 */
export function requireProjectSelection(): void {
  _noProject = true
  _config = null
}

export function getConfig(): MiaobiConfig {
  if (_config) return _config
  // 未选择项目时返回空占位配置
  if (_noProject) {
    return {
      llm: { baseUrl: '', apiKey: '', model: '', embedding: { baseUrl: '', apiKey: '', model: '' } },
      writing: { wordsPerChapter: 3000, totalChapters: 100 },
      miaobiHome: '',
      projectPath: '',
    }
  }
  // 首启：用当前进程 cwd，并自动注册（仅 CLI 模式走这里）
  const projectPath = normPath(process.cwd())
  _config = loadConfig(projectPath)
  registerProject(projectPath)
  return _config
}

/** 切换到另一个项目（会清空 DB 连接） */
export function switchProject(projectPath: string): MiaobiConfig {
  // 通知外部先关闭 DB（避免跨项目连接错乱）
  // caller 负责先调 closeDb()
  const normalized = normPath(projectPath)
  _noProject = false
  _config = loadConfig(normalized)
  registerProject(normalized)
  return _config
}

/** 仅重置配置缓存（配合 DB reset 使用） */
export function resetConfig(): void {
  _config = null
}

export function updateConfig(partial: Partial<MiaobiConfig['llm'] & MiaobiConfig['writing'] & {
  embeddingBaseUrl?: string; embeddingApiKey?: string; embeddingModel?: string
}>): void {
  const cfg = getConfig()
  if (partial.baseUrl !== undefined) cfg.llm.baseUrl = partial.baseUrl
  if (partial.apiKey !== undefined) cfg.llm.apiKey = partial.apiKey
  if (partial.model !== undefined) cfg.llm.model = partial.model
  if ((partial as any).embeddingBaseUrl !== undefined) cfg.llm.embedding.baseUrl = (partial as any).embeddingBaseUrl
  if ((partial as any).embeddingApiKey !== undefined) cfg.llm.embedding.apiKey = (partial as any).embeddingApiKey
  if ((partial as any).embeddingModel !== undefined) cfg.llm.embedding.model = (partial as any).embeddingModel
  if (partial.wordsPerChapter !== undefined) cfg.writing.wordsPerChapter = partial.wordsPerChapter
  if (partial.totalChapters !== undefined) cfg.writing.totalChapters = partial.totalChapters

  // 写回 .env 文件，确保重启后配置不丢失
  if (cfg.projectPath) {
    writeEnvFile(cfg)
  }
}

function writeEnvFile(cfg: MiaobiConfig): void {
  const envPath = resolve(cfg.projectPath, '.env')
  // 读取现有 .env 文件，保留注释和非 LLM/WRITING 相关行
  let existing = ''
  if (existsSync(envPath)) {
    existing = readFileSync(envPath, 'utf-8')
  }

  const envLines = existing.split(/\r?\n/)
  const replacementMap: Record<string, string> = {
    LLM_BASE_URL: cfg.llm.baseUrl || '',
    LLM_API_KEY: cfg.llm.apiKey || '',
    LLM_MODEL: cfg.llm.model || '',
    EMBEDDING_BASE_URL: cfg.llm.embedding.baseUrl || '',
    EMBEDDING_API_KEY: cfg.llm.embedding.apiKey || '',
    EMBEDDING_MODEL: cfg.llm.embedding.model || '',
    DEFAULT_WORDS_PER_CHAPTER: String(cfg.writing.wordsPerChapter),
    DEFAULT_TOTAL_CHAPTERS: String(cfg.writing.totalChapters),
  }

  const updatedKeys = new Set<string>()
  const result: string[] = []

  for (const line of envLines) {
    const trimmed = line.trim()
    // 保留空行和注释
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line)
      continue
    }
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) {
      result.push(line)
      continue
    }
    const key = trimmed.slice(0, eqIdx).trim()
    if (key in replacementMap) {
      result.push(`${key}=${replacementMap[key]}`)
      updatedKeys.add(key)
    } else {
      result.push(line)
    }
  }

  // 追加新键
  for (const [key, value] of Object.entries(replacementMap)) {
    if (!updatedKeys.has(key)) {
      result.push(`${key}=${value}`)
    }
  }

  writeFileSync(envPath, result.join('\n') + '\n', 'utf-8')
}

export function validateConfig(): string[] {
  const errors: string[] = []
  const cfg = getConfig()

  if (!cfg.llm.apiKey) {
    errors.push('LLM_API_KEY 未设置。请在 .env 文件中配置 API 密钥')
  }
  if (!cfg.llm.baseUrl) {
    errors.push('LLM_BASE_URL 未设置')
  }

  return errors
}
