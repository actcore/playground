/**
 * Chat-loop wiring between Llama (via WebLLM) and the loaded ACT tools.
 *
 * Translation layer between two type systems:
 *   - OpenAI tool-call shape (what Llama emits) — JSON args
 *   - ACT tool-provider shape — CBOR args, list<tool-event> results
 */
import type { ChatCompletionTool } from '@mlc-ai/web-llm';
import type { ToolProvider, ToolDefinition } from '@actcore/host';
import { encodeCbor } from './cbor-mini.js';
import { getEngine } from './webllm.js';

export interface LoadedTool {
  provider: ToolProvider;
  def: ToolDefinition;
  source: string;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

const SYSTEM_PROMPT =
  'You are a helpful assistant running locally in the user\'s browser tab. ' +
  'When the user asks something that requires a tool, call the appropriate tool. ' +
  'Always cite the tool result you got back. Keep replies short.';

export function buildToolList(loaded: LoadedTool[]): ChatCompletionTool[] {
  return loaded.map((t) => {
    const desc =
      t.def.description.tag === 'plain'
        ? t.def.description.val
        : t.def.description.val[0]?.[1] ?? t.def.name;
    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(t.def.parametersSchema);
    } catch {
      parameters = { type: 'object', properties: {} };
    }
    return {
      type: 'function',
      function: {
        name: t.def.name,
        description: desc,
        parameters,
      },
    };
  });
}

async function invokeTool(
  loaded: LoadedTool[],
  name: string,
  jsonArgs: string,
): Promise<string> {
  const tool = loaded.find((t) => t.def.name === name);
  if (!tool) return `error: tool "${name}" not loaded`;
  let parsedArgs: unknown = {};
  try {
    parsedArgs = jsonArgs ? JSON.parse(jsonArgs) : {};
  } catch (e) {
    return `error: invalid JSON args: ${(e as Error).message}`;
  }
  const cborArgs = encodeCbor(parsedArgs);
  try {
    const result = await tool.provider.callTool(name, cborArgs, []);
    if (result.tag === 'streaming') {
      return '[streaming results not yet rendered]';
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
        parts.push('error: ' + (ev.val.message?.val ?? JSON.stringify(ev.val)));
      }
    }
    return parts.join('\n');
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

export interface ChatRunOptions {
  /** Called for every message added to the conversation. */
  onMessage: (m: ChatMessage) => void;
  /** Tool-call iteration cap to prevent runaway loops. */
  maxToolHops?: number;
}

/**
 * Run one user turn through the LLM, dispatching any tool calls back to
 * loaded ACT components, looping until the model produces a final text reply.
 */
export async function runUserTurn(
  history: ChatMessage[],
  userInput: string,
  loaded: LoadedTool[],
  options: ChatRunOptions,
): Promise<void> {
  const engine = getEngine();
  if (!engine) throw new Error('LLM not loaded');

  const maxHops = options.maxToolHops ?? 4;

  if (history.length === 0 || history[0]?.role !== 'system') {
    history.unshift({ role: 'system', content: SYSTEM_PROMPT });
  }
  const userMsg: ChatMessage = { role: 'user', content: userInput };
  history.push(userMsg);
  options.onMessage(userMsg);

  const tools = loaded.length > 0 ? buildToolList(loaded) : undefined;

  for (let hop = 0; hop <= maxHops; hop++) {
    const resp = await engine.chat.completions.create({
      messages: history.map(stripExtras) as unknown as Parameters<
        typeof engine.chat.completions.create
      >[0]['messages'],
      tools,
      tool_choice: tools ? 'auto' : undefined,
      stream: false,
    });

    const choice = resp.choices[0];
    if (!choice) break;
    const msg = choice.message;

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: msg.tool_calls?.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function?.name ?? '',
          arguments: tc.function?.arguments ?? '',
        },
      })),
    };
    history.push(assistantMsg);
    options.onMessage(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return; // final answer
    }

    for (const tc of assistantMsg.tool_calls) {
      const result = await invokeTool(loaded, tc.function.name, tc.function.arguments);
      const toolMsg: ChatMessage = {
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      };
      history.push(toolMsg);
      options.onMessage(toolMsg);
    }
  }
}

function stripExtras(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_call_id) out['tool_call_id'] = m.tool_call_id;
  if (m.tool_calls) out['tool_calls'] = m.tool_calls;
  return out;
}
