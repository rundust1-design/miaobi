/**
 * GenerateDirectoryCommand — 生成章节蓝图
 */
import { BaseCommand, type StepContext, type StepCallbacks } from './base-command.js'
import { getPromptTemplate } from '../prompts.js'
import { DirectoryPromptBuilder } from '../builder.js'
import {
  getConfigValue, getProjectCore, getAllBlueprints, saveAllBlueprints,
  type Blueprint,
} from '../database.js'
import { parseJSON, stripThinkingTags } from '../utils.js'

export class GenerateDirectoryCommand extends BaseCommand<Blueprint[]> {
  constructor(private mode: 'full' | 'append', private startChapter?: number, private count?: number, private pacingGuidance?: string) {
    super()
  }

  async execute(context: StepContext, callbacks: StepCallbacks): Promise<Blueprint[]> {
    const architecture = context.data?.architecture as string
      || [getProjectCore('premise'), getProjectCore('characters'), getProjectCore('worldbuilding'), getProjectCore('synopsis')].filter(Boolean).join('\n\n---\n\n')

    if (!architecture || architecture.length < 100) {
      throw new Error('项目架构不完整，请先运行 "miaobi architect"')
    }

    // 必须有完整情节大纲（覆盖全书章节）才能生成蓝图
    const totalChapters = parseInt(getConfigValue('total_chapters') || '100')
    const synopsis = getProjectCore('synopsis')

    if (!synopsis || synopsis.trim().length < 100) {
      throw new Error(
        '请先生成完整的情节大纲（synopsis），再生成蓝图。\n' +
        '当前情节大纲缺失或内容过短，AI 无法规划合理的章节结构。'
      )
    }

    // 从大纲中提取所有章号，检测是否覆盖全书
    const chapterNumbers = extractChapterNumbers(synopsis)
    const maxChapterInSynopsis = chapterNumbers.length > 0 ? Math.max(...chapterNumbers) : 0

    if (maxChapterInSynopsis < totalChapters * 0.8) {
      throw new Error(
        `情节大纲未覆盖全书！\n` +
        `- 设定总章数：${totalChapters} 章\n` +
        `- 大纲中提及的最大章号：${maxChapterInSynopsis || '未检测到'}\n` +
        `- 检测到的章号数量：${chapterNumbers.length} 个\n\n` +
        `请重新生成情节大纲，确保大纲涵盖了全 ${totalChapters} 章的故事结构。`
      )
    }

    if (chapterNumbers.length < 3) {
      throw new Error(
        `情节大纲过于简略，仅检测到 ${chapterNumbers.length} 个章节引用。\n` +
        `请重新生成情节大纲，确保包含至少 3 个以上的结构节点（如：开局、发展、高潮、结局等）。`
      )
    }

    const genre = getConfigValue('genre') || '玄幻'
    const globalGuidance = getConfigValue('global_guidance') || ''

    if (this.mode === 'full') {
      return this.generateFull(architecture, genre, totalChapters, globalGuidance, callbacks)
    } else {
      return this.generateAppend(architecture, genre, totalChapters, globalGuidance, callbacks)
    }
  }

