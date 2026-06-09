/**
 * FinalizeChapterCommand — 定稿 + 后处理
 */
import { BaseCommand, type StepContext, type StepCallbacks } from './base-command.js'
import { getPromptTemplate } from '../prompts.js'
import { PostProcessPromptBuilder } from '../builder.js'
import { callLLM } from '../llm.js'
import { parseJSON, safeFilename } from '../utils.js'
import {
  getLatestDraft, updateDraftContent, updateDraftStatus,
  getProjectCore, getAllCharacters, saveCharacter, updateCharacterState,
  getConfigValue, getBlueprint, type Character, type CharacterState,
} from '../database.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { getConfig } from '../config.js'

export interface FinalizeParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  chapterTitle: string
}

export class FinalizeChapterCommand extends BaseCommand<void> {
  constructor(private params: FinalizeParams) {
    super()
  }

  async execute(_context: StepContext, callbacks: StepCallbacks): Promise<void> {
    callbacks.log('\n===== 开始定稿与后处理分析 =====')

    const cfg = getConfig()

    // 1. 标记定稿
    const draft = getLatestDraft(this.params.chapterNumber)
    if (!draft) throw new Error(`第 ${this.params.chapterNumber} 章无草稿`)

    updateDraftContent(draft.id, this.params.draftContent)
    updateDraftStatus(draft.id, 'finalized')

    // 2. 写入物理文件
    const safeTitle = this.params.chapterTitle
      ? ` ${safeFilename(this.params.chapterTitle)}`
      : ''
    const physicalPath = `${cfg.projectPath}/第${this.params.chapterNumber}章${safeTitle}.txt`
    const titleLine = this.params.chapterTitle
      ? `第${this.params.chapterNumber}章 ${this.params.chapterTitle}\n\n`
      : `第${this.params.chapterNumber}章\n\n`
    writeFileSync(physicalPath, titleLine + this.params.draftContent.replace(/^#+ .*\n*/, ''), 'utf-8')
    callbacks.log(`✅ 定稿已写入: ${physicalPath}`)

    // 3. 后处理步骤
    callbacks.log('🚀 正在执行后处理分析...')
    await this.runPostProcess(callbacks)

    callbacks.log(`\n🎉 第${this.params.chapterNumber}章创作全流程完成！`)
  }

  private async runPostProcess(callbacks: StepCallbacks): Promise<void> {
    const chNum = this.params.chapterNumber

    // 步骤 1: 章节要点提取（每 5 章触发）
    if (chNum % 5 === 1) {
      await this.generateChapterNotes(callbacks)
    }

    // 步骤 2: 角色状态更新（每 5 章触发）
    if (chNum % 5 === 2) {
      await this.updateCharacterCards(callbacks)
    }

    // 步骤 3: 文风自动学习（每 5 章触发）
    if (chNum % 5 === 0) {
      await this.analyzeStyle(callbacks)
    }
  }

  private async generateChapterNotes(callbacks: StepCallbacks): Promise<void> {
    const template = getPromptTemplate('generate_chapter_notes')
    if (!template) return

    const builder = new PostProcessPromptBuilder(template)
      .withChapterContent(this.params.draftContent)
      .withChapterNumber(this.params.chapterNumber)
      .withChapterTitle(this.params.chapterTitle)

    callbacks.log('  📋 正在提取章节要点...')
    const result = await callLLM(builder.getSystemRole(), builder.build())
    callbacks.log('  ✅ 章节要点提取完成')
  }

  private async updateCharacterCards(callbacks: StepCallbacks): Promise<void> {
    const template = getPromptTemplate('update_character_cards')
    if (!template) return

    const allChars = getAllCharacters()
    const simpleCards = allChars.map(c => ({ name: c.name, role: c.role }))

    const builder = new PostProcessPromptBuilder(template)
      .withChapterContent(this.params.draftContent.slice(0, 5000))
      .withChapterNumber(this.params.chapterNumber)
      .withExistingCardsJson(simpleCards)

    callbacks.log('  🎭 正在更新角色状态...')
    const result = await callLLM(builder.getSystemRole(), builder.build(),
      { responseFormat: { type: 'json_object' } })

    type LLMUpdateState = {
      location?: string; powerLevel?: string; physicalState?: string
      mentalState?: string; keyItems?: string; recentEvents?: string
    }

    try {
      const cardUpdates = parseJSON<{
        updates?: Array<{ name: string; currentState: LLMUpdateState }>
        newCharacters?: Array<{ name: string; role: string; currentState: LLMUpdateState }>
      }>(result)

      if (cardUpdates.updates) {
        for (const upd of cardUpdates.updates) {
          const dbChar = allChars.find(c => c.name === upd.name)
          if (dbChar && upd.currentState) {
            const cs = upd.currentState
            const newState: CharacterState = {
              location: cs.location || dbChar.currentState.location,
              powerLevel: cs.powerLevel || dbChar.currentState.powerLevel,
              physicalState: cs.physicalState || dbChar.currentState.physicalState,
              mentalState: cs.mentalState || dbChar.currentState.mentalState,
              keyItems: cs.keyItems || dbChar.currentState.keyItems,
              recentEvents: cs.recentEvents || '',
              updatedAtChapter: this.params.chapterNumber,
            }
            updateCharacterState(dbChar.name, newState)
            callbacks.log(`  ✅ 更新角色: ${dbChar.name}`)
          }
        }
      }

      if (cardUpdates.newCharacters) {
        for (const newChar of cardUpdates.newCharacters) {
          if (allChars.some(c => c.name === newChar.name)) continue
          const cs = newChar.currentState || {}
          const char: Character = {
            name: newChar.name,
            role: newChar.role || 'supporting',
            gender: '', age: '', appearance: '', personality: '',
            background: '', abilities: '', motivation: '', relationships: '',
            arc: '', notes: '',
            currentState: {
              location: cs.location || '',
              powerLevel: cs.powerLevel || '',
              physicalState: cs.physicalState || '',
              mentalState: cs.mentalState || '',
              keyItems: cs.keyItems || '',
              recentEvents: cs.recentEvents || '',
              updatedAtChapter: this.params.chapterNumber,
            },
          }
          saveCharacter(char)
          callbacks.log(`  ✅ 新增角色: ${char.name}`)
        }
      }
    } catch (e) {
      callbacks.log(`  ⚠️ 角色状态更新解析失败: ${e}`)
    }
  }

  private async analyzeStyle(callbacks: StepCallbacks): Promise<void> {
    const template = getPromptTemplate('analyze_writing_style')
    if (!template) return

    // 采集最近 5 章已定稿内容作为样本
    const samples: string[] = []
    for (let i = Math.max(1, this.params.chapterNumber - 4); i <= this.params.chapterNumber; i++) {
      const draft = getLatestDraft(i)
      if (draft?.content) {
        samples.push(draft.content.slice(0, 800))
      }
    }
    if (samples.length < 2) return

    const builder = new PostProcessPromptBuilder(template)
      .withChapterContent(samples.join('\n\n---\n\n'))

    callbacks.log('  🎨 正在分析文风...')
    const result = await callLLM(builder.getSystemRole(), builder.build())
    callbacks.log('  ✅ 文风分析完成')
  }
}
