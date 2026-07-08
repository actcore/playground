/**
 * The engine registry and the default-pick rule.
 *
 * Order matters: it's the order of the picker, and `pickDefault` walks it in
 * order. Chrome's built-in model comes first because when it's available it
 * costs nothing to use, which is the difference between a visitor trying the
 * demo and a visitor closing the tab on a 2 GB download.
 */

import { chromeEngine } from './chrome.js';
import { webLlmEngine } from './webllm.js';
import type { LlmAvailability, LlmEngine, LlmEngineId } from './types.js';

export * from './types.js';

export const ENGINES: readonly LlmEngine[] = [chromeEngine, webLlmEngine];

export function engineById(id: string): LlmEngine | undefined {
  return ENGINES.find((e) => e.id === id);
}

export interface EngineChoice {
  engine: LlmEngine;
  availability: LlmAvailability;
}

export async function probeEngines(): Promise<EngineChoice[]> {
  return Promise.all(
    ENGINES.map(async (engine) => ({ engine, availability: await engine.availability() })),
  );
}

/**
 * The first engine that can run without a download, else the first that can
 * run at all, else the first one — so the picker always has a selection and
 * an unavailable engine still explains itself.
 */
export function pickDefault(choices: EngineChoice[]): LlmEngineId {
  const ready = choices.find((c) => c.availability.state === 'available');
  const usable = ready ?? choices.find((c) => c.availability.state === 'downloadable');
  return (usable ?? choices[0])?.engine.id ?? 'webllm';
}