  private async generateFull(
    architecture: string, genre: string, totalChapters: number,
    globalGuidance: string, callbacks: StepCallbacks,
  ): Promise<Blueprint[]> {
    const template = getPromptTemplate('chapter_blueprint_chunk') || getPromptTemplate('chapter_blueprint')
    if (!template) throw new Error('模板未找到: chapter_blueprint')

    const CHUNK_SIZE = 10
    let allResults: Blueprint[] = []
    let chunkStart = 1
    let round = 1
    while (chunkStart <= totalChapters) {
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, totalChapters)
      callbacks.log(`🔄 第 ${round} 批：正在生成第 ${chunkStart}-${chunkEnd} 章蓝图...`)

      const currentExisting = getAllBlueprints()
      const chapterList = currentExisting.slice(Math.max(0, currentExisting.length - 50)).map(b =>
        `第${b.chapterNumber}章 ${b.title}：${b.keyEvents}`
      ).join('\n')

      const builder = new DirectoryPromptBuilder(template)
        .withNovelArchitecture(architecture)
        .withNumberOfChapters(totalChapters)
        .withGlobalGuidance(globalGuidance)
        .withGenre(genre)
        .withChapterList(chapterList)
        .withN(chunkStart)
        .withM(chunkEnd)
        .withPacingGuidance(this.pacingGuidance || '')

      const result = await this.callLLMWithBuilder(builder, callbacks)
      const parsed = parseTextBlueprints(result, chunkStart, chunkEnd)

      if (parsed.length === 0) {
        callbacks.log(`  ⚠️ 第 ${round} 批 JSON 解析失败，尝试正则提取...`)
        const regexResult = extractBlueprintsByRegex(result, chunkStart, chunkEnd)
        if (regexResult.length > 0) {
          saveAllBlueprints(regexResult)
          allResults.push(...regexResult)
          callbacks.log(`  ✅ 正则提取 ${regexResult.length} 章 (${chunkStart}-${chunkEnd})`)
        } else {
          callbacks.log(`  ❌ 第 ${round} 批完全失败，跳过`)
        }
      } else {
        saveAllBlueprints(parsed)
        allResults.push(...parsed)
        callbacks.log(`  ✅ 第 ${round} 批：${parsed.length} 章 (${chunkStart}-${chunkEnd})`)
      }

      round++
      chunkStart = chunkEnd + 1
    }

    callbacks.log(`🎉 全部批次完成，共 ${allResults.length} 章`)
    return allResults
  }

  private async generateAppend(
    architecture: string, genre: string, totalChapters: number,
    globalGuidance: string, callbacks: StepCallbacks,
  ): Promise<Blueprint[]> {
    const existing = getAllBlueprints()
    const startChapter = this.startChapter || existing.length + 1
    const endChapter = this.count ? startChapter + this.count - 1 : totalChapters
    const CHUNK_SIZE = 10 // 每批最多10章，防止一次生成太多导致超时/内存溢出

    const template = getPromptTemplate('chapter_blueprint_chunk')
    if (!template) throw new Error('模板未找到: chapter_blueprint_chunk')

    const recentBlueprints = existing.slice(-50)

    // 自动分批：每批最多 CHUNK_SIZE 章
    let allResults: Blueprint[] = []
    let chunkStart = startChapter
    let round = 1
    while (chunkStart <= endChapter) {
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, endChapter)
      callbacks.log(`🔄 第 ${round} 批：正在生成第 ${chunkStart}-${chunkEnd} 章蓝图...`)

      // 每批用最新的已有蓝图列表作为上下文
      const currentExisting = getAllBlueprints()
      const chapterList = currentExisting.slice(-50).map(b =>
        `第${b.chapterNumber}章 ${b.title}：${b.keyEvents}`
      ).join('\n')

      const builder = new DirectoryPromptBuilder(template)
        .withNovelArchitecture(architecture)
        .withNumberOfChapters(totalChapters)
        .withGlobalGuidance(globalGuidance)
        .withGenre(genre)
        .withChapterList(chapterList)
        .withN(chunkStart)
        .withM(chunkEnd)
        .withPacingGuidance(this.pacingGuidance || '')

      const result = await this.callLLMWithBuilder(builder, callbacks)
      const parsed = parseTextBlueprints(result, chunkStart, chunkEnd)

      if (parsed.length === 0) {
        callbacks.log(`  ⚠️ 第 ${round} 批 JSON 解析失败，尝试正则提取...`)
        const regexResult = extractBlueprintsByRegex(result, chunkStart, chunkEnd)
        if (regexResult.length > 0) {
          saveAllBlueprints(regexResult)
          allResults.push(...regexResult)
          callbacks.log(`  ✅ 正则提取 ${regexResult.length} 章 (${chunkStart}-${chunkEnd})`)
        } else {
          callbacks.log(`  ❌ 第 ${round} 批完全失败，跳过`)
        }
      } else {
        saveAllBlueprints(parsed)
        allResults.push(...parsed)
        callbacks.log(`  ✅ 第 ${round} 批：${parsed.length} 章 (${chunkStart}-${chunkEnd})`)
      }

      round++
      chunkStart = chunkEnd + 1
    }

    callbacks.log(`🎉 全部批次完成，共 ${allResults.length} 章`)
    return allResults
  }

  private parseAndSave(rawText: string, startNum: number, endNum: number, callbacks: StepCallbacks): Blueprint[] {
    const blueprints = parseTextBlueprints(rawText, startNum, endNum)

    if (blueprints.length === 0) {
      callbacks.log('⚠️ JSON 解析失败，尝试正则逐条提取...')
      const regexResult = extractBlueprintsByRegex(rawText, startNum, endNum)
      if (regexResult.length > 0) {
        saveAllBlueprints(regexResult)
        callbacks.log(`✅ 正则提取+保存 ${regexResult.length} 章蓝图`)
        return regexResult
      }
      throw new Error('蓝图解析完全失败')
    }

    saveAllBlueprints(blueprints)
    callbacks.log(`✅ 保存 ${blueprints.length} 章蓝图`)
    return blueprints
  }
}

