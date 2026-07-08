/**
 * Engine-agnostic surface the chat loop talks to.
 *
 * Two engines exist today: the browser's own model via the Prompt API
 * (`chrome`) and a WebGPU-hosted Llama via WebLLM (`webllm`). The loop in
 * chat.ts does its own prompt-based tool dispatch, so an engine only has to
 * turn a list of messages into a string — it never has to support tool
 * calling itself.
 */

export type LlmEngineId = 'chrome' | 'webllm';

export interface LlmStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  message: string;
  /** 0..1, only for engines that can report download progress. */
  progress?: number;
}

export type LlmStatusListener = (s: LlmStatus) => void;

/** Mirrors the Prompt API's availability vocabulary; WebLLM maps onto it. */
export type LlmAvailabilityState = 'available' | 'downloadable' | 'unavailable';

export interface LlmAvailability {
  state: LlmAvailabilityState;
  /** Why it can't run, or what using it will cost. Shown next to the picker. */
  detail: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompleteOptions {
  temperature: number;
}

export interface LlmEngine {
  readonly id: LlmEngineId;
  /** Shown in the engine picker. */
  readonly label: string;
  /**
   * Characters the chat loop may spend describing loaded tools. Gemini Nano
   * has a ~9k-token context window, so its tool catalogue has to stay far
   * smaller than a 3B Llama's or the schemas crowd out the conversation.
   */
  readonly toolCatalogBudget: number;
  availability(): Promise<LlmAvailability>;
  load(onStatus: LlmStatusListener): Promise<void>;
  isReady(): boolean;
  complete(messages: LlmMessage[], options: LlmCompleteOptions): Promise<string>;
}
