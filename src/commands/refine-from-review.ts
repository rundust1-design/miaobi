/**
 * RefineFromReviewCommand — 审稿驱动修稿
 */
import { BaseCommand, type StepContext, type StepCallbacks } from './base-command.js'
import { getPromptTemplate } from '../prompts.js'
import { ChapterPromptBuilder } from '../builder.js'
import { getConfigValue, saveRevision, getLatestDraft } from '../database.js'

export class RefineFromReviewCommand extends BaseCommand<string> {
  constructor(
    private chapterNumber: number,
    private userRefinePrompt?: string,
  ) {
    super()
  }

  async execute(context: StepContext, callbacks: StepCallbacks): Promise<string> {
    const template = getPromptTemplate('refine_from_review')
    if (!template) throw new Error('未找到模板: refine_from_review')

    // 从 context.data 或 DB 获取草稿内容
    const draftContent = (context.data?.draftContent as string) || (() => {
      const draft = getLatestDraft(this.chapterNumber)
      if (!draft) throw new Error(`第 ${this.chapterNumber} 章无草稿`)
      return draft.content
    })()
    const reviewReport = (context.data?.reviewReport as string) || ''

    const globalGuidance = getConfigValue('global_guidance') || ''

    const builder = new ChapterPromptBuilder(template)
      .withReviewReport(reviewReport)
      .withDraftContent(draftContent)
      .withGlobalGuidance(globalGuidance)
      .withUserRefinePrompt(this.userRefinePrompt || (context.data?.userRefinePrompt as string) || '')

    callbacks.log('  正在根据审稿报告精准修复...')
    const fixResult = await this.callLLMWithBuilder(builder, callbacks)
    const cleanText = this.stripThinkingTags(fixResult)

    // 存入 revision
    const draft = getLatestDraft(this.chapterNumber)
    if (draft) {
      saveRevision(draft.id, cleanText)
    }

    context.data ??= {}
    context.data.refined = cleanText
    callbacks.log('  ✅ 审稿修复完成')
    return cleanText
  }
}
