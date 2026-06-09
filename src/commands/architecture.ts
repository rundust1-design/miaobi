/**
 * Architecture Commands — 故事架构四步生成 + 配置生成
 * 移植自 src/services/workflows/commands/architecture.command.ts
 */
import { BaseCommand, type StepContext, type StepCallbacks } from './base-command.js'
import { getPromptTemplate, type PromptTemplate } from '../prompts.js'
import { ArchitecturePromptBuilder } from '../builder.js'
import {
  saveProjectCore, getProjectCore, getConfigValue, saveConfig,
  getAllCharacters, saveCharacter, type Character,
} from '../database.js'
import { callLLM } from '../llm.js'
import { parseJSON } from '../utils.js'

// ===== 配置生成 =====

export interface NovelConfigOutput {
  genre: string
  targetAudience: string
  subGenre: string
  plotStructure: string
  narrativePOV: string
  coreOutline: string
  worldSetting: string
  goldenFinger: string
  protagonistProfile: string
  globalGuidance: string
  writingStyle: string
}

export class GenerateConfigCommand extends BaseCommand<NovelConfigOutput> {
  constructor(
    private idea: string,
    private totalChapters: number,
    private wordsPerChapter: number,
  ) {
    super()
  }

  async execute(_context: StepContext, callbacks: StepCallbacks): Promise<NovelConfigOutput> {
    const template = getPromptTemplate('generate_global_config')
    if (!template) throw new Error('模板未找到')

    const builder = new ArchitecturePromptBuilder(template)
      .withUserIdea(this.idea)
      .withNumberOfChapters(this.totalChapters)
      .withWordNumber(this.wordsPerChapter)

    callbacks.log('正在分析灵感并生成商业小说配置...')
    const result = await this.callLLMWithBuilder(builder, callbacks, { responseFormat: { type: 'json_object' } })
    const config = this.parseJSON<NovelConfigOutput>(result)

    // 保存配置到数据库
    const configMap: Record<string, string> = {
      genre: config.genre,
      sub_genre: config.subGenre,
      target_audience: config.targetAudience,
      plot_structure: config.plotStructure,
      narrative_pov: config.narrativePOV,
      core_outline: config.coreOutline,
      world_setting: config.worldSetting,
      golden_finger: config.goldenFinger,
      protagonist_profile: config.protagonistProfile,
      global_guidance: config.globalGuidance,
      writing_style: config.writingStyle,
      words_per_chapter: String(this.wordsPerChapter),
      total_chapters: String(this.totalChapters),
    }
    for (const [key, value] of Object.entries(configMap)) {
      saveConfig(key, value)
    }
    callbacks.log(`✅ 配置已保存 (${Object.keys(configMap).length} 项)`)

    return config
  }
}

// ===== 故事前提 =====

export class GenerateCoreSeedCommand extends BaseCommand<string> {
  async execute(context: StepContext, callbacks: StepCallbacks): Promise<string> {
    const template = getPromptTemplate('premise')!
    const stepGuidance = (context.data?.stepGuidance as Record<string, string>)?.premise || ''

    const builder = new ArchitecturePromptBuilder(template)
      .withGenre(getConfigValue('genre') || '玄幻')
      .withSubGenre(getConfigValue('sub_genre') || '')
      .withTopic(getConfigValue('core_outline') || '')
      .withTargetAudience(getConfigValue('target_audience') || '男频')
      .withNumberOfChapters(parseInt(getConfigValue('total_chapters') || '100'))
      .withWordNumber(parseInt(getConfigValue('words_per_chapter') || '3000'))
      .withCoreSetting(getConfigValue('world_setting') || '')
      .withGoldenFinger(getConfigValue('golden_finger') || '')
      .withProtagonistProfile(getConfigValue('protagonist_profile') || '')
      .withGlobalGuidance(getConfigValue('global_guidance') || '')
      .withStepGuidance(stepGuidance)
      .withReferenceWorks('')

    callbacks.log('正在提炼故事前提...')
    const result = await this.callLLMWithBuilder(builder, callbacks)
    saveProjectCore('premise', result)
    callbacks.log('✅ 故事前提已保存')
    return result
  }
}

// ===== 角色图谱 =====

