#!/usr/bin/env node
/**
 * 妙笔 CLI — AI 长篇小说创作引擎
 *
 * 命令：
 *   miaobi init             初始化项目目录和配置
 *   miaobi config <idea>    分析灵感并生成商业小说配置
 *   miaobi architect        运行故事架构生成（四步）
 *   miaobi blueprint        生成章节蓝图
 *   miaobi write <N>        撰写第 N 章草稿
 *   miaobi refine <N>       AI 修稿
 *   miaobi review <N>       一致性审稿
 *   miaobi finalize <N>     定稿 + 后处理分析（内容存储在数据库）
 *   miaobi one-click <N>    一键完成（写稿→修稿→审稿→修复→定稿）
 *   miaobi repair <N>       修复定稿
 *   miaobi import           批量导入已有章节
 */
import { Command } from 'commander'
import { getConfig, validateConfig } from './config.js'
import { migrateFromLegacy, registerProject, setProjectConfigs } from './global-db.js'
import { getDb, getBlueprint, getLatestDraft } from './database.js'
import {
  executeWorkflow, type WorkflowCallbacks,
  createConfigWorkflow, createArchitectureWorkflow, createDirectoryWorkflow,
  createWriteWorkflow, createRefineWorkflow, createReviewWorkflow,
  createRefineFromReviewWorkflow, createFinalizeWorkflow,
  createOneClickCompleteWorkflow, createRepairFinalizeWorkflow,
} from './workflows.js'
import { scanChapterFiles } from './commands/import-chapter.js'
import { ImportChapterCommand } from './commands/import-chapter.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ===== Callbacks =====

const callbacks: WorkflowCallbacks = {
  log: (msg: string) => console.log(msg),
  onStepStart: (name, i, total) => console.log(`\n━━━ ${name} [${i + 1}/${total}] ━━━`),
  onStepComplete: (name, result) => {
    if (result && typeof result === 'string') {
      const preview = result.length > 200 ? result.slice(0, 200) + '...' : result
      console.log(`✅ ${name} 完成: ${preview}`)
    }
  },
}

// ===== 程序 =====

const program = new Command()

program
  .name('miaobi')
  .description('AI 长篇小说创作引擎 — 完整的写稿→修稿→审稿→定稿工作流')
  .version('1.0.0')

// ===== init =====

program.command('init')
  .description('初始化妙笔项目目录和配置')
  .option('-p, --path <path>', '项目路径', process.cwd())
  .action(async (opts) => {
    const projectPath = path.resolve(opts.path)
    const miaobiDir = path.join(projectPath, '.miaobi')
    const promptsDir = path.join(miaobiDir, 'prompts')

    fs.mkdirSync(miaobiDir, { recursive: true })
    fs.mkdirSync(promptsDir, { recursive: true })

    // 注册到全局数据库（不再创建 .env 文件，配置通过 Web UI 设置）
    registerProject(projectPath)

    // 写入默认配置条目（空白值，用户通过 Web UI 填写）
    setProjectConfigs(projectPath, {
      'LLM_BASE_URL': 'https://api.openai.com/v1',
      'LLM_API_KEY': '',
      'LLM_MODEL': 'gpt-4o',
      'DEFAULT_WORDS_PER_CHAPTER': '3000',
      'DEFAULT_TOTAL_CHAPTERS': '100',
      'EMBEDDING_BASE_URL': 'https://api.openai.com/v1',
      'EMBEDDING_API_KEY': '',
      'EMBEDDING_MODEL': 'text-embedding-3-small',
    })

    // 初始化数据库
    process.chdir(projectPath)
    getDb()
    console.log(`✅ 妙笔数据库已初始化: ${path.join(miaobiDir, 'miaobi.db')}`)
    console.log(`\n🎉 项目初始化完成！下一步：
  1. 启动 Web UI 配置 API 密钥: miaobi ui
  2. 或运行 "miaobi config <你的灵感>" 生成商业小说配置
  3. 运行 "miaobi architect" 生成故事架构`)
  })

