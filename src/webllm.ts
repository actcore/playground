/**
 * Thin wrapper around @mlc-ai/web-llm.
 *
 * The model is downloaded from the HuggingFace mlc-chat CDN on first load
 * (~700 MB for Llama-3.2-1B-Instruct-q4f16_1) and cached in the browser
 * (CacheStorage). Subsequent loads are near-instant.
 *
 * Why Llama-3.2-1B-Instruct-q4f16_1: smallest model in WebLLM's catalog
 * that handles tool/function-calling well. Larger models (Phi-3.5-mini,
 * Qwen2.5-1.5B) would give better reasoning but ~2x the download.
 */
import { CreateMLCEngine, type MLCEngineInterface, type InitProgressReport } from '@mlc-ai/web-llm';

// Hermes-3-Llama-3.1-8B is one of the few WebLLM-supported models with
// native ChatCompletionRequest.tools (function-calling). f32 variant chosen
// over q4f16 because the latter triggers WGSL shader-compile failures on
// some GPUs/drivers ("[Invalid ShaderModule]"). ~6.5 GB one-time download,
// cached in browser CacheStorage after that.
export const MODEL_ID = 'Hermes-3-Llama-3.1-8B-q4f32_1-MLC';

export interface LlmStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  progress?: number;
}

export type LlmStatusListener = (s: LlmStatus) => void;

let engine: MLCEngineInterface | null = null;
let loading: Promise<MLCEngineInterface> | null = null;

export function getEngine(): MLCEngineInterface | null {
  return engine;
}

export async function loadLlm(onStatus: LlmStatusListener = () => {}): Promise<MLCEngineInterface> {
  if (engine) {
    onStatus({ state: 'ready', message: 'already loaded' });
    return engine;
  }
  if (loading) return loading;

  onStatus({ state: 'loading', message: 'starting…', progress: 0 });
  loading = CreateMLCEngine(MODEL_ID, {
    initProgressCallback: (report: InitProgressReport) => {
      onStatus({
        state: 'loading',
        message: report.text,
        progress: report.progress,
      });
    },
  }).then(
    (e) => {
      engine = e;
      onStatus({ state: 'ready', message: 'ready' });
      return e;
    },
    (err) => {
      loading = null;
      onStatus({ state: 'error', message: String(err.message || err) });
      throw err;
    },
  );

  return loading;
}