export class GenerateCharactersCommand extends BaseCommand<string> {
  async execute(context: StepContext, callbacks: StepCallbacks): Promise<string> {
    const template = getPromptTemplate('character_dynamics')!
    const stepGuidance = (context.data?.stepGuidance as Record<string, string>)?.characters || ''

    const builder = new ArchitecturePromptBuilder(template)
      .withGenre(getConfigValue('genre') || '玄幻')
      .withPremise(getProjectCore('premise') || '')
      .withProtagonistProfile(getConfigValue('protagonist_profile') || '')
      .withGoldenFinger(getConfigValue('golden_finger') || '')
      .withWorldBuilding(getProjectCore('worldbuilding') || '')
      .withNumberOfChapters(parseInt(getConfigValue('total_chapters') || '100'))
      .withGlobalGuidance(getConfigValue('global_guidance') || '')
      .withStepGuidance(stepGuidance)
      .withReferenceWorks('')

    callbacks.log('正在构建角色图谱...')
    const result = await this.callLLMWithBuilder(builder, callbacks)
    saveProjectCore('characters', result)
    callbacks.log('✅ 角色图谱已保存')

    // 自动提取初始角色卡
    await extractInitialCharacters(result, callbacks)

    return result
  }
}

// ===== 世界观 =====

export class GenerateWorldBuildingCommand extends BaseCommand<string> {
  async execute(context: StepContext, callbacks: StepCallbacks): Promise<string> {
    const template = getPromptTemplate('world_building')!
    const stepGuidance = (context.data?.stepGuidance as Record<string, string>)?.worldbuilding || ''

    const builder = new ArchitecturePromptBuilder(template)
      .withGenre(getConfigValue('genre') || '玄幻')
      .withPremise(getProjectCore('premise') || '')
      .withCoreSetting(getConfigValue('world_setting') || '')
      .withGoldenFinger(getConfigValue('golden_finger') || '')
      .withProtagonistProfile(getConfigValue('protagonist_profile') || '')
      .withGlobalGuidance(getConfigValue('global_guidance') || '')
      .withStepGuidance(stepGuidance)

    callbacks.log('正在构建世界观矩阵...')
    const result = await this.callLLMWithBuilder(builder, callbacks)
    saveProjectCore('worldbuilding', result)
    callbacks.log('✅ 世界观已保存')
    return result
  }
}

// ===== 情节大纲 =====

export class GeneratePlotArchitectureCommand extends BaseCommand<string> {
  constructor(private selectedSteps: string[]) {
    super()
  }

  async execute(context: StepContext, callbacks: StepCallbacks): Promise<string> {
    const template = getPromptTemplate('synopsis')!
    const stepGuidance = (context.data?.stepGuidance as Record<string, string>)?.synopsis || ''

    const plotStructure = getConfigValue('plot_structure') || 'three_act'
    const totalChapters = parseInt(getConfigValue('total_chapters') || '100')
    const structureGuide = getPlotStructureGuide(plotStructure, totalChapters)
    const narrativePov = getConfigValue('narrative_pov') || 'third_limited'

    const builder = new ArchitecturePromptBuilder(template)
      .withGenre(getConfigValue('genre') || '玄幻')
      .withPremise(getProjectCore('premise') || '')
      .withCharacterDynamics(getProjectCore('characters') || '')
      .withWorldBuilding(getProjectCore('worldbuilding') || '')
      .withNumberOfChapters(totalChapters)
      .withWordNumber(parseInt(getConfigValue('words_per_chapter') || '3000'))
      .withPlotStructureGuide(structureGuide)
      .withNarrativePov(narrativePov)
      .withGlobalGuidance(getConfigValue('global_guidance') || '')
      .withStepGuidance(stepGuidance)

    callbacks.log(`正在生成情节大纲（结构: ${plotStructure}）...`)
    const result = await this.callLLMWithBuilder(builder, callbacks)
    saveProjectCore('synopsis', result)
    callbacks.log('✅ 情节大纲已保存')
    return result
  }
}

// ===== 辅助工具 =====