// ===== config =====

program.command('config')
  .description('分析灵感并生成商业小说配置')
  .argument('<idea>', '小说灵感/构思（用引号括起）')
  .option('-c, --chapters <n>', '总章节数', '100')
  .option('-w, --words <n>', '每章字数', '3000')
  .action(async (idea, opts) => {
    const cfg = getConfig()
    process.chdir(cfg.projectPath)
    getDb()

    const errors = validateConfig()
    if (errors.length > 0) {
      console.error('❌ 配置错误:\n  - ' + errors.join('\n  - '))
      process.exit(1)
    }

    const totalChapters = parseInt(opts.chapters)
    const wordsPerChapter = parseInt(opts.words)

    const workflow = createConfigWorkflow(idea, totalChapters, wordsPerChapter)
    await executeWorkflow(workflow, {}, callbacks)
  })

// ===== architect =====

program.command('architect')
  .description('生成故事架构（前提、角色、世界观、大纲）')
  .option('-s, --steps <list>', '执行步骤 (premise,characters,worldbuilding,synopsis)', 'premise,characters,worldbuilding,synopsis')
  .option('--step-guidance <json>', '每步微操指导 JSON')
  .action(async (opts) => {
    const cfg = getConfig()
    process.chdir(cfg.projectPath)
    getDb()

    const errors = validateConfig()
    if (errors.length > 0) {
      console.error('❌ 配置错误:\n  - ' + errors.join('\n  - '))
      process.exit(1)
    }

    const selectedSteps = opts.steps.split(',').map((s: string) => s.trim())
    let stepGuidance: Record<string, string> = {}

    if (opts.stepGuidance) {
      try {
        stepGuidance = JSON.parse(opts.stepGuidance)
      } catch {
        console.error('⚠️ step-guidance JSON 解析失败，已忽略')
      }
    }

    const workflow = createArchitectureWorkflow(selectedSteps)
    await executeWorkflow(workflow, { data: { stepGuidance } }, callbacks)
  })

// ===== blueprint =====

program.command('blueprint')
  .description('生成章节蓝图')
  .option('-m, --mode <mode>', '模式: full | append', 'full')
  .option('-s, --start <n>', 'append 模式起始章号')
  .option('-c, --count <n>', 'append 模式章数')
  .option('--pacing <text>', '节奏指导')
  .action(async (opts) => {
    const cfg = getConfig()
    process.chdir(cfg.projectPath)
    getDb()

    const errors = validateConfig()
    if (errors.length > 0) {
      console.error('❌ 配置错误:\n  - ' + errors.join('\n  - '))
      process.exit(1)
    }

    const mode = opts.mode === 'append' ? 'append' : 'full'
    const startChapter = opts.start ? parseInt(opts.start) : undefined
    const count = opts.count ? parseInt(opts.count) : undefined

    const workflow = createDirectoryWorkflow(mode, startChapter, count)
    await executeWorkflow(
      workflow,
      { data: { pacingGuidance: opts.pacing } },
      callbacks,
    )
  })

// ===== write =====