// ===== 蓝图解析工具 =====

function parseTextBlueprints(content: string, startNum: number, endNum: number): Blueprint[] {
  const EMPTY: Blueprint = {
    chapterNumber: 0, title: '', role: '发展', purpose: '',
    keyEvents: '', characters: [], suspenseHook: '',
    userGuidance: '', notes: '', notesUpdatedAt: '',
  }

  // 复用 utils.ts 的健壮解析，同时处理 {...} 和 [...]
  const cleanContent = stripThinkingTags(content)
  let items: Array<Record<string, unknown>> = []

  try {
    const parsed = parseJSON<unknown>(cleanContent)

    if (Array.isArray(parsed)) {
      items = parsed as Array<Record<string, unknown>>
    } else if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).blueprints) {
      items = (parsed as Record<string, unknown>).blueprints as Array<Record<string, unknown>>
    } else {
      return []
    }
  } catch {
    return []
  }

  if (items.length === 0) return []

  return items
    .filter(p => {
      const n = Number(p.chapterNumber)
      return n >= startNum && n <= endNum
    })
    .map(p => ({
      ...EMPTY,
      chapterNumber: Number(p.chapterNumber || 0),
      title: String(p.title || `第${p.chapterNumber}章`),
      role: String(p.role || '发展'),
      purpose: String(p.purpose || ''),
      keyEvents: String(p.keyEvents || ''),
      characters: Array.isArray(p.characters) ? p.characters as string[] : [],
      suspenseHook: String(p.suspenseHook || ''),
    }))
}

