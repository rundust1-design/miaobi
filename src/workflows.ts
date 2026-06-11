/**
 * Workflow Engine — 工作流编排
 * 移植自 src/services/workflows/ 下的多个 workflow 文件
 */
import {
  BaseCommand, type StepContext, type StepCallbacks,
} from './commands/base-command.js'
import { GenerateConfigCommand } from './commands/architecture.js'
import {
  GenerateCoreSeedCommand, GenerateCharactersCommand,
  GenerateWorldBuildingCommand, GeneratePlotArchitectureCommand,
} from './commands/architecture.js'
import { GenerateDirectoryCommand } from './commands/directory.js'
import { GenerateDraftCommand } from './commands/generate-draft.js'
import { RefineDraftCommand } from './commands/refine-draft.js'
import { ReviewChapterCommand } from './commands/review-chapter.js'
import { RefineFromReviewCommand } from './commands/refine-from-review.js'
import { FinalizeChapterCommand } from './commands/finalize-chapter.js'
import {
  getLatestDraft, getPendingRevisions, markRevisionMerged,
  updateDraftContent, getBlueprint, getAllBlueprints,
} from './database.js'

// ===== 类型定义 =====

export interface WorkflowStep {
  name: string
  command: BaseCommand<unknown>
  onError?: 'stop' | 'continue'
}

export interface WorkflowDefinition {
  type: string
  steps: WorkflowStep[]
}

export interface WorkflowCallbacks extends StepCallbacks {
  onStepStart?: (stepName: string, index: number, total: number) => void
  onStepComplete?: (stepName: string, result: unknown) => void
}

// ===== 工作流执行器 =====

export async function executeWorkflow(
  definition: WorkflowDefinition,
  context: StepContext,
  callbacks: WorkflowCallbacks,
): Promise<void> {
  const steps = definition.steps
  context.data ??= {}
  context.data.autoMode = true

  const signal = context.data?.abortSignal as AbortSignal | undefined

  for (let i = 0; i < steps.length; i++) {
    // 检查是否已被中止
    if (signal?.aborted) {
      callbacks.log('🛑 操作已取消')
      throw new Error('操作已由用户取消')
    }

    const step = steps[i]
    callbacks.onStepStart?.(step.name, i, steps.length)
    callbacks.log(`\n--- 步骤 ${i + 1}/${steps.length}: ${step.name} ---`)

    try {
      const result = await step.command.execute(context, callbacks)
      callbacks.onStepComplete?.(step.name, result)
    } catch (err) {
      callbacks.log(`❌ 步骤 "${step.name}" 失败: ${err}`)
      if (step.onError === 'continue') {
        callbacks.log('  ⏭️ 继续执行下一步...')
        continue
      }
      throw err
    }
  }

  callbacks.log('\n🎉 工作流执行完成！')
}

// ===== 辅助函数 =====

function autoMergeRevision(draftId: number, chapterNumber: number): string | null {
  const revisions = getPendingRevisions(draftId)
  if (revisions.length === 0) return null

  // 取最新的 pending revision 内容
  const latest = revisions[revisions.length - 1]
  updateDraftContent(draftId, latest.content)
  markRevisionMerged(latest.id)
  return latest.content
}

// ===== 工作流定义 =====

/**
 * 生成配置 → 一键完成
 */
export function createConfigWorkflow(idea: string, totalChapters: number, wordsPerChapter: number): WorkflowDefinition {
  return {
    type: 'config',
    steps: [
      {
        name: '生成配置',
        command: new GenerateConfigCommand(idea, totalChapters, wordsPerChapter),
      },
    ],
  }
}

/**
 * 架构四步生成（可选步骤）
 */
export function createArchitectureWorkflow(selectedSteps: string[]): WorkflowDefinition {
  const allSteps: Record<string, WorkflowStep> = {
    premise: {
      name: '故事前提',
      command: new GenerateCoreSeedCommand(),
    },
    characters: {
      name: '角色图谱',
      command: new GenerateCharactersCommand(),
    },
    worldbuilding: {
      name: '世界观矩阵',
      command: new GenerateWorldBuildingCommand(),
    },
    synopsis: {
      name: '情节大纲',
      command: new GeneratePlotArchitectureCommand(selectedSteps),
    },
  }

  const steps = selectedSteps
    .filter(s => allSteps[s])
    .map(s => allSteps[s])

  return { type: 'architecture', steps }
}