program.command('write')
  .description('撰写章节草稿')
  .argument('<chapterNumber>', '章节号')
  .option('-t, --title <title>', '章标题')
  .option('-r, --role <role>', '章角色', '发展')
  .option('-p, --purpose <text>', '章目的')
  .option('-e, --events <text>', '关键事件')
  .option('-c, --characters <list>', '角色列表（逗号分隔）')
  .option('-s, --suspense <text>', '悬念钩子')
  .option('-g, --guidance <text>', '微操指导')
  .action(async (chapterNum, opts) => {
    const cfg = getConfig()
    process.chdir(cfg.projectPath)
    getDb()

    const errors = validateConfig()
    if (errors.length > 0) {
      console.error('❌ 配置错误:\n  - ' + errors.join('\n  - '))
      process.exit(1)
    }

    const chapterNumber = parseInt(chapterNum)
    // 尝试从蓝图读取信息
    const bp = getBlueprint(chapterNumber)
    const chapterInfo = {
      chapterNumber,
      title: opts.title || bp?.title || `第${chapterNumber}章`,
      role: opts.role || bp?.role || '发展',
      purpose: opts.purpose || bp?.purpose || '',
      keyEvents: opts.events || bp?.keyEvents || '',
      characters: opts.characters ? opts.characters.split(',').map((s: string) => s.trim()) : bp?.characters || [],
      suspenseHook: opts.suspense || bp?.suspenseHook || '',
      userGuidance: opts.guidance || bp?.userGuidance || '',
    }

    const workflow = createWriteWorkflow(chapterInfo)
    await executeWorkflow(workflow, {}, callbacks)
  })

// ===== refine =====

program.command('refine')
  .description('AI 修稿')
  .argument('<chapterNumber>', '章节号')
  .option('-p, --prompt <text>', '修稿提示')
  .action(async (chapterNum, opts) => {
    const cfg = getConfig()
    process.chdir(cfg.projectPath)
    getDb()

    const errors = validateConfig()
    if (errors.length > 0) {
      console.error('❌ 配置错误:\n  - ' + errors.join('\n  - '))
      process.exit(1)
    }

    const chapterNumber = parseInt(chapterNum)
    const workflow = createRefineWorkflow(chapterNumber)
    await executeWorkflow(workflow, { data: { userRefinePrompt: opts.prompt } }, callbacks)
  })

// ===== review =====

program.command('review')
  .description('一致性审稿')
  .argument('<chapterNumber>', '章节号')
  .option('-f, --focus <text>', '审稿聚焦')
  .action(async (chapterNum, opts) => {
    const cfg = getConfig()
    process.chdir(cfg.projectPath)
    getDb()

    const errors = validateConfig()
    if (errors.length > 0) {
      console.error('❌ 配置错误:\n  - ' + errors.join('\n  - '))
      process.exit(1)
    }

    const chapterNumber = parseInt(chapterNum)
    const workflow = createReviewWorkflow(chapterNumber, opts.focus)
    await executeWorkflow(workflow, {}, callbacks)
  })

// ===== finalize =====

program.command('finalize')
  .description('定稿 + 后处理分析（内容存储在数据库中）')
  .argument('<chapterNumber>', '章节号')
  .option('-t, --title <title>', '章标题')
  .action(async (chapterNum, opts) => {
    const cfg = getConfig()
    process.chdir(cfg.projectPath)
    getDb()

    const errors = validateConfig()
    if (errors.length > 0) {
      console.error('❌ 配置错误:\n  - ' + errors.join('\n  - '))
      process.exit(1)
    }

    const chapterNumber = parseInt(chapterNum)
    const draft = getLatestDraft(chapterNumber)
    const bp = getBlueprint(chapterNumber)
    const chapterTitle = opts.title || bp?.title || `第${chapterNumber}章`

    const workflow = createFinalizeWorkflow(chapterNumber, chapterTitle)
    await executeWorkflow(
      workflow,
      {
        data: {
          draftContent: draft?.content || '',
          draftPath: draft ? `miaobi://draft/${draft.id}` : '',
        },
      },
      callbacks,
    )
  })

// ===== one-click =====

