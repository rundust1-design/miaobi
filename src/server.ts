/**
 * 妙笔 Web UI Server — Express + Socket.IO
 *
 * 启动: node dist/server.js  或  pnpm ui
 * 访问: http://localhost:3456
 */
import express from 'express'
import { createServer } from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

import { getConfig, updateConfig, validateConfig, listProjects, registerProject, switchProject as switchCfg } from './config.js'
import { getDb, closeDb, getBlueprint, getLatestDraft, getAllBlueprints, getAllProjectCore, getAllCharacters, getAllConfig } from './database.js'
import {
  executeWorkflow,
  createConfigWorkflow, createArchitectureWorkflow, createDirectoryWorkflow,
  createWriteWorkflow, createRefineWorkflow, createReviewWorkflow,
  createRefineFromReviewWorkflow, createFinalizeWorkflow,
  createOneClickCompleteWorkflow, createRepairFinalizeWorkflow,
} from './workflows.js'
import { ExtractCharactersCommand } from './commands/architecture.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const httpServer = createServer(app)
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8,
})

app.use(express.json({ limit: '10mb' }))

// ===== 静态文件 =====
// 静态文件：先查 dist/public，回退到 src/public
let publicDir = join(__dirname, 'public')
if (!existsSync(publicDir)) {
  publicDir = join(__dirname, '..', 'src', 'public')
}
app.use(express.static(publicDir))

// ===== Socket.IO =====
io.on('connection', (socket) => {
  console.log(`🔗 UI 已连接: ${socket.id}`)

  socket.on('disconnect', () => {
    console.log(`🔌 UI 已断开: ${socket.id}`)
  })
})

// ===== 流式日志回调 =====
function createLogCallbacks() {
  return {
    log: (msg: string) => {
      io.emit('log', { type: 'log', message: msg })
    },
    onChunk: (chunk: string) => {
      io.emit('stream', chunk)
    },
    onStepStart: (name: string, index: number, total: number) => {
      // 步骤开始时清空内容面板
      io.emit('stream-reset')
      io.emit('log', { type: 'step-start', name, index, total })
    },
    onStepComplete: (name: string, _result: unknown) => {
      io.emit('log', { type: 'step-done', name })
    },
  }
}

// ===== 项目状态 =====
app.get('/api/status', (_req, res) => {
  try {
    const cfg = getConfig()
    const db = getDb()

    const configErrors = validateConfig()
    const blueprints = getAllBlueprints()
    const core = getAllProjectCore()
    const chars = getAllCharacters()

    // 检查 novel_config 是否有数据（项目配置是否已生成）
    const configKeys = db.prepare('SELECT COUNT(*) as cnt FROM novel_config').get() as { cnt: number }
    const draftCount = (db.prepare('SELECT COUNT(*) as cnt FROM drafts').get() as { cnt: number }).cnt

    res.json({
      ok: true,
      projectPath: cfg.projectPath,
      llmConfigured: configErrors.length === 0,
      llmErrors: configErrors,
      model: cfg.llm.model,
      totalChapters: blueprints.length > 0 ? Math.max(...blueprints.map(b => b.chapterNumber)) : 0,
      totalPlanned: blueprints.length,
      architectureSteps: Object.keys(core),
      characterCount: chars.length,
      configItems: configKeys.cnt,
      draftCount,
    })
  } catch (e) {
    res.json({ ok: false, error: String(e) })
  }
})

// ===== LLM 设置读写 =====
app.get('/api/settings', (_req, res) => {
  const cfg = getConfig()
  res.json({
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    wordsPerChapter: cfg.writing.wordsPerChapter,
    totalChapters: cfg.writing.totalChapters,
    projectPath: cfg.projectPath,
  })
})

app.post('/api/settings', (req, res) => {
  const { baseUrl, apiKey, model, wordsPerChapter, totalChapters } = req.body
  updateConfig({
    baseUrl: baseUrl?.trim?.(),
    apiKey: apiKey?.trim?.(),
    model: model?.trim?.(),
    wordsPerChapter: wordsPerChapter ? parseInt(String(wordsPerChapter)) : undefined,
    totalChapters: totalChapters ? parseInt(String(totalChapters)) : undefined,
  })
  res.json({ ok: true })
})

// ===== 项目管理 =====
app.get('/api/projects', (_req, res) => {
  const projects = listProjects()
  const current = getConfig()
  res.json({
    projects,
    currentPath: current.projectPath,
  })
})

