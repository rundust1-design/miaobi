/**
 * Prompt Builder — 安全拼装模板变量
 * 移植自 src/services/prompts/prompt-builder.ts
 */
import type { PromptTemplate } from './prompts.js'
import { PROMPTS } from './prompts.js'

export class PromptBuilder {
  protected template: PromptTemplate
  protected variables: Record<string, string> = {}

  constructor(template: PromptBuilder | PromptTemplate) {
    if (template instanceof PromptBuilder) {
      this.template = template.template
      this.variables = { ...template.variables }
    } else {
      this.template = template
    }
  }

  getSystemRole(): string {
    return this.template.systemRole || ''
  }

  build(): string {
    let result = this.template.content
    for (const [key, value] of Object.entries(this.variables)) {
      result = result.replaceAll(`{{${key}}}`, value || '')
    }

    // 自动追加 systemSuffix（始终从内置模板获取）
    const builtinTemplate = PROMPTS.find(p => p.key === this.template.key)
    const suffix = builtinTemplate?.systemSuffix
    if (suffix) {
      let renderedSuffix = suffix
      for (const [key, value] of Object.entries(this.variables)) {
        renderedSuffix = renderedSuffix.replaceAll(`{{${key}}}`, value)
      }
      result = result + '\n\n' + renderedSuffix
    }

    // 裁剪空变量段落
    result = result
      .replace(/\n★【[^】]*】★[：:]\s*\n?\s*$/gm, '')
      .replace(/\n【[^】]*（如有[^）]*）[^】]*】\s*\n?\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')

    // 检查未处理的占位符
    const missing = result.match(/\{\{.*?\}\}/g)
    if (missing) {
      console.warn(`[PromptBuilder] 警告：模板 "${this.template.name}" 中有未赋值的变量:`, missing)
    }

    return result
  }

  // ===== 通用 setter =====
  set(key: string, value: string) {
    this.variables[key] = value
    return this
  }
}

// ===== 章节生成 Builder =====
export class ChapterPromptBuilder extends PromptBuilder {
  withArchitecture(v: string) { return this.set('architecture', v) }
  withGlobalSummary(v: string) { return this.set('global_summary', v) }
  withCharacterStates(v: string) { return this.set('character_states', v) }
  withShortSummary(v: string) { return this.set('short_summary', v) }
  withPreviousEnding(v: string) { return this.set('previous_ending', v) }
  withChapterInfo(v: string | object) { return this.set('chapter_info', typeof v === 'string' ? v : JSON.stringify(v, null, 2)) }
  withFutureBlueprints(v: string) { return this.set('future_blueprints', v) }
  withUserGuidance(v: string) { return this.set('user_guidance', v) }
  withFilteredContext(v: string) { return this.set('filtered_context', v) }
  withGlobalGuidance(v: string) { return this.set('global_guidance', v) }
  withWordNumber(v: number | string) { return this.set('word_number', String(v)) }
  withDraftContent(v: string) { return this.set('draft_content', v) }
  withUserRefinePrompt(v: string) { return this.set('user_refine_prompt', v) }
  withReviewReport(v: string) { return this.set('review_report', v) }
  withWritingStyle(v: string) { return this.set('writing_style', v) }
}

// ===== 审稿 Builder =====
export class ReviewPromptBuilder extends PromptBuilder {
  withChapterContent(v: string) { return this.set('chapter_content', v) }
  withCharacterStates(v: string) { return this.set('character_states', v) }
  withGlobalSummary(v: string) { return this.set('global_summary', v) }
  withWorldBuilding(v: string) { return this.set('world_building', v) }
  withReviewFocus(v: string) { return this.set('review_focus', v) }
}

// ===== 后处理 Builder =====
export class PostProcessPromptBuilder extends PromptBuilder {
  withChapterContent(v: string) { return this.set('chapter_content', v) }
  withChapterNumber(v: number | string) { return this.set('chapter_number', String(v)) }
  withChapterTitle(v: string) { return this.set('chapter_title', v) }
  withExistingCardsJson(v: string | object) {
    return this.set('existing_cards_json', typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  }
}

// ===== 架构生成 Builder =====
export class ArchitecturePromptBuilder extends PromptBuilder {
  withGenre(v: string) { return this.set('genre', v) }
  withSubGenre(v: string) { return this.set('sub_genre', v) }
  withTopic(v: string) { return this.set('topic', v) }
  withTargetAudience(v: string) { return this.set('target_audience', v) }
  withNumberOfChapters(v: number | string) { return this.set('number_of_chapters', String(v)) }
  withWordNumber(v: number | string) { return this.set('word_number', String(v)) }
  withCoreSetting(v: string) { return this.set('core_setting', v) }
  withGoldenFinger(v: string) { return this.set('golden_finger', v) }
  withProtagonistProfile(v: string) { return this.set('protagonist_profile', v) }
  withGlobalGuidance(v: string) { return this.set('global_guidance', v) }
  withPremise(v: string) { return this.set('premise', v) }
  withCharacterDynamics(v: string) { return this.set('character_dynamics', v) }
  withWorldBuilding(v: string) { return this.set('world_building', v) }
  withPlotStructureGuide(v: string) { return this.set('plot_structure_guide', v) }
  withNarrativePov(v: string) { return this.set('narrative_pov', v) }
  withStepGuidance(v: string) { return this.set('step_guidance', v) }
  withReferenceWorks(v: string) { return this.set('reference_works', v) }
  withUserIdea(v: string) { return this.set('user_idea', v) }
}

// ===== 目录蓝图 Builder =====
export class DirectoryPromptBuilder extends PromptBuilder {
  withNovelArchitecture(v: string) { return this.set('novel_architecture', v) }
  withNumberOfChapters(v: number | string) { return this.set('number_of_chapters', String(v)) }
  withGlobalGuidance(v: string) { return this.set('global_guidance', v) }
  withGenre(v: string) { return this.set('genre', v) }
  withChapterList(v: string) { return this.set('chapter_list', v) }
  withN(v: number | string) { return this.set('n', String(v)) }
  withM(v: number | string) { return this.set('m', String(v)) }
  withPacingGuidance(v: string) { return this.set('pacing_guidance', v) }
}
