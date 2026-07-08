/**
 * Chrome's built-in model (Gemini Nano) via the Prompt API.
 *
 * Shipped in Chrome 148 on desktop only — Chrome for Android doesn't have it,
 * and both Mozilla and WebKit have filed negative standards positions — so
 * this engine is an upgrade for the visitors who can run it, never a
 * replacement for WebLLM.
 *
 * When `availability()` says `available` the model is already on disk: a
 * session opens in ~0.4 s and a turn takes ~0.5 s, against WebLLM's ~2 GB
 * download and WGSL shader compile. Chrome only demands a user gesture for a
 * create() that would start the model download, which is why load() stays
 * wired to a button.
 *
 * A session is created per completion rather than kept alive across turns:
 * chat.ts rebuilds its system prompt every turn because the loaded tool list
 * changes as the user loads components, and a session's initial prompts are
 * fixed once it exists.
 *
 * Chrome accepts `LanguageModel.create({tools})` but never invokes the
 * `execute` callbacks — native tool calling is specified and not yet
 * implemented (verified on Chrome 151). We dispatch tools ourselves in
 * chat.ts either way: that loop is where a consent gate and an audit record
 * belong, and a browser-internal loop would hide both.
 */

import type {
  LlmAvailability,
  LlmCompleteOptions,
  LlmEngine,
  LlmMessage,
  LlmStatusListener,
} from './types.js';

// Minimal shape of the Prompt API we depend on. Chrome ships more than this
// (multimodal input, responseConstraint, append/clone); we only declare what
// this engine calls.
interface LanguageModelSession {
  prompt(input: string): Promise<string>;
  destroy(): void;
  readonly contextWindow: number;
  readonly contextUsage: number;
}

interface LanguageModelCreateOptions {
  initialPrompts?: Array<{ role: string; content: string }>;
  temperature?: number;
  topK?: number;
  monitor?: (m: EventTarget) => void;
}

interface LanguageModelStatic {
  availability(): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

declare global {
  // eslint-disable-next-line no-var
  var LanguageModel: LanguageModelStatic | undefined;
}

// Sampling parameters are set per session. Low temperature and topK=1 keep the
// `<tool_call>` block chat.ts asks for well-formed.
const TOP_K = 1;

/**
 * ~9k tokens of context, minus room for the conversation and the answer. Six
 * loaded components would otherwise spend the whole window on JSON Schemas.
 */
const TOOL_CATALOG_BUDGET = 2400;

function api(): LanguageModelStatic | undefined {
  return typeof LanguageModel === 'undefined' ? undefined : LanguageModel;
}

class ChromeEngine implements LlmEngine {
  readonly id = 'chrome' as const;
  readonly label = 'Chrome built-in (Gemini Nano)';
  readonly toolCatalogBudget = TOOL_CATALOG_BUDGET;

  #ready = false;

  async availability(): Promise<LlmAvailability> {
    const lm = api();
    if (!lm) {
      return {
        state: 'unavailable',
        detail: 'needs Chrome 148+ on desktop (Windows, macOS, Linux)',
      };
    }
    let state: Awaited<ReturnType<LanguageModelStatic['availability']>>;
    try {
      state = await lm.availability();
    } catch (e) {
      // A Permissions-Policy denial throws NotAllowedError; anything else here
      // is equally fatal for our purposes.
      return { state: 'unavailable', detail: (e as Error).message };
    }
    switch (state) {
      case 'available':
        return { state: 'available', detail: 'nothing to download' };
      case 'downloadable':
        return { state: 'downloadable', detail: 'one-time model download' };
      case 'downloading':
        return { state: 'downloadable', detail: 'model download in progress' };
      default:
        return {
          state: 'unavailable',
          detail: 'this device can’t run the built-in model (needs ~22 GB free, 4 GB VRAM)',
        };
    }
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Opens and discards a probe session. The Prompt API has no separate "warm
   * up" call, and creating one here is what triggers the model download (with
   * the user gesture this is called under) so the first chat turn is fast.
   */
  async load(onStatus: LlmStatusListener): Promise<void> {
    const lm = api();
    if (!lm) throw new Error('Prompt API not available in this browser');
    if (this.#ready) {
      onStatus({ state: 'ready', message: 'already loaded' });
      return;
    }

    onStatus({ state: 'loading', message: 'opening session…', progress: 0 });
    try {
      const session = await lm.create({
        monitor: (m) => {
          m.addEventListener('downloadprogress', (e) => {
            const { loaded, total } = e as ProgressEvent;
            if (!total) return;
            onStatus({
              state: 'loading',
              message: `downloading model — ${Math.round((loaded / total) * 100)}%`,
              progress: loaded / total,
            });
          });
        },
      });
      session.destroy();
      this.#ready = true;
      onStatus({ state: 'ready', message: 'ready' });
    } catch (e) {
      onStatus({ state: 'error', message: (e as Error).message });
      throw e;
    }
  }

  async complete(messages: LlmMessage[], options: LlmCompleteOptions): Promise<string> {
    const lm = api();
    if (!lm) throw new Error('Prompt API not available in this browser');

    // Everything but the final turn seeds the session; the final turn is the
    // prompt. chat.ts always ends its history with a user message.
    const last = messages[messages.length - 1];
    if (!last) throw new Error('no messages to complete');
    const initialPrompts = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));

    let session: LanguageModelSession;
    try {
      session = await lm.create({
        ...(initialPrompts.length > 0 ? { initialPrompts } : {}),
        temperature: options.temperature,
        topK: TOP_K,
      });
    } catch (e) {
      // The context window is ~9k tokens, small enough that a long chat or a
      // fat tool catalogue can genuinely overflow it. Say so plainly instead
      // of surfacing a bare QuotaExceededError.
      if ((e as Error).name === 'QuotaExceededError') {
        throw new Error(
          'conversation is longer than the built-in model’s context window — ' +
            'reload the page to start over, or switch to WebLLM',
        );
      }
      throw e;
    }

    try {
      return await session.prompt(last.content);
    } finally {
      session.destroy();
    }
  }
}

export const chromeEngine: LlmEngine = new ChromeEngine();
