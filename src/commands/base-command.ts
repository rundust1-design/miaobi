/**
 * Base Command — 所有工作流命令的基类
 * 移植自 src/services/workflows/commands/base-command.ts
 */
import { callLLM } from '../llm.js'
import { parseJSON, stripThinkingTags } from '../utils.js'
import type { PromptBuilder } from '../builder.js'

export interface StepContext {
  data?: Record<string, unknown>
  cancelled?: boolean
  autoMode?: boolean
}

export interface StepCallbacks {
  log: (msg: string) => void
  onChunk?: (chunk: string) => void
}

export abstract class BaseCommand<TResult = string> {
  abstract execute(context: StepContext, callbacks: StepCallbacks): Promise<TResult>

  /** 调用 LLM（流式输出到控制台） */
  protected async callLLM(
    systemPrompt: string,
    userPrompt: string,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: 'json_object' | 'text' } },
  ): Promise<string> {
    callbacks.log('  调用 AI 模型...')
    const result = await callLLM(systemPrompt, userPrompt, {
      responseFormat: options?.responseFormat,
      onChunk: callbacks.onChunk,
    })
    return result
  }

  /** 使用 Builder 一键调用 LLM */
  protected async callLLMWithBuilder(
    builder: PromptBuilder,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: 'json_object' | 'text' } },
  ): Promise<string> {
    return this.callLLM(builder.getSystemRole(), builder.build(), callbacks, options)
  }

  /** 容错 JSON 解析 */
  protected parseJSON<T>(text: string): T {
    return parseJSON<T>(text)
  }

  /** 清洗思维链标签 */
  protected stripThinkingTags(text: string): string {
    return stripThinkingTags(text)
  }
}