program.command('one-click')
  .description('一键完成：写稿→修稿→审稿→修复→定稿')
  .argument('<chapterNumber>', '章节号')
  .option('-t, --title <title>', '章标题')
  .option('-r, --role <role>', '章角色', '发展')
  .option('-p, --purpose <text>', '章目的')
  .option('-e, --events <text>', '关键事件')
  .option('-c, --characters <list>', '角色列表（逗号分隔）')
  .option('-s, --suspense <text>', '悬念钩子')
  .option('-g, --guidance <text>', '微操指导')
  .option('-f, --focus <text>', '审稿聚焦')
  .action(async (chapterNum, opts) => {
    const cfg = getConfig()
    process.chdir(cfg.projectPath)
    getDb()

    const errors = validateConfig()
    if (errors.length > 0) {
      console.error('❌ 配置错误:\n  - ' + errors.join('\n  - '))
      process.exit(1)
    }

    const chapterNumber = parseInt(chapterNum)
    const bp = getBlueprint(chapterNumber)
    const chapterInfo = {
      chapterNumber,
      title: opts.title || bp?.title || `第${chapterNumber}章`,
      role: opts.role || bp?.role || '发展',
      purpose: opts.purpose || bp?.purpose || '',
      keyEvents: opts.events || bp?.keyEvents || '',
      characters: opts.characters ? opts.characters.split(',').map((s: string) => s.trim()) : bp?.characters || [],
      suspenseHook: opts.suspense || bp?.suspenseHook || '',
      userGuidance: opts.guidance || bp?.userGuidance || '',
    }

    console.log(`\n🚀 一键完成 第${chapterNumber}章 "${chapterInfo.title}"\n`)

    const workflow = createOneClickCompleteWorkflow(chapterInfo, opts.focus)
    await executeWorkflow(workflow, {}, callbacks)
  })

// ===== repair =====

program.command('repair')
  .description('修复定稿（审稿→修复→定稿）')
  .argument('<chapterNumber>', '章节号')
  .option('-t, --title <title>', '章标题')
  .option('--only-failed', '仅执行失败的步骤', false)
  .action(async (chapterNum, opts) => {
    const cfg = getConfig()
    process.chdir(cfg.projectPath)
    getDb()

    const errors = validateConfig()
    if (errors.length > 0) {
      console.error('❌ 配置错误:\n  - ' + errors.join('\n  - '))
      process.exit(1)
    }

    const chapterNumber = parseInt(chapterNum)
    const bp = getBlueprint(chapterNumber)
    const chapterTitle = opts.title || bp?.title || `第${chapterNumber}章`

    const workflow = createRepairFinalizeWorkflow(chapterNumber, chapterTitle, opts.onlyFailed)
    await executeWorkflow(workflow, {}, callbacks)
  })

// ===== import =====

program.command('import')
  .description('批量导入已有章节（扫描 第N章*.txt）')
  .option('-p, --path <path>', '项目路径（含 txt/md 文件）', process.cwd())
  .option('--dry-run', '仅列出将导入的文件，不实际执行', false)
  .action(async (opts) => {
    const projectPath = path.resolve(opts.path)
    process.chdir(projectPath)
    getDb()

    const files = scanChapterFiles(projectPath)

    if (files.length === 0) {
      console.log('⚠️  未找到章节文件。文件命名格式: 第N章 标题.txt')
      return
    }

    console.log(`发现 ${files.length} 个章节文件:\n`)
    for (const f of files) {
      console.log(`  第${f.chapterNumber}章 ${f.chapterTitle} (${f.rawText.length} 字)`)
    }

    if (opts.dryRun) {
      console.log('\n（--dry-run 模式，未执行导入）')
      return
    }

    console.log('\n开始导入...\n')

    const errors = validateConfig()
    if (errors.length > 0) {
      console.log('⚠️  LLM 未配置，将使用精简蓝图导入（仅保留文本）')
    }

    for (const file of files) {
      try {
        const cmd = new ImportChapterCommand(file)
        await cmd.execute({}, callbacks)
      } catch (err) {
        console.error(`❌ 导入第${file.chapterNumber}章失败: ${err}`)
      }
    }

    console.log('\n🎉 导入完成！')
  })

// ===== 解析 =====

// 启动时自动迁移旧数据（projects.json + .env → 全局数据库）
migrateFromLegacy()

program.parse()
