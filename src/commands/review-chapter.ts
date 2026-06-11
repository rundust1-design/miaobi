/**
 * ReviewChapterCommand — 一致性审稿
 */
import { BaseCommand, type StepContext, type StepCallbacks } from './base-command.js'
import { getPromptTemplate } from '../prompts.js'
import { ReviewPromptBuilder } from '../builder.js'
import {
  getCharacterStatesSummary, getChapterNotesTimeline,
  getProjectCore, saveReview, getLatestDraft,
} from '../database.js'
import { searchRelevantContext } from '../vector-db.js'

export class ReviewChapterCommand extends BaseCommand<string> {
  constructor(
    private chapterNumber: number,
    private reviewFocus?: string,
  ) {
    super()
  }

  async execute(context: StepContext, callbacks: StepCallbacks): Promise<string> {
    const template = getPromptTemplate('consistency_check')
    if (!template) throw new Error('未找到模板: consistency_check')

    // 从 context.data 或 DB 获取草稿内容
    const draftContent = (context.data?.draftContent as string) || (() => {
      const draft = getLatestDraft(this.chapterNumber)
      if (!draft) throw new Error(`第 ${this.chapterNumber} 章无草稿`)
      return draft.content
    })()

    const characterStates = getCharacterStatesSummary()
    const chapterTimeline = getChapterNotesTimeline(this.chapterNumber + 1)
    const worldBuilding = getProjectCore('worldbuilding') || '（世界观未构建）'

    // 语义检索跨章节相关上下文
    let semanticContext = ''
    try {
      callbacks.log('  🔍 语义检索跨章节关联内容...')
      // 取本章前 800 字作为查询
      const querySample = draftContent.slice(0, 800)
      semanticContext = await searchRelevantContext(querySample, 10, this.chapterNumber)
      if (!semanticContext.includes('未找到相关上下文')) {
        callbacks.log(`  ✅ 检索到跨章节关联内容`)
      }
    } catch (e) {
      callbacks.log(`  ⚠️ 语义检索跳过: ${e}`)
    }

    // 合并语义检索结果与固定窗口
    const globalSummary = semanticContext && !semanticContext.includes('未找到相关上下文')
      ? `${semanticContext}\n\n【固定窗口要点】\n${chapterTimeline}`
      : chapterTimeline

    const builder = new ReviewPromptBuilder(template)
      .withChapterContent(draftContent)
      .withCharacterStates(characterStates)
      .withGlobalSummary(globalSummary)
      .withWorldBuilding(worldBuilding)
      .withReviewFocus(this.reviewFocus || '')

    callbacks.log('  正在进行一致性审查...')
    const reviewResult = await this.callLLMWithBuilder(builder, callbacks)

    // 尝试解析 JSON 审稿结果，失败则保留原文
    try {
      const parsed = this.parseJSON<{ summary: string }>(reviewResult)
      callbacks.log(`  审稿结论: ${parsed.summary}`)
    } catch {
      callbacks.log('  （审稿结果非 JSON 格式，已保留原文）')
    }

    // 存入数据库
    const draft = getLatestDraft(this.chapterNumber)
    if (draft) {
      saveReview(draft.id, reviewResult)
    }

    context.data ??= {}
    context.data.reviewReport = reviewResult
    callbacks.log('  ✅ 审稿完成')
    return reviewResult
  }
}