export function getPlotStructureGuide(structure: string, totalChapters: number): string {
  const ch20 = Math.round(totalChapters * 0.2)
  const ch25 = Math.round(totalChapters * 0.25)
  const ch50 = Math.round(totalChapters * 0.5)
  const ch75 = Math.round(totalChapters * 0.75)

  switch (structure) {
    case 'heros_journey':
      return `【英雄之旅·十二阶段】全书共 ${totalChapters} 章...`
    case 'save_the_cat':
      return `【节拍表·十五拍】全书共 ${totalChapters} 章...`
    case 'kishotenketsu':
      return `【起承转合·四段式】\n起（第1~${ch25}章）→ 承（第${ch25 + 1}~${ch50}章）→ 转（第${ch50 + 1}~${ch75}章）→ 合（第${ch75 + 1}~${totalChapters}章）`
    case 'multi_thread':
      return `【多线叙事】全书共 ${totalChapters} 章。设定2-4条独立交织的故事线，交汇节点在约第${ch25}、${ch50}、${ch75}章。`
    case 'freeform':
      return `【自由结构】全书共 ${totalChapters} 章。根据故事内容自行设计节奏，保证每10-20章一个小高潮。`
    case 'three_act':
    default:
      return `【三幕结构】\n第一幕：建置（第1~${ch20}章）→ 第二幕：对抗（第${ch20 + 1}~${ch75}章）→ 第三幕：高潮与结局（第${ch75 + 1}~${totalChapters}章）`
  }
}

export class ExtractCharactersCommand extends BaseCommand<number> {
  async execute(_context: StepContext, callbacks: StepCallbacks): Promise<number> {
    const dynamicsContent = getProjectCore('characters')
    if (!dynamicsContent) {
      callbacks.log('❌ 未找到角色图谱数据，请先生成故事架构第2步')
      return 0
    }
    const count = await extractInitialCharacters(dynamicsContent, callbacks)
    return count
  }
}

// ===== 角色卡提取（后处理） =====

async function extractInitialCharacters(dynamicsContent: string, callbacks: StepCallbacks): Promise<number> {
  const template = getPromptTemplate('extract_initial_characters') || getPromptTemplate('character_dynamics')
  if (!template) return 0

  const genre = getConfigValue('genre') || ''

  callbacks.log('  📇 正在从角色图谱提取初始角色卡...')
  const prompt = new ArchitecturePromptBuilder(template)
    .withCharacterDynamics(dynamicsContent)
    .withGenre(genre)
    .build()

  const result = await callLLM(template.systemRole, prompt, { responseFormat: { type: 'json_object' } })

  try {
    const parsed = parseJSON<Array<Record<string, unknown>>>(result)
    const validRoles = ['protagonist', 'antagonist', 'supporting', 'minor']
    let count = 0

    for (const card of (Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>).characters as Array<Record<string, unknown>> || [])) {
      if (!card.name) continue
      const char: Character = {
        name: card.name as string,
        role: validRoles.includes(card.role as string) ? card.role as string : 'supporting',
        gender: card.gender as string || '',
        age: card.age as string || '',
        appearance: card.appearance as string || '',
        personality: card.personality as string || '',
        background: card.background as string || '',
        abilities: card.abilities as string || '',
        motivation: card.motivation as string || '',
        relationships: card.relationships as string || '',
        arc: card.arc as string || '',
        notes: card.notes as string || '',
        currentState: card.currentState
          ? {
              location: (card.currentState as Record<string, string>).location || '',
              powerLevel: (card.currentState as Record<string, string>).powerLevel || '',
              physicalState: (card.currentState as Record<string, string>).physicalState || '',
              mentalState: (card.currentState as Record<string, string>).mentalState || '',
              keyItems: (card.currentState as Record<string, string>).keyItems || '',
              recentEvents: (card.currentState as Record<string, string>).recentEvents || '',
              updatedAtChapter: (card.currentState as Record<string, unknown>).updatedAtChapter as number || 0,
            }
          : { location: '', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 0 },
      }
      saveCharacter(char)
      count++
    }
    callbacks.log(`  ✅ 初始角色卡提取完毕（${count} 个角色）`)
    return count
  } catch (e) {
    callbacks.log(`  ⚠️ 角色卡提取失败: ${e}`)
    return 0
  }
}
