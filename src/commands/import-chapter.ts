/**
 * ImportChapterCommand — 导入已有小说文本
 * 移植自 src/services/workflows/commands/import.command.ts
 */
import { BaseCommand, type StepContext, type StepCallbacks } from './base-command.js'
import { getConfigValue, getAllBlueprints, type Blueprint } from '../database.js'
import { getPromptTemplate } from '../prompts.js'
import { ReviewPromptBuilder } from '../builder.js'
import * as fs from 'node:fs'

export interface ImportInput {
  chapterNumber: number
  chapterTitle: string
  rawText: string
}

export class ImportChapterCommand extends BaseCommand<{ blueprint: Blueprint; content: string }> {
  constructor(private input: ImportInput) {
    super()
  }

  async execute(_context: StepContext, callbacks: StepCallbacks): Promise<{ blueprint: Blueprint; content: string }> {
    callbacks.log(`导入第 ${this.input.chapterNumber} 章: ${this.input.chapterTitle}`)

    const content = this.input.rawText.trim()
    if (!content) throw new Error('导入文本为空')

    // 反向推理蓝图
    const blueprint = await this.inferBlueprint(this.input.chapterNumber, this.input.chapterTitle, content, callbacks)

    callbacks.log(`✅ 导入完成（${content.length} 字）`)
    return { blueprint, content }
  }

  private async inferBlueprint(chapterNumber: number, title: string, content: string, callbacks: StepCallbacks): Promise<Blueprint> {
    // 尝试从已有蓝图匹配
    const existing = getAllBlueprints().find(b => b.chapterNumber === chapterNumber)
    if (existing) {
      callbacks.log('  📋 已有蓝图匹配')
      return existing
    }

    // 反向推理
    const template = getPromptTemplate('infer_blueprint')
    if (!template) {
      callbacks.log('  ⚠️ 无反向推理模板，使用精简蓝图')
      return minimalBlueprint(chapterNumber, title, content)
    }

    try {
      const genre = getConfigValue('genre') || '玄幻'
      const builder = new ReviewPromptBuilder(template)
        .withChapterContent(content.slice(0, 5000))
      const prompt = builder.build()

      callbacks.log('  🔍 正在反向推理蓝图...')
      const result = await this.callLLM(template.systemRole, prompt, callbacks, { responseFormat: { type: 'json_object' } })
      const parsed = this.parseJSON<Record<string, unknown>>(result)

      return {
        chapterNumber,
        title: (parsed.title as string) || title,
        role: (parsed.role as string) || '发展',
        purpose: (parsed.purpose as string) || '',
        keyEvents: (parsed.keyEvents as string) || (parsed.key_events as string) || '',
        characters: Array.isArray(parsed.characters) ? parsed.characters as string[] : [],
        suspenseHook: (parsed.suspenseHook as string) || (parsed.suspense_hook as string) || '',
        userGuidance: '',
        notes: '',
        notesUpdatedAt: '',
      }
    } catch {
      return minimalBlueprint(chapterNumber, title, content)
    }
  }
}

function minimalBlueprint(chapterNumber: number, title: string, content: string): Blueprint {
  const firstLine = content.split('\n')[0].slice(0, 100)
  return {
    chapterNumber,
    title,
    role: '发展',
    purpose: firstLine,
    keyEvents: '',
    characters: [],
    suspenseHook: '',
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
  }
}

/**
 * 批量导入文件
 */
export function scanChapterFiles(projectPath: string): ImportInput[] {
  const files = fs.readdirSync(projectPath)
  const inputs: ImportInput[] = []

  for (const file of files) {
    const match = file.match(/^第(\d+)章\s*(.*?)\.(txt|md)$/)
    if (!match) continue

    const chapterNumber = parseInt(match[1])
    const chapterTitle = match[2] || ''
    const rawText = fs.readFileSync(`${projectPath}/${file}`, 'utf-8')

    // 去除首行标题（如果以"第N章"开头）
    const cleaned = rawText.replace(/^第\d+章.*?\n\n?/, '').trim()

    inputs.push({ chapterNumber, chapterTitle, rawText: cleaned })
  }

  return inputs.sort((a, b) => a.chapterNumber - b.chapterNumber)
}
