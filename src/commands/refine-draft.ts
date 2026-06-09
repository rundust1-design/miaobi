/**
 * RefineDraftCommand — 大神级修稿
 */
import { BaseCommand, type StepContext, type StepCallbacks } from './base-command.js'
import { getPromptTemplate } from '../prompts.js'
import { ChapterPromptBuilder } from '../builder.js'
import { getConfigValue, getChapterNotesTimeline, saveRevision, getLatestDraft } from '../database.js'

export class RefineDraftCommand extends BaseCommand<string> {
  constructor(
    private chapterNumber: number,
    private userRefinePrompt?: string,
  ) {
    super()
  }

  async execute(context: StepContext, callbacks: StepCallbacks): Promise<string> {
    const template = getPromptTemplate('refine_chapter')
    if (!template) throw new Error('未找到模板: refine_chapter')

    // 从 context.data 或 DB 获取草稿内容
    const draftContent = (context.data?.draftContent as string) || (() => {
      const draft = getLatestDraft(this.chapterNumber)
      if (!draft) throw new Error(`第 ${this.chapterNumber} 章无草稿`)
      return draft.content
    })()

    const globalGuidance = getConfigValue('global_guidance') || ''
    const wordsPerChapter = parseInt(getConfigValue('words_per_chapter') || '3000')
    const writingStyle = getConfigValue('writing_style') || ''

    const chapterTimeline = getChapterNotesTimeline(this.chapterNumber)

    const builder = new ChapterPromptBuilder(template)
      .withGlobalSummary(chapterTimeline)
      .withShortSummary('')
      .withDraftContent(draftContent)
      .withGlobalGuidance(globalGuidance)
      .withWordNumber(wordsPerChapter)
      .withWritingStyle(writingStyle)
      .withUserRefinePrompt(this.userRefinePrompt || '')
      .withChapterInfo(`第${this.chapterNumber}章`)

    callbacks.log('  正在精修草稿...')
    const refinedText = await this.callLLMWithBuilder(builder, callbacks)
    const cleanText = this.stripThinkingTags(refinedText)

    // 存入 revision（供自动合并使用）
    const draft = getLatestDraft(this.chapterNumber)
    if (draft) {
      saveRevision(draft.id, cleanText)
    }

    context.data ??= {}
    context.data.refined = cleanText
    callbacks.log(`  ✅ 修稿完成（${cleanText.length} 字）`)
    return cleanText
  }
}
