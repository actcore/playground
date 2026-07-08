/**
 * A Llama running on WebGPU, via @mlc-ai/web-llm.
 *
 * The portable engine: it needs nothing from the browser but WebGPU, so it
 * covers the visitors Chrome's built-in model can't reach — Firefox, Safari,
 * Android, and desktops without the disk space for Gemini Nano. The price is
 * a ~2 GB one-time download from the HuggingFace mlc-chat CDN, cached in
 * CacheStorage afterwards.
 *
 * Llama-3.2-3B-Instruct is small enough for a casual visitor to wait through
 * and big enough to follow a structured "emit <tool_call>" prompt reliably.
 * We use prompt-based tool dispatch (see chat.ts), NOT WebLLM's native
 * ChatCompletionRequest.tools — the latter is hardcoded to a short list of
 * Hermes-fine-tuned 8B models and its parser is too strict to rely on.
 *
 * f32 quantisation chosen over q4f16 to avoid WGSL shader-compile failures on
 * some GPUs/drivers ("[Invalid ShaderModule]").
 */

import { CreateMLCEngine, type MLCEngineInterface, type InitProgressReport } from '@mlc-ai/web-llm';
import type {
  LlmAvailability,
  LlmCompleteOptions,
  LlmEngine,
  LlmMessage,
  LlmStatusListener,
} from './types.js';

export const MODEL_ID = 'Llama-3.2-3B-Instruct-q4f32_1-MLC';

/**
 * Llama-3.2's context window is far larger than Gemini Nano's, so the tool
 * catalogue can afford full schemas for a realistic number of components.
 */
const TOOL_CATALOG_BUDGET = 6000;

class WebLlmEngine implements LlmEngine {
  readonly id = 'webllm' as const;
  readonly label = 'WebLLM Llama-3.2-3B';
  readonly toolCatalogBudget = TOOL_CATALOG_BUDGET;

  #engine: MLCEngineInterface | null = null;
  #loading: Promise<MLCEngineInterface> | null = null;

  async availability(): Promise<LlmAvailability> {
    if (!('gpu' in navigator)) {
      return { state: 'unavailable', detail: 'needs WebGPU' };
    }
    if (this.#engine) return { state: 'available', detail: 'loaded' };
    // WebLLM keeps its weights in CacheStorage, but the layout is an internal
    // detail we'd rather not read. Quote the worst case and let the progress
    // callback tell the truth once loading starts — a cached model reports
    // 100% almost immediately.
    return { state: 'downloadable', detail: '~2 GB, cached after first load' };
  }

  isReady(): boolean {
    return this.#engine !== null;
  }

  async load(onStatus: LlmStatusListener): Promise<void> {
    if (this.#engine) {
      onStatus({ state: 'ready', message: 'already loaded' });
      return;
    }
    if (this.#loading) {
      await this.#loading;
      return;
    }

    onStatus({ state: 'loading', message: 'starting…', progress: 0 });
    this.#loading = CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (report: InitProgressReport) => {
        onStatus({ state: 'loading', message: report.text, progress: report.progress });
      },
    }).then(
      (e) => {
        this.#engine = e;
        onStatus({ state: 'ready', message: 'ready' });
        return e;
      },
      (err: Error) => {
        this.#loading = null;
        onStatus({ state: 'error', message: String(err.message || err) });
        throw err;
      },
    );

    await this.#loading;
  }

  async complete(messages: LlmMessage[], options: LlmCompleteOptions): Promise<string> {
    const engine = this.#engine;
    if (!engine) throw new Error('WebLLM not loaded');
    const resp = await engine.chat.completions.create({
      messages: messages.map((m) => ({ role: m.role, content: m.content })) as Parameters<
        typeof engine.chat.completions.create
      >[0]['messages'],
      temperature: options.temperature,
      stream: false,
    });
    return resp.choices[0]?.message.content ?? '';
  }
}

export const webLlmEngine: LlmEngine = new WebLlmEngine();
