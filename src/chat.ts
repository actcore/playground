/**
 * Chat loop with prompt-based tool dispatch.
 *
 * Rather than relying on an engine's own tool-calling support, we embed the
 * available tools directly in the system prompt and instruct the model to
 * emit a structured `<tool_call name="X">{...}</tool_call>` block when it
 * wants to call one. Neither engine gives us a usable native path: WebLLM's
 * ChatCompletionRequest.tools is hardcoded to a short list of Hermes-tuned 8B
 * models with a brittle parser, and Chrome accepts LanguageModel.create({tools})
 * without ever invoking the callbacks.
 *
 * Owning the loop is also what makes a consent gate and an audit record
 * possible: an engine that dispatched tools internally would run a component
 * without either.
 *
 * Round-trip:
 *   1. We send: system + history + user.
 *   2. Model replies. We scan the reply for `<tool_call>` blocks.
 *   3. For each block, we invoke the matching ACT tool, append a
 *      `Tool result: ...` follow-up as the next user turn.
 *   4. Re-prompt the model with the augmented history.
 *   5. Loop until reply has no tool_call (final answer) or hop cap.
 *
 * This works with any instruction-tuned model — verified against both
 * Llama-3.2-3B and Chrome's Gemini Nano, which emit the same block from the
 * same prompt.
 */
import type { ToolProvider, ToolDefinition } from '@actcore/web-runtime';
import { decodeCbor, encodeCbor } from './cbor.js';
import type { LlmEngine, LlmMessage } from './llm/index.js';

export interface LoadedTool {
  provider: ToolProvider;
  def: ToolDefinition;
  source: string;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Parsed tool calls extracted from an assistant message (for UI). */
  tool_calls?: Array<{ name: string; arguments: string }>;
}

const BASE_INSTRUCTIONS =
  'You are a helpful assistant running locally in the user\'s browser tab. ' +
  'You have NO knowledge of the current time, the current date, files, ' +
  'network state, or anything outside this conversation — your training data ' +
  'is also stale and must not be trusted for "now". The ONLY way to get fresh ' +
  'information is to call one of the tools below.';

const TOOL_FORMAT = [
  '',
  'When you need to call a tool, emit EXACTLY this block and nothing else on ' +
    'that line:',
  '',
  '  <tool_call name="TOOL_NAME">{"arg1": value1, "arg2": value2}</tool_call>',
  '',
  'Rules:',
  '  - The JSON inside MUST be valid (double-quoted keys and strings).',
  '  - Use `{}` if the tool takes no arguments.',
  '  - After you emit a tool_call, STOP — do not continue with prose. The ' +
    'system will run the tool and feed the result back to you in the next ' +
    'turn, then you can produce your final reply quoting that result.',
  '  - Never invent or guess a result. If a tool fails or no relevant tool ' +
    'exists, say so plainly.',
].join('\n');

function describeTools(loaded: LoadedTool[], budgetChars: number): string {
  if (loaded.length === 0) return 'No tools are currently loaded.';
  // Split the catalogue budget evenly across loaded tools. Gemini Nano has a
  // ~9k-token context window, so six loaded components would otherwise spend
  // the whole conversation on JSON Schemas. 600 chars is as much detail as any
  // one schema has ever needed here; 120 keeps a truncated one recognisable.
  const perTool = Math.min(600, Math.max(120, Math.floor(budgetChars / loaded.length)));
  const lines: string[] = ['Available tools:'];
  for (const t of loaded) {
    const desc =
      t.def.description.tag === 'plain'
        ? t.def.description.val
        : t.def.description.val[0]?.[1] ?? '(no description)';
    let schema = t.def.parametersSchema;
    if (schema.length > perTool) schema = schema.slice(0, perTool) + '…';
    lines.push(`- name: ${t.def.name}`);
    lines.push(`  description: ${desc}`);
    lines.push(`  parameters (JSON Schema): ${schema}`);
  }
  return lines.join('\n');
}

function buildSystemPrompt(loaded: LoadedTool[], budgetChars: number): string {
  return [BASE_INSTRUCTIONS, '', describeTools(loaded, budgetChars), TOOL_FORMAT].join('\n');
}

const TOOL_CALL_REGEX = /<tool_call\s+name="([^"]+)"\s*>\s*([\s\S]*?)\s*<\/tool_call>/g;

/**
 * Both models sometimes decide the block is code and wrap it in a markdown
 * fence, emitting ```tool_call name="x">…</tool_call>``` — swallowing the
 * opening angle bracket in the process. Normalising the fence away beats
 * loosening TOOL_CALL_REGEX, which would then also match prose that merely
 * talks about a tool call.
 */
function stripCodeFences(text: string): string {
  return text
    .replace(/```(?:[a-z]+)?\s*<?tool_call/g, '<tool_call')
    .replace(/<\/tool_call>\s*```/g, '</tool_call>');
}

