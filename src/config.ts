import { resolve, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  getGlobalDb, closeGlobalDb,
  listProjects as globalListProjects,
  registerProject as globalRegisterProject,
  getAllProjectConfig, setProjectConfigs, readLegacyEnvConfig,
  type ProjectEntry,
} from './global-db.js'

export type { ProjectEntry }

/** 路径标准化：去掉末尾分隔符、统一正斜杠 */
function normPath(p: string): string {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

// ===== 全局项目注册表（委托给 global-db） =====

export function listProjects(): ProjectEntry[] {
  return globalListProjects()
}

export function registerProject(projectPath: string, name?: string): ProjectEntry {
  return globalRegisterProject(projectPath, name)
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

/** 加载项目配置（优先全局 DB，回退旧 .env，最后硬编码默认值） */
function loadConfig(projectPath: string): MiaobiConfig {
  const normalized = normPath(projectPath)
  const miaobiHome = join(normalized, '.miaobi')
  mkdirSync(miaobiHome, { recursive: true })

  // 1. 尝试从全局 DB 读取
  const dbConfig = getAllProjectConfig(normalized)

  // 2. 如果全局 DB 无配置，尝试回退读取旧 .env
  let fallback: Record<string, string> = {}
  if (Object.keys(dbConfig).length === 0) {
    fallback = readLegacyEnvConfig(normalized)
  }

  const get = (key: string, defaultVal: string): string => {
    if (dbConfig[key]) return dbConfig[key]
    if (fallback[key]) return fallback[key]
    return defaultVal
  }

  return {
    llm: {
      baseUrl: get('LLM_BASE_URL', 'https://api.openai.com/v1'),
      apiKey: get('LLM_API_KEY', ''),
      model: get('LLM_MODEL', 'gpt-4o'),
      embedding: {
        baseUrl: get('EMBEDDING_BASE_URL', get('LLM_BASE_URL', 'https://api.openai.com/v1')),
        apiKey: get('EMBEDDING_API_KEY', get('LLM_API_KEY', '')),
        model: get('EMBEDDING_MODEL', 'text-embedding-3-small'),
      },
    },
    writing: {
      wordsPerChapter: parseInt(get('DEFAULT_WORDS_PER_CHAPTER', '3000')),
      totalChapters: parseInt(get('DEFAULT_TOTAL_CHAPTERS', '100')),
    },
    miaobiHome,
    projectPath: normalized,
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
  if (!cfg.projectPath) return // 无项目时不能更新

  if (partial.baseUrl !== undefined) cfg.llm.baseUrl = partial.baseUrl
  if (partial.apiKey !== undefined) cfg.llm.apiKey = partial.apiKey
  if (partial.model !== undefined) cfg.llm.model = partial.model
  if ((partial as any).embeddingBaseUrl !== undefined) cfg.llm.embedding.baseUrl = (partial as any).embeddingBaseUrl
  if ((partial as any).embeddingApiKey !== undefined) cfg.llm.embedding.apiKey = (partial as any).embeddingApiKey
  if ((partial as any).embeddingModel !== undefined) cfg.llm.embedding.model = (partial as any).embeddingModel
  if (partial.wordsPerChapter !== undefined) cfg.writing.wordsPerChapter = partial.wordsPerChapter
  if (partial.totalChapters !== undefined) cfg.writing.totalChapters = partial.totalChapters

  // 写入全局 DB
  const entries: Record<string, string> = {}
  if (cfg.llm.baseUrl) entries['LLM_BASE_URL'] = cfg.llm.baseUrl
  if (cfg.llm.apiKey) entries['LLM_API_KEY'] = cfg.llm.apiKey
  if (cfg.llm.model) entries['LLM_MODEL'] = cfg.llm.model
  if (cfg.llm.embedding.baseUrl) entries['EMBEDDING_BASE_URL'] = cfg.llm.embedding.baseUrl
  if (cfg.llm.embedding.apiKey) entries['EMBEDDING_API_KEY'] = cfg.llm.embedding.apiKey
  if (cfg.llm.embedding.model) entries['EMBEDDING_MODEL'] = cfg.llm.embedding.model
  entries['DEFAULT_WORDS_PER_CHAPTER'] = String(cfg.writing.wordsPerChapter)
  entries['DEFAULT_TOTAL_CHAPTERS'] = String(cfg.writing.totalChapters)

  setProjectConfigs(cfg.projectPath, entries)

  // 同步写回旧 .env 文件（向后兼容：已有项目可能依赖 .env 文件）
  // 新项目不再创建 .env，但已有项目保持同步
  syncLegacyEnvFile(cfg)
}

/** 向旧 .env 文件同步写回配置（向后兼容已有项目） */
function syncLegacyEnvFile(cfg: MiaobiConfig): void {
  const envPath = resolve(cfg.projectPath, '.env')

  let existing = ''
  if (existsSync(envPath)) {
    try {
      existing = readFileSync(envPath, 'utf-8')
    } catch { /* ignore */ }
  }

  // 如果 .env 不存在，不创建新的（新项目完全走数据库）
  if (!existing) return

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

  for (const [key, value] of Object.entries(replacementMap)) {
    if (!updatedKeys.has(key)) {
      result.push(`${key}=${value}`)
    }
  }

  try {
    writeFileSync(envPath, result.join('\n') + '\n', 'utf-8')
  } catch { /* 写入失败不影响主流程 */ }
}

export function validateConfig(): string[] {
  const errors: string[] = []
  const cfg = getConfig()

  if (!cfg.llm.apiKey) {
    errors.push('LLM_API_KEY 未设置。请在 Web UI 设置中配置 API 密钥')
  }
  if (!cfg.llm.baseUrl) {
    errors.push('LLM_BASE_URL 未设置')
  }

  return errors
}