app.post('/api/projects/switch', (req, res) => {
  const { path } = req.body
  if (!path) return res.status(400).json({ error: '缺少 path' })

  try {
    // 关闭旧数据库连接
    closeDb()
    // 切换到新项目
    switchCfg(path)
    // 重新打开数据库
    getDb()
    res.json({ ok: true, currentPath: path })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.post('/api/projects/create', (req, res) => {
  const { path, name } = req.body
  if (!path) return res.status(400).json({ error: '缺少 path' })

  try {
    const projectPath = resolve(path)
    const miaobiDir = join(projectPath, '.miaobi')
    mkdirSync(miaobiDir, { recursive: true })

    // 创建 .env：继承当前 LLM 配置
    const envPath = join(projectPath, '.env')
    if (!existsSync(envPath)) {
      const currentCfg = getConfig()
      const envContent = `# 妙笔配置
LLM_BASE_URL=${currentCfg.llm.baseUrl}
LLM_API_KEY=${currentCfg.llm.apiKey}
LLM_MODEL=${currentCfg.llm.model}

# 写作默认值
DEFAULT_WORDS_PER_CHAPTER=${currentCfg.writing.wordsPerChapter}
DEFAULT_TOTAL_CHAPTERS=${currentCfg.writing.totalChapters}

# 妙笔目录
MIAOBI_HOME=${miaobiDir}
`
      writeFileSync(envPath, envContent, 'utf-8')
    }

    // 注册到全局列表
    registerProject(projectPath, name)
    // 关闭旧连接，切换到新项目
    closeDb()
    switchCfg(projectPath)
    getDb()

    res.json({ ok: true, currentPath: projectPath })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// ===== 原生文件夹选择对话框 =====
app.post('/api/dialog/select-folder', (_req, res) => {
  try {
    // PowerShell 脚本：弹出 Windows 原生文件夹浏览器
    const script = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{
  Description = '选择小说项目文件夹'
  ShowNewFolderButton = $true
  RootFolder = 'MyComputer'
}
if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const result = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf8', timeout: 120000 })
    const selectedPath = result.trim().replace(/\r\n/g, '\n').split('\n').filter(Boolean).pop() || ''
    if (selectedPath) {
      res.json({ ok: true, path: selectedPath })
    } else {
      res.json({ ok: false, cancelled: true })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

// ===== 配置生成 =====
// ===== 获取已生成的项目配置 =====
app.get('/api/novel-config', (_req, res) => {
  const config = getAllConfig()
  res.json(config)
})

// ===== 获取架构数据 =====
app.get('/api/project-core', (_req, res) => {
  const core = getAllProjectCore()
  res.json(core)
})

app.post('/api/config', async (req, res) => {
  const { idea, chapters, words } = req.body
  if (!idea) return res.status(400).json({ error: '缺少 idea 参数' })


  const workflow = createConfigWorkflow(idea, chapters || 100, words || 3000)

  res.json({ started: true })

  try {
    await executeWorkflow(workflow, {}, createLogCallbacks())
    io.emit('log', { type: 'done', message: '配置生成完成' })
  } catch (e) {
    io.emit('log', { type: 'error', message: String(e) })
  }
})

// ===== 架构生成 =====
app.post('/api/architect', async (req, res) => {
  const { steps, stepGuidance } = req.body
  const selectedSteps = (steps || 'premise,characters,worldbuilding,synopsis').split(',').map((s: string) => s.trim())


  const workflow = createArchitectureWorkflow(selectedSteps)

  res.json({ started: true })

  try {
    const ctx: Record<string, unknown> = {}
    if (stepGuidance) ctx.stepGuidance = stepGuidance
    await executeWorkflow(workflow, { data: ctx }, createLogCallbacks())
    io.emit('log', { type: 'done', message: '架构生成完成' })
  } catch (e) {
    io.emit('log', { type: 'error', message: String(e) })
  }
})

// ===== 从已有角色图谱提取角色卡 =====
app.post('/api/extract-characters', async (_req, res) => {
  const cmd = new ExtractCharactersCommand()
  res.json({ started: true })
  try {
    const count = await cmd.execute({}, createLogCallbacks())
    io.emit('log', { type: 'done', message: `角色卡提取完成，共 ${count} 个角色` })
  } catch (e) {
    io.emit('log', { type: 'error', message: String(e) })
  }
})

// ===== 蓝图生成 =====
app.post('/api/blueprint', async (req, res) => {
  let { mode, start, count, pacing } = req.body
  mode = mode || 'full'

  // 已有蓝图时自动转为追加模式，避免覆盖
  const existing = getAllBlueprints()
  if (mode === 'full' && existing.length > 0) {
    mode = 'append'
    if (!start) start = Math.max(...existing.map(b => b.chapterNumber)) + 1
    io.emit('log', { type: 'log', message: `⚠️ 检测到已有 ${existing.length} 章蓝图，自动转为追加模式（从第 ${start} 章开始）` })
  }


  const workflow = createDirectoryWorkflow(mode, start, count)

  res.json({ started: true })

  try {
    await executeWorkflow(workflow, { data: { pacingGuidance: pacing } }, createLogCallbacks())
    io.emit('log', { type: 'done', message: '蓝图生成完成' })
  } catch (e) {
    io.emit('log', { type: 'error', message: String(e) })
  }
})

// ===== 写稿 =====
app.post('/api/write', async (req, res) => {
  const { chapterNumber, title, role, purpose, keyEvents, characters, suspenseHook, userGuidance } = req.body
  if (!chapterNumber) return res.status(400).json({ error: '缺少 chapterNumber' })

  const bp = getBlueprint(chapterNumber)
  const chapterInfo = {
    chapterNumber,
    title: title || bp?.title || `第${chapterNumber}章`,
    role: role || bp?.role || '发展',
    purpose: purpose || bp?.purpose || '',
    keyEvents: keyEvents || bp?.keyEvents || '',
    characters: characters || bp?.characters || [],
    suspenseHook: suspenseHook || bp?.suspenseHook || '',
    userGuidance: userGuidance || bp?.userGuidance || '',
  }


  const workflow = createWriteWorkflow(chapterInfo)

  res.json({ started: true })

  try {
    await executeWorkflow(workflow, {}, createLogCallbacks())
    io.emit('log', { type: 'done', message: `第${chapterNumber}章 写稿完成` })
  } catch (e) {
    io.emit('log', { type: 'error', message: String(e) })
  }
})

// ===== 修稿 =====
app.post('/api/refine', async (req, res) => {
  const { chapterNumber } = req.body
  if (!chapterNumber) return res.status(400).json({ error: '缺少 chapterNumber' })


  const workflow = createRefineWorkflow(chapterNumber)

  res.json({ started: true })

  try {
    await executeWorkflow(workflow, {}, createLogCallbacks())
    io.emit('log', { type: 'done', message: `第${chapterNumber}章 修稿完成` })
  } catch (e) {
    io.emit('log', { type: 'error', message: String(e) })
  }
})

// ===== 审稿 =====
app.post('/api/review', async (req, res) => {
  const { chapterNumber, focus } = req.body
  if (!chapterNumber) return res.status(400).json({ error: '缺少 chapterNumber' })


  const workflow = createReviewWorkflow(chapterNumber, focus)

  res.json({ started: true })

  try {
    await executeWorkflow(workflow, {}, createLogCallbacks())
    io.emit('log', { type: 'done', message: `第${chapterNumber}章 审稿完成` })
  } catch (e) {
    io.emit('log', { type: 'error', message: String(e) })
  }
})

// ===== 定稿 =====
app.post('/api/finalize', async (req, res) => {
  const { chapterNumber, title } = req.body
  if (!chapterNumber) return res.status(400).json({ error: '缺少 chapterNumber' })


  const draft = getLatestDraft(chapterNumber)
  const bp = getBlueprint(chapterNumber)
  const chapterTitle = title || bp?.title || `第${chapterNumber}章`

  const workflow = createFinalizeWorkflow(chapterNumber, chapterTitle)

  res.json({ started: true })

  try {
    await executeWorkflow(
      workflow,
      {
        data: {
          draftContent: draft?.content || '',
          draftPath: draft ? `miaobi://draft/${draft.id}` : '',
        },
      },
      createLogCallbacks(),
    )
    io.emit('log', { type: 'done', message: `第${chapterNumber}章 定稿完成` })
  } catch (e) {
    io.emit('log', { type: 'error', message: String(e) })
  }
})

// ===== 一键完成 =====
app.post('/api/one-click', async (req, res) => {
  const { chapterNumber, title, role, purpose, keyEvents, characters, suspenseHook, userGuidance, focus } = req.body
  if (!chapterNumber) return res.status(400).json({ error: '缺少 chapterNumber' })

  const bp = getBlueprint(chapterNumber)
  const chapterInfo = {
    chapterNumber,
    title: title || bp?.title || `第${chapterNumber}章`,
    role: role || bp?.role || '发展',
    purpose: purpose || bp?.purpose || '',
    keyEvents: keyEvents || bp?.keyEvents || '',
    characters: characters || bp?.characters || [],
    suspenseHook: suspenseHook || bp?.suspenseHook || '',
    userGuidance: userGuidance || bp?.userGuidance || '',
  }


  const workflow = createOneClickCompleteWorkflow(chapterInfo, focus)

  res.json({ started: true })

  try {
    await executeWorkflow(workflow, {}, createLogCallbacks())
    io.emit('log', { type: 'done', message: `第${chapterNumber}章 一键完成！` })
  } catch (e) {
    io.emit('log', { type: 'error', message: String(e) })
  }
})

// ===== 获取蓝图详情 =====
app.get('/api/blueprint/:chapterNumber', (req, res) => {
  const bp = getBlueprint(parseInt(req.params.chapterNumber))
  if (!bp) return res.status(404).json({ error: '蓝图未找到' })
  res.json(bp)
})

// ===== 全局蓝图列表 =====
app.get('/api/blueprints', (_req, res) => {
  const bps = getAllBlueprints()
  res.json(bps)
})

// ===== 获取草稿 =====
app.get('/api/draft/:chapterNumber', (req, res) => {
  const draft = getLatestDraft(parseInt(req.params.chapterNumber))
  if (!draft) return res.json(null)
  res.json({ content: draft.content, status: draft.status, version: draft.version })
})

// 主页
app.get('/', (_req, res) => {
  const htmlPath = join(publicDir, 'index.html')
  if (existsSync(htmlPath)) {
    res.sendFile(htmlPath)
  } else {
    res.send('<h1>妙笔 UI — 请先构建项目</h1>')
  }
})

// ===== 启动 =====
const PORT = parseInt(process.env.MIAOBI_UI_PORT || '3456')
httpServer.listen(PORT, () => {
  console.log(`\n🚀 妙笔 UI 已启动 → http://localhost:${PORT}\n`)
})