function extractBlueprintsByRegex(rawText: string, startNum: number, endNum: number): Blueprint[] {
  const results: Blueprint[] = []
  const chapterBlocks: string[] = []

  // 先用 stripThinkingTags 清理 thinking 内容，避免思考中的 JSON 干扰正则
  const text = stripThinkingTags(rawText)

  // 定位 blueprints 数组
  const bpArrayStartMatch = text.match(/"blueprints"\s*:\s*\[/i)
  if (bpArrayStartMatch) {
    const startPos = bpArrayStartMatch.index! + bpArrayStartMatch[0].length
    const arrayContent = text.slice(startPos)

    let braceDepth = 0, currentBlock = '', inString = false, escape = false
    for (let i = 0; i < arrayContent.length; i++) {
      const ch = arrayContent[i]
      if (escape) { escape = false; currentBlock += ch; continue }
      if (ch === '\\') { escape = true; currentBlock += ch; continue }
      if (ch === '"' && !escape) { inString = !inString; currentBlock += ch; continue }
      if (inString) { currentBlock += ch; continue }

      if (ch === '{') {
        if (braceDepth === 0) currentBlock = ch
        else currentBlock += ch
        braceDepth++
      } else if (ch === '}') {
        braceDepth--
        currentBlock += ch
        if (braceDepth === 0 && currentBlock) { chapterBlocks.push(currentBlock); currentBlock = '' }
      } else if (braceDepth >= 1) {
        currentBlock += ch
      }
    }
    if (braceDepth > 0 && currentBlock) chapterBlocks.push(currentBlock)
  }

  for (const block of chapterBlocks) {
    const extract = (key: string): string => {
      const patterns = [
        new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'),
        new RegExp(`"${key}"\\s*:\\s*(\\d+)`, 'i'),
        new RegExp(`"${key}"\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'),
        new RegExp(`"${key}"\\s*:\\s*([^,}\\]]+)`, 'i'),
      ]
      for (const p of patterns) {
        const m = block.match(p)
        if (m) return m[1].trim()
      }
      return ''
    }

    const extractArray = (key: string): string[] => {
      const m = block.match(new RegExp(`"${key}"\\s*:?\\s*\\[([^\\]]*)\\]`, 'i'))
      if (!m) return []
      return m[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
    }

    const chapterNumber = parseInt(extract('chapterNumber') || extract('chapter_number')) || 0
    if (chapterNumber < startNum || chapterNumber > endNum) continue
    if (results.some(r => r.chapterNumber === chapterNumber)) continue

    results.push({
      chapterNumber,
      title: extract('title') || `第${chapterNumber}章`,
      role: extract('role') || '发展',
      purpose: extract('purpose') || '',
      keyEvents: extract('keyEvents') || extract('key_events') || '',
      characters: extractArray('characters'),
      suspenseHook: extract('suspenseHook') || extract('suspense_hook') || '',
      userGuidance: '',
      notes: '',
      notesUpdatedAt: '',
    })
  }

  return results.sort((a, b) => a.chapterNumber - b.chapterNumber)
}

/**
 * 从情节大纲文本中提取所有章号引用。
 * 支持格式：「第1-10章」「第5章」「第20章~第30章」「1-5章」「第100章」
 */
function extractChapterNumbers(text: string): number[] {
  const numbers = new Set<number>()

  // 匹配「第X-Y章」「第X～Y章」「第X—Y章」等范围表达
  const rangeRegex = /第\s*(\d+)\s*[-–—～~到至]\s*(?:第\s*)?(\d+)\s*章/g
  let match: RegExpExecArray | null
  while ((match = rangeRegex.exec(text)) !== null) {
    const from = parseInt(match[1])
    const to = parseInt(match[2])
    // 合理范围：不超过 10000 章
    if (from > 0 && to > from && to <= 10000) {
      for (let i = from; i <= to; i++) numbers.add(i)
    }
  }

  // 匹配「第X章」（单独出现，不在已匹配范围内）
  const singleRegex = /第\s*(\d+)\s*章/g
  while ((match = singleRegex.exec(text)) !== null) {
    const n = parseInt(match[1])
    if (n > 0 && n <= 10000) numbers.add(n)
  }

  // 匹配「X-Y章」（前面没有"第"的格式，如「1-10章 开端」）
  const bareRangeRegex = /(?:^|[\s,，、])(\d{1,4})\s*[-–—～~][-–—～~]?\s*(\d{1,4})\s*章/g
  while ((match = bareRangeRegex.exec(text)) !== null) {
    const from = parseInt(match[1])
    const to = parseInt(match[2])
    if (from > 0 && to > from && to <= 10000) {
      for (let i = from; i <= to; i++) numbers.add(i)
    }
  }

  return [...numbers].sort((a, b) => a - b)
}
