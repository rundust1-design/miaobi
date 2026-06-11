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

import { getConfig, updateConfig, validateConfig, listProjects, registerProject, switchProject as switchCfg, requireProjectSelection } from './config.js'
import { getDb, closeDb, getBlueprint, getLatestDraft, getDraftByChapterAndVersion, getFinalizedDraft, getAllBlueprints, getAllProjectCore, getAllCharacters, getAllConfig, getConfigValue, getAllDraftsSummary, getAllFinalizedSummary } from './database.js'
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

// ===== 中止控制 =====
let currentAbortController: AbortController | null = null

function createAbortContext(): { controller: AbortController; contextData: Record<string, unknown> } {
  currentAbortController?.abort() // 保险：先取消上一个
  const controller = new AbortController()
  currentAbortController = controller
  return { controller, contextData: { abortSignal: controller.signal } }
}

app.use(express.json({ limit: '10mb' }))

// ===== 静态文件 =====
// 静态文件：先查 dist/public，回退到 src/public
let publicDir = join(__dirname, 'public')
if (!existsSync(publicDir)) {
  publicDir = join(__dirname, '..', 'src', 'public')
}
app.use(express.static(publicDir))

// 启动时不自动绑定项目 — 强制用户选择
requireProjectSelection()

// ===== Socket.IO =====
io.on('connection', (socket) => {
  console.log(`🔗 UI 已连接: ${socket.id}`)

  socket.on('disconnect', () => {
    console.log(`🔌 UI 已断开: ${socket.id}`)
  })
})

// ===== 流式日志回调 =====
function createLogCallbacks(signal?: AbortSignal) {
  return {
    log: (msg: string) => {
      io.emit('log', { type: 'log', message: msg })
    },
    onChunk: (chunk: string) => {
      io.emit('stream', chunk)
    },
    onStepStart: (name: string, index: number, total: number) => {
      io.emit('stream-reset')
      io.emit('log', { type: 'step-start', name, index, total })
    },
    onStepComplete: (name: string, _result: unknown) => {
      io.emit('log', { type: 'step-done', name })
    },
    signal,
  }
}

// 封装每个操作：自动注入 abort signal + 统一错误处理
async function withAbortContext(
  fn: (signal: AbortSignal) => Promise<void>,
  doneMessage: string,
) {
  const { controller, contextData: ctxData } = createAbortContext()
  try {
    await fn(ctxData.abortSignal as AbortSignal)
    io.emit('log', { type: 'done', message: doneMessage })
  } catch (e: unknown) {
    const err = e as Error & { name?: string }
    if (err?.name === 'AbortError' || String(err?.message || '').includes('取消')) {
      // already emitted in /api/abort
    } else {
      io.emit('log', { type: 'error', message: String(e) })
    }
  } finally {
    if (currentAbortController === controller) currentAbortController = null
  }
}

// ===== 中止操作 =====
app.post('/api/abort', (_req, res) => {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
    io.emit('log', { type: 'log', message: '🛑 用户取消了操作' })
    io.emit('log', { type: 'done', message: '操作已取消' })
    res.json({ ok: true, message: '已中止' })
  } else {
    res.json({ ok: true, message: '没有运行中的操作' })
  }
})

