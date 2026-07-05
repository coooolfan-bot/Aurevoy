/**
 * Embedding Provider 工厂。
 *
 * 只保留 OpenAI 兼容接口，支持 Ollama/LiteLLM/OpenAI 等后端。
 */

import { config } from '../config.js';
import { OpenAIEmbeddingProvider } from './openai.js';
import type { EmbeddingProvider, EmbeddingProviderType } from './types.js';

let cachedProvider: EmbeddingProvider | null | undefined = undefined;

export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;

  const provider: EmbeddingProviderType = config.embedding.provider;
  if (provider === 'off') {
    cachedProvider = null;
    console.warn('[embedding] 未配置，向量检索将降级为纯关键词');
    return null;
  }

  // 未单独设置 embedding baseUrl 时复用 LLM baseUrl（都是 OpenAI 兼容 API）
  const baseUrl = config.embedding.baseUrl || config.llm.baseUrl;
  const apiKey = config.embedding.apiKey || config.llm.apiKey;

  cachedProvider = new OpenAIEmbeddingProvider({
    baseUrl: baseUrl || 'http://127.0.0.1:11434/v1',
    model: config.embedding.model,
    apiKey,
    timeoutMs: config.embedding.timeoutMs,
  });

  console.warn(`[embedding] 已加载: ${baseUrl}/${config.embedding.model}`);
  return cachedProvider;
}

export function resetEmbeddingCache(): void {
  cachedProvider = undefined;
}
