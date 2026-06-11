/**
 * GenerateDraftCommand — 生成章节草稿
 * 移植自 src/services/workflows/commands/generate-draft.command.ts
 */
import { BaseCommand, type StepContext, type StepCallbacks } from './base-command.js'
import { getPromptTemplate } from '../prompts.js'
import { ChapterPromptBuilder } from '../builder.js'
import {
  getProjectCore, getAllBlueprints, getConfigValue,
  getCharacterStatesSummary, getChapterNotesTimeline, getPreviousChapterEnding,
  getFinalizedDraft, createDraft, getNextDraftVersion,
} from '../database.js'
import { searchRelevantContext } from '../vector-db.js'

export interface ChapterInfo {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  characters: string[]
  keyEvents: string
  suspenseHook?: string
  userGuidance?: string
}

export class GenerateDraftCommand extends BaseCommand<string> {
  constructor(private chapterInfo: ChapterInfo) {
    super()
  }

  async execute(context: StepContext, callbacks: StepCallbacks): Promise<string> {
    callbacks.log('拼装章节上下文 (强类型注入中)...')

    // 读取架构
    const core = getProjectCore
    const architecture = [
      core('premise'), core('characters'), core('worldbuilding'), core('synopsis')
    ].filter(Boolean).join('\n\n---\n\n')

    // 读取全局指导
    const globalGuidance = getConfigValue('global_guidance') || ''

    // 角色状态
    const characterState = getCharacterStatesSummary()

    // 后续蓝图
    const allBlueprints = getAllBlueprints()
    const futureBlueprints = allBlueprints
      .filter(b => b.chapterNumber > this.chapterInfo.chapterNumber && b.chapterNumber <= this.chapterInfo.chapterNumber + 5)
    const futureBlueprintsStr = futureBlueprints.length > 0
      ? futureBlueprints.map(b => `第${b.chapterNumber}章 ${b.title}：${b.keyEvents}`).join('\n')
      : '（无后续蓝图）'

    const isFirstChapter = this.chapterInfo.chapterNumber === 1
    const templateKey = isFirstChapter ? 'first_chapter_draft' : 'next_chapter_draft'
    const template = getPromptTemplate(templateKey)
    if (!template) throw new Error(`未找到模板: ${templateKey}`)

    const wordsPerChapter = parseInt(getConfigValue('words_per_chapter') || '3000')
    const writingStyle = getConfigValue('writing_style') || ''

    // 构建 Prompt（稳定前缀 → 可变后缀，最大化缓存命中）
    const builder = new ChapterPromptBuilder(template)
      .withArchitecture(architecture)
      .withGlobalGuidance(globalGuidance)
      .withWritingStyle(writingStyle)
      .withWordNumber(wordsPerChapter)

    if (!isFirstChapter) {
      const chapterTimeline = getChapterNotesTimeline(this.chapterInfo.chapterNumber)
      callbacks.log(`  📋 已加载章节要点时间线（${chapterTimeline.length} 字）`)

      const previousEnding = getPreviousChapterEnding(this.chapterInfo.chapterNumber)

      // 语义检索：基于本章概要搜索全书相关内容
      const searchQuery = [
        this.chapterInfo.title,
        this.chapterInfo.purpose,
        this.chapterInfo.keyEvents,
        (this.chapterInfo.characters || []).join(' '),
      ].filter(Boolean).join(' ')

      let relevantContext = ''
      try {
        callbacks.log('  🔍 语义检索相关上下文...')
        relevantContext = await searchRelevantContext(
          searchQuery,
          15,
          this.chapterInfo.chapterNumber,
          2500,
        )
        if (!relevantContext.includes('未找到相关上下文')) {
          callbacks.log(`  ✅ 语义检索到 ${relevantContext.length} 字相关上下文`)
        } else {
          callbacks.log('  ⚠️ 向量库暂无数据，使用固定窗口上下文')
        }
      } catch (e) {
        callbacks.log(`  ⚠️ 语义检索失败，回退到固定窗口：${e}`)
      }

      // 优先使用语义检索结果，回退到固定窗口
      const globalSummary = relevantContext && !relevantContext.includes('未找到相关上下文')
        ? `${relevantContext}\n\n【固定窗口上下文（备选）】\n${chapterTimeline}`
        : chapterTimeline

      builder
        .withGlobalSummary(globalSummary)
        .withCharacterStates(characterState)
        .withPreviousEnding(previousEnding)
        .withChapterInfo(this.chapterInfo)
        .withFutureBlueprints(futureBlueprintsStr)
        .withFilteredContext(relevantContext && !relevantContext.includes('未找到相关上下文') ? relevantContext : '（知识库未配置）')
        .withShortSummary('')
        .withUserGuidance(this.chapterInfo.userGuidance?.trim() || '（无微操指导）')
    }

    // Token 预算管控
    const prompt = builder.build()
    const estimatedTokens = Math.ceil(prompt.length / 1.5)
    if (estimatedTokens > 28000) {
      callbacks.log(`⚠️ Prompt 预估 ${estimatedTokens} tokens，超出预算 28000`)
    }

    callbacks.log(`调用 AI 生成章节草稿 (目标字数: ${wordsPerChapter})...`)
    // 追加硬性字数约束
    const finalPrompt = prompt + `\n\n【⚠️ 字数硬限制（必须遵守！）】
你生成的正文总字数不得超过 ${wordsPerChapter} 字。如果你写了超过 ${wordsPerChapter} 字，这是一个严重错误。
你的输出将直接发布为小说正文，必须严格遵守字数上限。
重要：写完核心内容后如果字数已接近 ${wordsPerChapter} 字，请立刻收尾断章。`

    const draftText = await this.callLLM(builder.getSystemRole(), finalPrompt, callbacks)
    const cleanText = this.stripThinkingTags(draftText)

    // 存入数据库
    const nextVersion = getNextDraftVersion(this.chapterInfo.chapterNumber)
    const draft = createDraft(this.chapterInfo.chapterNumber, nextVersion, 'write', cleanText)

    context.data ??= {}
    context.data.draftContent = cleanText
    context.data.draftPath = `miaobi://draft/${draft.id}`
    context.data.chapterNumber = this.chapterInfo.chapterNumber
    context.data.chapterInfo = this.chapterInfo

    callbacks.log(`✅ 草稿已入库 (v${nextVersion}, ${cleanText.length} 字)`)
    return cleanText
  }
}