// ===== 项目状态 =====
app.get('/api/status', (_req, res) => {
  try {
    const cfg = getConfig()
    if (!cfg.projectPath) {
      // 尚未选择项目
      res.json({ ok: true, noProject: true, llmConfigured: false })
      return
    }
    const db = getDb()

    const configErrors = validateConfig()
    const blueprints = getAllBlueprints()
    const core = getAllProjectCore()
    const chars = getAllCharacters()

    // 检查 novel_config 是否有数据（项目配置是否已生成）
    const configKeys = db.prepare('SELECT COUNT(*) as cnt FROM novel_config').get() as { cnt: number }
    const draftCount = (db.prepare('SELECT COUNT(*) as cnt FROM drafts').get() as { cnt: number }).cnt
    const finalizedCount = (db.prepare("SELECT COUNT(*) as cnt FROM drafts WHERE status = 'finalized'").get() as { cnt: number }).cnt

    res.json({
      ok: true,
      projectPath: cfg.projectPath,
      llmConfigured: configErrors.length === 0,
      llmErrors: configErrors,
      model: cfg.llm.model,
      totalPlanned: blueprints.length,
      finalizedCount,
      architectureSteps: Object.keys(core),
      characterCount: chars.length,
      configItems: configKeys.cnt,
      draftCount,
      totalChapters: cfg.writing.totalChapters,
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

    // 创建 .env：继承已有项目的 LLM 配置
    const envPath = join(projectPath, '.env')
    if (!existsSync(envPath)) {
      let baseUrl = '', apiKey = '', model = '', wordsPer = '3000', totalChap = '100'
      const currentCfg = getConfig()
      if (currentCfg.llm.apiKey) {
        baseUrl = currentCfg.llm.baseUrl
        apiKey = currentCfg.llm.apiKey
        model = currentCfg.llm.model
        wordsPer = String(currentCfg.writing.wordsPerChapter)
        totalChap = String(currentCfg.writing.totalChapters)
      } else {
        // 未选项目时，从注册表中查找已有项目的 .env 继承
        for (const proj of listProjects()) {
          const inheritEnv = join(proj.path, '.env')
          if (existsSync(inheritEnv)) {
            const content = readFileSync(inheritEnv, 'utf-8')
            const m = (k: string) => (content.match(new RegExp('^' + k + '=(.+)', 'm')) || [])[1] || ''
            baseUrl = m('LLM_BASE_URL') || 'https://api.openai.com/v1'
            apiKey = m('LLM_API_KEY') || ''
            model = m('LLM_MODEL') || 'gpt-4o'
            wordsPer = m('DEFAULT_WORDS_PER_CHAPTER') || '3000'
            totalChap = m('DEFAULT_TOTAL_CHAPTERS') || '100'
            break
          }
        }
      }
      const envContent = '# 妙笔配置\n' +
        'LLM_BASE_URL=' + baseUrl + '\n' +
        'LLM_API_KEY=' + apiKey + '\n' +
        'LLM_MODEL=' + model + '\n\n' +
        '# 写作默认值\n' +
        'DEFAULT_WORDS_PER_CHAPTER=' + wordsPer + '\n' +
        'DEFAULT_TOTAL_CHAPTERS=' + totalChap + '\n\n' +
        '# 妙笔目录\n' +
        'MIAOBI_HOME=' + miaobiDir + '\n'
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
    // 写临时 PowerShell 脚本（UTF-16 LE + BOM = PowerShell 原生编码）
    const scriptPath = join(__dirname, '.folder-dialog.ps1')
    const scriptLines = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{',
      "  Description = '选择小说项目文件夹'",
      '  ShowNewFolderButton = $true',
      "  RootFolder = 'MyComputer'",
      '}',
      "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }",
      '',
    ]
    writeFileSync(scriptPath, '﻿' + scriptLines.join('\r\n'), 'utf-8')
    const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { encoding: 'utf8', timeout: 120000 })
    // 清理临时文件
    try { require('fs').unlinkSync(scriptPath) } catch {}
    const selectedPath = result.trim()
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
  withAbortContext(
    signal => executeWorkflow(workflow, { data: {} }, createLogCallbacks(signal)),
    '配置生成完成',
  )
})

// ===== 架构生成 =====
app.post('/api/architect', async (req, res) => {
  const { steps, stepGuidance } = req.body
  const selectedSteps = (steps || 'premise,characters,worldbuilding,synopsis').split(',').map((s: string) => s.trim())

  const workflow = createArchitectureWorkflow(selectedSteps)
  res.json({ started: true })
  withAbortContext(
    signal => executeWorkflow(workflow, { data: { stepGuidance } }, createLogCallbacks(signal)),
    '架构生成完成',
  )
})

// ===== 从已有角色图谱提取角色卡 =====
app.post('/api/extract-characters', async (_req, res) => {
  const cmd = new ExtractCharactersCommand()
  res.json({ started: true })
  withAbortContext(
    async signal => {
      const count = await cmd.execute({}, createLogCallbacks(signal))
      io.emit('log', { type: 'done', message: `角色卡提取完成，共 ${count} 个角色` })
    },
    '',
  )
})

// ===== 蓝图生成 =====
app.post('/api/blueprint', async (req, res) => {
  let { mode, start, count, pacing } = req.body
  mode = mode || 'full'

  const totalChapters = parseInt(getConfigValue('total_chapters') || '100')

  // 按连续区间拆分为多组任务
  interface GapGroup { start: number; count: number }
  let gapGroups: GapGroup[] = []

  const existing = getAllBlueprints()
  const existingNums = new Set(existing.map(b => b.chapterNumber))

  if (mode === 'full' || existing.length > 0) {
    const missing: number[] = []
    for (let i = 1; i <= totalChapters; i++) {
      if (!existingNums.has(i)) missing.push(i)
    }

    if (missing.length === 0) {
      gapGroups.push({ start: totalChapters + 1, count: count || totalChapters })
      io.emit('log', { type: 'log', message: `⚠️ 已满 ${totalChapters} 章，从第 ${totalChapters + 1} 章开始追加` })
    } else {
      let gs = missing[0], gc = 1
      for (let i = 1; i < missing.length; i++) {
        if (missing[i] === missing[i - 1] + 1) { gc++ }
        else { gapGroups.push({ start: gs, count: gc }); gs = missing[i]; gc = 1 }
      }
      gapGroups.push({ start: gs, count: gc })
      io.emit('log', { type: 'log', message: `⚠️ 已有 ${existing.length}/${totalChapters} 章，填充 ${missing.length} 个缺口：${missing.join(', ')}` })
    }
  } else {
    gapGroups.push({ start: start || 1, count: count || totalChapters })
  }

  res.json({ started: true })
  withAbortContext(
    async signal => {
      for (const group of gapGroups) {
        if (signal.aborted) break
        const workflow = createDirectoryWorkflow('append', group.start, group.count)
        await executeWorkflow(workflow, { data: { pacingGuidance: pacing } }, createLogCallbacks(signal))
      }
    },
    '蓝图生成完成',
  )
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
  withAbortContext(
    signal => executeWorkflow(workflow, { data: {} }, createLogCallbacks(signal)),
    `第${chapterNumber}章 写稿完成`,
  )
})

// ===== 修稿 =====
app.post('/api/refine', async (req, res) => {
  const { chapterNumber } = req.body
  if (!chapterNumber) return res.status(400).json({ error: '缺少 chapterNumber' })

  const workflow = createRefineWorkflow(chapterNumber)
  res.json({ started: true })
  withAbortContext(
    signal => executeWorkflow(workflow, { data: {} }, createLogCallbacks(signal)),
    `第${chapterNumber}章 修稿完成`,
  )
})

// ===== 审稿 =====
app.post('/api/review', async (req, res) => {
  const { chapterNumber, focus } = req.body
  if (!chapterNumber) return res.status(400).json({ error: '缺少 chapterNumber' })

  const workflow = createReviewWorkflow(chapterNumber, focus)
  res.json({ started: true })
  withAbortContext(
    signal => executeWorkflow(workflow, { data: {} }, createLogCallbacks(signal)),
    `第${chapterNumber}章 审稿完成`,
  )
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
  withAbortContext(
    signal => executeWorkflow(workflow, {
      data: {
        draftContent: draft?.content || '',
        draftPath: draft ? `miaobi://draft/${draft.id}` : '',
      },
    }, createLogCallbacks(signal)),
    `第${chapterNumber}章 定稿完成`,
  )
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
  withAbortContext(
    signal => executeWorkflow(workflow, { data: {} }, createLogCallbacks(signal)),
    `第${chapterNumber}章 一键完成！`,
  )
})

// ===== 全部章节一键完成（批量） =====
app.post('/api/one-click-all', async (req, res) => {
  const { startChapter, endChapter, reviewFocus } = req.body
  res.json({ started: true })

  withAbortContext(
    async signal => {
      const allBP = getAllBlueprints()
      if (allBP.length === 0) {
        io.emit('log', { type: 'error', message: '没有蓝图，请先生成章节蓝图' })
        return
      }

      // 过滤出未定稿的章节
      const finalized = new Set(getAllFinalizedSummary().map(f => f.chapterNumber))
      let targets = allBP.filter(b => !finalized.has(b.chapterNumber))
      if (startChapter) targets = targets.filter(b => b.chapterNumber >= startChapter)
      if (endChapter) targets = targets.filter(b => b.chapterNumber <= endChapter)
      targets.sort((a, b) => a.chapterNumber - b.chapterNumber)

      if (targets.length === 0) {
        io.emit('log', { type: 'done', message: '所有章节已完成定稿！' })
        return
      }

      io.emit('log', { type: 'log', message: `📋 共 ${targets.length} 章待处理：第 ${targets[0].chapterNumber}-${targets[targets.length - 1].chapterNumber} 章` })

      let completed = 0
      for (const bp of targets) {
        if (signal.aborted) {
          io.emit('log', { type: 'log', message: '🛑 批量任务已取消' })
          return
        }
        const cn = bp.chapterNumber
        const chapterInfo = {
          chapterNumber: cn,
          title: bp.title || `第${cn}章`,
          role: bp.role || '发展',
          purpose: bp.purpose || '',
          keyEvents: bp.keyEvents || '',
          characters: bp.characters || [],
          suspenseHook: bp.suspenseHook || '',
          userGuidance: bp.userGuidance || '',
        }
        io.emit('log', { type: 'step-start', name: `第${cn}章 一键完成`, index: completed, total: targets.length })
        try {
          const workflow = createOneClickCompleteWorkflow(chapterInfo, reviewFocus)
          await executeWorkflow(workflow, { data: {} }, createLogCallbacks(signal))
          completed++
        } catch (e: any) {
          if (e?.message?.includes('取消')) return
          io.emit('log', { type: 'error', message: `第${cn}章 失败: ${e}` })
          // 继续下一章
        }
      }
      io.emit('log', { type: 'done', message: `🎉 批量完成！成功 ${completed}/${targets.length} 章` })
    },
    `全部章节一键完成！`,
  )
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

app.get('/api/draft-content', (req, res) => {
  const ch = parseInt(req.query.chapterNumber as string)
  const ver = parseInt(req.query.version as string)
  if (!ch || !ver) return res.status(400).json({ error: 'Missing chapterNumber or version' })
  const draft = getDraftByChapterAndVersion(ch, ver)
  if (!draft) return res.json(null)
  res.json({ content: draft.content, status: draft.status, version: draft.version, wordCount: draft.wordCount })
})

app.get('/api/finalized-content', (req, res) => {
  const ch = parseInt(req.query.chapterNumber as string)
  if (!ch) return res.status(400).json({ error: 'Missing chapterNumber' })
  const draft = getFinalizedDraft(ch)
  if (!draft) return res.json(null)
  res.json({ content: draft.content, status: draft.status, version: draft.version, wordCount: draft.wordCount })
})

// ===== 草稿 & 定稿列表 =====
app.get('/api/drafts', (_req, res) => {
  const drafts = getAllDraftsSummary()
  res.json(drafts)
})

app.get('/api/finalized', (_req, res) => {
  const finalized = getAllFinalizedSummary()
  res.json(finalized)
})

// ===== 角色列表 =====
app.get('/api/characters', (_req, res) => {
  const chars = getAllCharacters()
  res.json(chars)
})

// ===== 导出已定稿章节为 .txt =====
import { safeFilename } from './utils.js'
app.post('/api/export-finalized', async (req, res) => {
  try {
    const cfg = getConfig()
    if (!cfg.projectPath) return res.status(400).json({ error: '未选择项目' })

    const finalized = getAllFinalizedSummary()
    if (finalized.length === 0) return res.json({ ok: true, count: 0, message: '没有已定稿的章节' })

    const bps = getAllBlueprints()
    const bpMap = new Map(bps.map(b => [b.chapterNumber, b]))

    let written = 0
    const errors: string[] = []

    for (const f of finalized) {
      const draft = getFinalizedDraft(f.chapterNumber)
      if (!draft || !draft.content) {
        errors.push(`第${f.chapterNumber}章无内容`)
        continue
      }
      const bp = bpMap.get(f.chapterNumber)
      const title = bp?.title || ''
      const safeTitle = title ? ` ${safeFilename(title)}` : ''
      const filePath = `${cfg.projectPath}/第${f.chapterNumber}章${safeTitle}.txt`
      const titleLine = title
        ? `第${f.chapterNumber}章 ${title}\n\n`
        : `第${f.chapterNumber}章\n\n`
      writeFileSync(filePath, titleLine + draft.content.replace(/^#+ .*\n*/, ''), 'utf-8')
      written++
    }

    res.json({ ok: true, count: written, errors: errors.length ? errors : undefined,
      message: `成功导出 ${written}/${finalized.length} 章` })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
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
