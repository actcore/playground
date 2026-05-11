import './styles.css';
import { loadLlm } from './webllm.js';
import { runUserTurn, type ChatMessage, type LoadedTool } from './chat.js';

// Lenient WebAssembly.compileStreaming — Chrome strict-MIME-checks rejects
// some blob: URL responses despite their Content-Type, so fall back to the
// non-streaming variant. Must run before any wasm load.
{
  const w = WebAssembly as unknown as Record<string, unknown>;
  const wrap = (origName: string, nonStreamingName: 'compile' | 'instantiate') => {
    const orig = w[origName] as ((s: Response | Promise<Response>, i?: unknown) => Promise<unknown>) | undefined;
    if (!orig) return;
    w[origName] = async (source: Response | Promise<Response>, imports?: unknown) => {
      try {
        return await orig.call(WebAssembly, source, imports);
      } catch (e) {
        if (!/MIME|Content-Type/i.test(String((e as Error).message || e))) throw e;
        const resp = source instanceof Response ? source : await source;
        const buf = await resp.arrayBuffer();
        const fn = (WebAssembly as unknown as Record<string, ((b: ArrayBuffer, i?: unknown) => Promise<unknown>) | undefined>)[nonStreamingName];
        if (!fn) throw e;
        return fn(buf, imports);
      }
    };
  };
  wrap('compileStreaming', 'compile');
  wrap('instantiateStreaming', 'instantiate');
}

import { runComponent } from '@actcore/host';
import { loadFromUrl, loadFromFile } from './url-loader.js';

// Absolute URL of the preview2-shim browser bundle. In dev Vite serves
// node_modules directly; for the production GH Pages build we copy the shim
// into public/preview2-shim/ via a build step.
const SHIM_BASE_URL =
  import.meta.env.DEV
    ? location.origin + '/node_modules/@bytecodealliance/preview2-shim/lib/browser/'
    : location.origin + '/preview2-shim/';

const logEl = document.getElementById('log') as HTMLPreElement;
const toolsSection = document.getElementById('tools') as HTMLElement;
const toolListEl = document.getElementById('tool-list') as HTMLUListElement;
const urlInput = document.getElementById('tool-url') as HTMLInputElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;

function log(msg: string, level: 'info' | 'ok' | 'err' = 'info') {
  const cls = level === 'ok' ? 'ok' : level === 'err' ? 'err' : 'dim';
  const ts = new Date().toLocaleTimeString();
  logEl.insertAdjacentHTML(
    'beforeend',
    `<span class="${cls}">${ts}</span>  ${escapeHtml(msg)}\n`,
  );
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const loaded: LoadedTool[] = [];

function sanitizeName(source: string): string {
  // jco uses `name` as the basename of emitted files. Avoid dots, slashes
  // and other separators that break path matching in our import-rewrite step.
  const raw = source.replace(/^[a-z]+:\/\//i, '').split(/[\/:]/).pop() ?? 'component';
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean || 'component';
}

async function loadFromBytes(bytes: Uint8Array, source: string) {
  log(`instantiating ${bytes.length}-byte component…`);
  const { toolProvider } = await runComponent(bytes, {
    name: sanitizeName(source),
    shimBase: SHIM_BASE_URL,
  });

  const resp = await toolProvider.listTools([]);
  log(`  ${resp.tools.length} tool${resp.tools.length === 1 ? '' : 's'} exported`, 'ok');

  for (const t of resp.tools) {
    loaded.push({ provider: toolProvider, def: t, source });
    log(`    • ${t.name}`);
  }
  renderToolList();
}

function renderToolList() {
  toolsSection.hidden = loaded.length === 0;
  toolListEl.innerHTML = '';
  loaded.forEach((t, i) => {
    const desc =
      t.def.description.tag === 'plain' ? t.def.description.val : '[localized]';
    const li = document.createElement('li');
    li.innerHTML = `
      <div><span class="tool-name">${escapeHtml(t.def.name)}</span>
        <span class="muted"> · from ${escapeHtml(t.source)}</span></div>
      <div class="tool-desc">${escapeHtml(desc)}</div>
      <button class="tool-run" data-i="${i}">Run with empty args</button>
      <div class="tool-result" data-result="${i}" hidden></div>
    `;
    toolListEl.appendChild(li);
  });
}

toolListEl.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.tool-run');
  if (!btn) return;
  const i = Number(btn.dataset['i']);
  const t = loaded[i];
  if (!t) return;
  const resultEl = toolListEl.querySelector<HTMLElement>(`[data-result="${i}"]`);
  if (!resultEl) return;
  resultEl.hidden = false;
  resultEl.classList.remove('err');
  resultEl.textContent = 'running…';
  try {
    // CBOR null map: 0xa0
    const args = new Uint8Array([0xa0]);
    const result = await t.provider.callTool(t.def.name, args, []);
    if (result.tag === 'immediate') {
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
          parts.push('error: ' + JSON.stringify(ev.val));
        }
      }
      resultEl.textContent = parts.join('\n');
    } else {
      resultEl.textContent = 'streaming result (not yet rendered in playground)';
    }
  } catch (err) {
    resultEl.classList.add('err');
    resultEl.textContent = String((err as Error).message || err);
  }
});

loadBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  loadBtn.disabled = true;
  try {
    const bytes = await loadFromUrl(url, log);
    await loadFromBytes(bytes, url);
  } catch (err) {
    log((err as Error).message || String(err), 'err');
  } finally {
    loadBtn.disabled = false;
  }
});

// Drag-and-drop a .wasm file anywhere on the page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  try {
    const bytes = await loadFromFile(file, log);
    await loadFromBytes(bytes, `file://${file.name}`);
  } catch (err) {
    log((err as Error).message || String(err), 'err');
  }
});

// === LLM (WebLLM Llama-3.2-1B) =============================================
const llmLoadBtn = document.getElementById('llm-load-btn') as HTMLButtonElement;
const llmStatusText = document.getElementById('llm-status-text') as HTMLSpanElement;
const chatBox = document.getElementById('chat') as HTMLElement;
const messagesEl = document.getElementById('messages') as HTMLElement;
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatSend = document.getElementById('chat-send') as HTMLButtonElement;

const conversation: ChatMessage[] = [];

function renderMessage(m: ChatMessage) {
  if (m.role === 'system') return;
  const div = document.createElement('div');
  div.className = 'msg';
  let body = `<div class="msg-role ${m.role}">${m.role}</div>`;
  if (m.content) body += `<div class="msg-content">${escapeHtml(m.content)}</div>`;
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      body += `<div class="msg-tool-call">→ <b>${escapeHtml(tc.name)}</b>(${escapeHtml(tc.arguments || '{}')})</div>`;
    }
  }
  div.innerHTML = body;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

llmLoadBtn.addEventListener('click', async () => {
  llmLoadBtn.disabled = true;
  try {
    await loadLlm((s) => {
      llmStatusText.textContent = s.message;
      if (s.state === 'ready') {
        chatBox.hidden = false;
        chatInput.disabled = false;
        chatSend.disabled = false;
        llmLoadBtn.hidden = true;
        llmStatusText.textContent = 'Llama-3.2-3B ready';
        log('LLM ready', 'ok');
      } else if (s.state === 'error') {
        llmLoadBtn.disabled = false;
        log('LLM load failed: ' + s.message, 'err');
      }
    });
  } catch (e) {
    llmLoadBtn.disabled = false;
    log('LLM load failed: ' + (e as Error).message, 'err');
  }
});

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatInput.disabled = true;
  chatSend.disabled = true;
  try {
    await runUserTurn(conversation, text, loaded, {
      onMessage: renderMessage,
    });
  } catch (err) {
    log('chat error: ' + (err as Error).message, 'err');
  } finally {
    chatInput.disabled = false;
    chatSend.disabled = false;
    chatInput.focus();
  }
});

// === JSPI gate =============================================================
if (typeof (WebAssembly as unknown as { promising?: unknown }).promising !== 'function') {
  log(
    'This browser lacks WebAssembly.promising (JSPI). Use Chrome 137+, Edge, ' +
      'Firefox Nightly 152+, or Safari Tech Preview 243+. Stable Firefox/Safari ' +
      'ship JSPI per Interop 2026 commitment.',
    'err',
  );
} else {
  log('JSPI available · ready', 'ok');
}