/**
 * 生成目录蓝图
 */
export function createDirectoryWorkflow(mode: 'full' | 'append', startChapter?: number, count?: number): WorkflowDefinition {
  return {
    type: 'directory',
    steps: [
      {
        name: '生成蓝图',
        command: new GenerateDirectoryCommand(mode, startChapter, count),
      },
    ],
  }
}

/**
 * 写草稿
 */
export function createWriteWorkflow(chapterInfo: { chapterNumber: number; title: string; role: string; purpose: string; characters: string[]; keyEvents: string; suspenseHook?: string; userGuidance?: string }): WorkflowDefinition {
  return {
    type: 'write',
    steps: [
      {
        name: 'AI 写稿',
        command: new GenerateDraftCommand(chapterInfo),
      },
    ],
  }
}

/**
 * AI 修稿
 */
export function createRefineWorkflow(chapterNumber: number): WorkflowDefinition {
  return {
    type: 'refine',
    steps: [
      {
        name: 'AI 修稿',
        command: new RefineDraftCommand(chapterNumber),
      },
    ],
  }
}

/**
 * 一致性审稿
 */
export function createReviewWorkflow(chapterNumber: number, reviewFocus?: string): WorkflowDefinition {
  return {
    type: 'review',
    steps: [
      {
        name: '一致性审稿',
        command: new ReviewChapterCommand(chapterNumber, reviewFocus),
      },
    ],
  }
}

/**
 * 审稿修复
 */
export function createRefineFromReviewWorkflow(chapterNumber: number): WorkflowDefinition {
  return {
    type: 'refine-from-review',
    steps: [
      {
        name: '审稿修复',
        command: new RefineFromReviewCommand(chapterNumber),
      },
    ],
  }
}

/**
 * 定稿
 */
export function createFinalizeWorkflow(chapterNumber: number, chapterTitle: string): WorkflowDefinition {
  return {
    type: 'finalize',
    steps: [
      {
        name: '定稿',
        command: new FinalizeChapterCommand({ draftPath: '', draftContent: '', chapterNumber, chapterTitle }),
      },
    ],
  }
}

/**
 * 一键完成：写稿 → 修稿 → 审稿 → 修复 → 定稿
 */
export function createOneClickCompleteWorkflow(
  chapterInfo: { chapterNumber: number; title: string; role: string; purpose: string; characters: string[]; keyEvents: string; suspenseHook?: string; userGuidance?: string },
  reviewFocus?: string,
): WorkflowDefinition {
  return {
    type: 'one-click-complete',
    steps: [
      // Step 1: 写草稿
      {
        name: 'AI 写稿',
        command: new GenerateDraftCommand(chapterInfo),
      },
      // Step 2: AI 修稿
      {
        name: 'AI 修稿',
        command: new RefineDraftCommand(chapterInfo.chapterNumber),
      },
      // Step 3: 一致性审稿
      {
        name: '一致性审稿',
        command: new ReviewChapterCommand(chapterInfo.chapterNumber, reviewFocus),
      },
      // Step 4: 审稿修复
      {
        name: '审稿修复',
        command: new RefineFromReviewCommand(chapterInfo.chapterNumber),
      },
      // Step 5: 定稿
      {
        name: '定稿',
        command: new FinalizeChapterCommand({
          draftPath: '',
          draftContent: '',
          chapterNumber: chapterInfo.chapterNumber,
          chapterTitle: chapterInfo.title,
        }),
      },
    ],
  }
}

/**
 * 修复定稿：审稿 → 修复 → 定稿（跳过已成功的步骤）
 */
export function createRepairFinalizeWorkflow(
  chapterNumber: number,
  chapterTitle: string,
  onlyFailed: boolean,
): WorkflowDefinition {
  const steps: WorkflowStep[] = []

  if (!onlyFailed) {
    steps.push({
      name: '一致性审稿',
      command: new ReviewChapterCommand(chapterNumber),
      onError: 'continue',
    })
  }

  steps.push({
    name: '审稿修复',
    command: new RefineFromReviewCommand(chapterNumber),
    onError: 'continue',
  })

  steps.push({
    name: '定稿',
    command: new FinalizeChapterCommand({
      draftPath: '',
      draftContent: '',
      chapterNumber,
      chapterTitle,
    }),
  })

  return { type: 'repair-finalize', steps }
}