function extractToolCalls(
  text: string,
): Array<{ name: string; arguments: string }> {
  const out: Array<{ name: string; arguments: string }> = [];
  for (const m of text.matchAll(TOOL_CALL_REGEX)) {
    out.push({ name: m[1]!, arguments: m[2]! });
  }
  return out;
}

/**
 * Content parts cross the component boundary with `mimeType` as an
 * `option<string>` variant (`{tag:'some',val}`) rather than a plain string,
 * depending on which interface produced them. @actcore/web-runtime normalises
 * the same way for WebMCP, but doesn't export the helper.
 */
function normalizeMime(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && (raw as { tag?: string }).tag === 'some') {
    return String((raw as { val: unknown }).val);
  }
  return 'application/octet-stream';
}

/** Likewise, `data` arrives as a Uint8Array or as a plain array of bytes. */
function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(Array.isArray(data) ? data : []);
}

async function invokeTool(
  loaded: LoadedTool[],
  name: string,
  jsonArgs: string,
): Promise<string> {
  const tool = loaded.find((t) => t.def.name === name);
  if (!tool) return `Error: tool "${name}" is not loaded.`;
  let parsedArgs: unknown = {};
  if (jsonArgs.trim() && jsonArgs.trim() !== '{}') {
    try {
      parsedArgs = JSON.parse(jsonArgs);
    } catch (e) {
      return `Error: arguments are not valid JSON: ${(e as Error).message}`;
    }
  }
  const cborArgs = encodeCbor(parsedArgs);
  try {
    const result = await tool.provider.callTool(name, cborArgs, []);
    if (result.tag === 'streaming') {
      return '[streaming tool result not yet supported in playground]';
    }
    const parts: string[] = [];
    for (const ev of result.val) {
      if (ev.tag === 'content') {
        const mime = normalizeMime(ev.val.mimeType);
        const bytes = asBytes(ev.val.data);
        if (mime.startsWith('text/') || mime === 'application/json') {
          parts.push(new TextDecoder().decode(bytes));
        } else if (mime === 'application/cbor') {
          // The model can't read CBOR, and ACT SDKs return it by default —
          // decode to JSON so the tool result is something to quote.
          try {
            parts.push(JSON.stringify(decodeCbor(bytes)));
          } catch {
            parts.push(`(cbor, ${bytes.length} bytes, undecodable)`);
          }
        } else {
          parts.push(`(${mime}, ${bytes.length} bytes)`);
        }
      } else {
        const msg =
          ev.val.message.tag === 'plain'
            ? ev.val.message.val
            : ev.val.message.val[0]?.[1] ?? 'unknown error';
        parts.push(`Error: ${msg}`);
      }
    }
    return parts.join('\n');
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

export interface ChatRunOptions {
  /** The loaded LLM engine to run this turn against. */
  engine: LlmEngine;
  /** Called for every message added to the conversation. */
  onMessage: (m: ChatMessage) => void;
  /** Maximum tool-call hops per user turn. Default 4. */
  maxToolHops?: number;
  /** Sampling temperature. Default 0.2 — low for tool-call format reliability. */
  temperature?: number;
}

export async function runUserTurn(
  history: ChatMessage[],
  userInput: string,
  loaded: LoadedTool[],
  options: ChatRunOptions,
): Promise<void> {
  const { engine } = options;
  if (!engine.isReady()) throw new Error('LLM not loaded');
  const maxHops = options.maxToolHops ?? 4;
  const temperature = options.temperature ?? 0.2;

  // Rebuild system prompt every turn — tool list may have changed since last.
  const systemMsg: ChatMessage = {
    role: 'system',
    content: buildSystemPrompt(loaded, engine.toolCatalogBudget),
  };
  if (history.length === 0 || history[0]?.role !== 'system') {
    history.unshift(systemMsg);
  } else {
    history[0] = systemMsg;
  }

  const userMsg: ChatMessage = { role: 'user', content: userInput };
  history.push(userMsg);
  options.onMessage(userMsg);

  for (let hop = 0; hop <= maxHops; hop++) {
    const messages: LlmMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
    const raw = stripCodeFences(await engine.complete(messages, { temperature }));
    const toolCalls = extractToolCalls(raw);

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: raw,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    history.push(assistantMsg);
    options.onMessage(assistantMsg);

    if (toolCalls.length === 0) return;

    // Run every tool_call sequentially. Compose a synthetic user turn carrying
    // the results. We don't use OpenAI's `tool` role because we're not using
    // WebLLM's native tool-calling API.
    const resultLines: string[] = [];
    for (const tc of toolCalls) {
      const result = await invokeTool(loaded, tc.name, tc.arguments);
      resultLines.push(`Tool result for \`${tc.name}\`:\n${result}`);
    }
    const toolResultMsg: ChatMessage = {
      role: 'user',
      content: resultLines.join('\n\n') + '\n\nNow write your final reply, quoting the result.',
    };
    history.push(toolResultMsg);
    options.onMessage(toolResultMsg);
  }
}
