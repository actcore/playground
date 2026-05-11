/**
 * Chat loop with prompt-based tool dispatch.
 *
 * Rather than relying on WebLLM's hardcoded ChatCompletionRequest.tools
 * support (which is limited to a short list of Hermes-fine-tuned 8B models
 * and uses a brittle JSON parser), we embed the available tools directly in
 * the system prompt and instruct the model to emit a structured
 * `<tool_call name="X">{...}</tool_call>` block when it wants to call one.
 *
 * Round-trip:
 *   1. We send: system + history + user.
 *   2. Model replies. We scan the reply for `<tool_call>` blocks.
 *   3. For each block, we invoke the matching ACT tool, append a
 *      `Tool result: ...` follow-up as the next user turn.
 *   4. Re-prompt the model with the augmented history.
 *   5. Loop until reply has no tool_call (final answer) or hop cap.
 *
 * This works with any instruction-tuned model (Llama-3.2-1B and up). No
 * dependency on WebLLM's tool-list and no fragility around output format.
 */
import type { ToolProvider, ToolDefinition } from '@actcore/host';
import { encodeCbor } from './cbor-mini.js';
import { getEngine } from './webllm.js';

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

function describeTools(loaded: LoadedTool[]): string {
  if (loaded.length === 0) return 'No tools are currently loaded.';
  const lines: string[] = ['Available tools:'];
  for (const t of loaded) {
    const desc =
      t.def.description.tag === 'plain'
        ? t.def.description.val
        : t.def.description.val[0]?.[1] ?? '(no description)';
    let schema = t.def.parametersSchema;
    if (schema.length > 600) schema = schema.slice(0, 600) + '…';
    lines.push(`- name: ${t.def.name}`);
    lines.push(`  description: ${desc}`);
    lines.push(`  parameters (JSON Schema): ${schema}`);
  }
  return lines.join('\n');
}

function buildSystemPrompt(loaded: LoadedTool[]): string {
  return [BASE_INSTRUCTIONS, '', describeTools(loaded), TOOL_FORMAT].join('\n');
}

const TOOL_CALL_REGEX = /<tool_call\s+name="([^"]+)"\s*>\s*([\s\S]*?)\s*<\/tool_call>/g;

function extractToolCalls(
  text: string,
): Array<{ name: string; arguments: string }> {
  const out: Array<{ name: string; arguments: string }> = [];
  for (const m of text.matchAll(TOOL_CALL_REGEX)) {
    out.push({ name: m[1]!, arguments: m[2]! });
  }
  return out;
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
        const mime = ev.val.mimeType ?? 'application/octet-stream';
        if (mime.startsWith('text/') || mime === 'application/json') {
          parts.push(new TextDecoder().decode(ev.val.data as Uint8Array));
        } else if (mime === 'application/cbor') {
          parts.push(`(cbor, ${ev.val.data.length} bytes)`);
        } else {
          parts.push(`(${mime}, ${ev.val.data.length} bytes)`);
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
  const engine = getEngine();
  if (!engine) throw new Error('LLM not loaded');
  const maxHops = options.maxToolHops ?? 4;
  const temperature = options.temperature ?? 0.2;

  // Rebuild system prompt every turn — tool list may have changed since last.
  const systemMsg: ChatMessage = { role: 'system', content: buildSystemPrompt(loaded) };
  if (history.length === 0 || history[0]?.role !== 'system') {
    history.unshift(systemMsg);
  } else {
    history[0] = systemMsg;
  }

  const userMsg: ChatMessage = { role: 'user', content: userInput };
  history.push(userMsg);
  options.onMessage(userMsg);

  for (let hop = 0; hop <= maxHops; hop++) {
    const resp = await engine.chat.completions.create({
      messages: history.map((m) => ({ role: m.role, content: m.content })) as Parameters<
        typeof engine.chat.completions.create
      >[0]['messages'],
      temperature,
      stream: false,
    });

    const raw = resp.choices[0]?.message.content ?? '';
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
