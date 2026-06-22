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

import { runComponent, resolveLocalizedString } from '@actcore/host';
import { loadFromUrl, loadFromFile } from './url-loader.js';
import { encodeCbor } from './cbor-mini.js';

// Absolute URL of the preview2-shim browser bundle. In dev Vite serves
// node_modules directly; for the production GH Pages build we copy the shim
// into public/preview2-shim/ via a build step.
const SHIM_BASE_URL =
  import.meta.env.DEV
    ? location.origin + '/node_modules/@bytecodealliance/preview2-shim/dist/browser/'
    : location.origin + '/preview2-shim/';

// Absolute URL of @actcore/host's wasi:http p3 shim. Implements the
// wasi:http/{client,types}@0.3.x interfaces that wasip3 components import,
// which preview2-shim's http.js does not cover. Copied alongside preview2-shim
// by scripts/copy-shims.mjs at prebuild time.
const WASI_HTTP_SHIM_URL =
  import.meta.env.DEV
    ? location.origin + '/node_modules/@actcore/host/dist/shims/wasi-http.js'
    : location.origin + '/host/shims/wasi-http.js';

const logEl = document.getElementById('log') as HTMLPreElement;
const toolsSection = document.getElementById('tools') as HTMLElement;
const toolListEl = document.getElementById('tool-list') as HTMLUListElement;
const urlInput = document.getElementById('tool-url') as HTMLInputElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
const cardSection = document.getElementById('component-card') as HTMLElement;
const cardSourceEl = document.getElementById('card-source') as HTMLElement;
const cardSizeEl = document.getElementById('card-size') as HTMLElement;
const cardShaEl = document.getElementById('card-sha256') as HTMLElement;
const cardToolCountEl = document.getElementById('card-tool-count') as HTMLElement;

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
  loaded.length = 0;
  renderToolList();
  await renderComponentCard(bytes, source);

  log(`instantiating ${bytes.length}-byte component…`);
  const { toolProvider } = await runComponent(bytes, {
    name: sanitizeName(source),
    shimBase: SHIM_BASE_URL,
    wasiHttpShimUrl: WASI_HTTP_SHIM_URL,
  });

  const resp = await toolProvider.listTools([]);
  log(`  ${resp.tools.length} tool${resp.tools.length === 1 ? '' : 's'} exported`, 'ok');

  for (const t of resp.tools) {
    loaded.push({ provider: toolProvider, def: t, source });
    log(`    • ${t.name}`);
  }
  cardToolCountEl.textContent = String(resp.tools.length);
  renderToolList();
}

async function renderComponentCard(bytes: Uint8Array, source: string) {
  cardSection.hidden = false;
  cardSourceEl.textContent = source;
  cardSizeEl.textContent = formatBytes(bytes.length);
  cardToolCountEl.textContent = '…';

  const hash = await sha256Hex(bytes);
  const short = hash.slice(0, 12) + '…' + hash.slice(-8);
  cardShaEl.classList.remove('expanded');
  cardShaEl.innerHTML = `<span class="hash-short">sha256:${short}</span><span class="hash-full">sha256:${hash}</span>`;
  cardShaEl.title = 'click to expand';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

document.querySelectorAll<HTMLButtonElement>('.examples .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const url = chip.dataset['url'];
    if (!url) return;
    urlInput.value = url;
    loadBtn.click();
  });
});

document.getElementById('card-sha256')?.addEventListener('click', (e) => {
  (e.currentTarget as HTMLElement).classList.toggle('expanded');
});

interface ParsedSchema {
  raw: unknown;
  properties: Record<string, JsonSchemaProperty>;
  required: Set<string>;
}

interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  items?: unknown;
}

function parseSchema(schemaStr: string): ParsedSchema {
  let raw: unknown = {};
  if (schemaStr && schemaStr.trim()) {
    try { raw = JSON.parse(schemaStr); } catch { raw = {}; }
  }
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const props = (obj['properties'] && typeof obj['properties'] === 'object')
    ? obj['properties'] as Record<string, JsonSchemaProperty>
    : {};
  const required = new Set(Array.isArray(obj['required']) ? obj['required'] as string[] : []);
  return { raw, properties: props, required };
}

function renderArgInput(name: string, spec: JsonSchemaProperty, isRequired: boolean): string {
  const t = Array.isArray(spec.type) ? spec.type[0] : spec.type;
  const desc = spec.description ? escapeHtml(spec.description) : '';
  const req = isRequired ? ' required' : '';
  const reqMark = isRequired ? '<span class="req">*</span>' : '';
  const label = `<label class="arg-label" for="arg-${escapeHtml(name)}">${escapeHtml(name)}${reqMark}<span class="arg-type muted"> · ${escapeHtml(String(t ?? 'any'))}</span></label>`;
  const help = desc ? `<div class="arg-desc muted">${desc}</div>` : '';

  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    const opts = spec.enum.map((v) => {
      const s = String(v);
      const sel = spec.default !== undefined && String(spec.default) === s ? ' selected' : '';
      return `<option value="${escapeHtml(s)}"${sel}>${escapeHtml(s)}</option>`;
    }).join('');
    const placeholderOpt = isRequired ? '' : `<option value="">(omit)</option>`;
    return `<div class="arg-field" data-name="${escapeHtml(name)}" data-kind="enum">${label}${help}<select name="${escapeHtml(name)}" id="arg-${escapeHtml(name)}"${req}>${placeholderOpt}${opts}</select></div>`;
  }

  if (t === 'boolean') {
    const checked = spec.default === true ? ' checked' : '';
    return `<div class="arg-field arg-field-bool" data-name="${escapeHtml(name)}" data-kind="boolean">${label}${help}<input type="checkbox" name="${escapeHtml(name)}" id="arg-${escapeHtml(name)}"${checked}></div>`;
  }

  if (t === 'integer' || t === 'number') {
    const step = t === 'integer' ? ' step="1"' : ' step="any"';
    const dflt = spec.default !== undefined ? ` value="${escapeHtml(String(spec.default))}"` : '';
    return `<div class="arg-field" data-name="${escapeHtml(name)}" data-kind="${t}">${label}${help}<input type="number"${step} name="${escapeHtml(name)}" id="arg-${escapeHtml(name)}"${dflt}${req}></div>`;
  }

  if (t === 'array' || t === 'object') {
    const dflt = spec.default !== undefined ? escapeHtml(JSON.stringify(spec.default, null, 2)) : '';
    const ph = t === 'array' ? '[ ]' : '{ }';
    return `<div class="arg-field" data-name="${escapeHtml(name)}" data-kind="${t}">${label}${help}<textarea name="${escapeHtml(name)}" id="arg-${escapeHtml(name)}" rows="3" placeholder="${ph} (JSON)" spellcheck="false"${req}>${dflt}</textarea></div>`;
  }

  // string and fallback
  const dflt = spec.default !== undefined ? ` value="${escapeHtml(String(spec.default))}"` : '';
  const placeholder = spec.format ? ` placeholder="${escapeHtml(spec.format)}"` : '';
  return `<div class="arg-field" data-name="${escapeHtml(name)}" data-kind="string">${label}${help}<input type="text" name="${escapeHtml(name)}" id="arg-${escapeHtml(name)}"${placeholder}${dflt} spellcheck="false" autocomplete="off"${req}></div>`;
}

function collectFormValues(form: HTMLFormElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of form.querySelectorAll<HTMLElement>('.arg-field')) {
    const name = field.dataset['name']!;
    const kind = field.dataset['kind']!;
    const input = field.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')!;
    if (kind === 'boolean') {
      out[name] = (input as HTMLInputElement).checked;
      continue;
    }
    const raw = input.value;
    if (raw === '' && !input.hasAttribute('required')) continue;
    if (kind === 'integer') out[name] = parseInt(raw, 10);
    else if (kind === 'number') out[name] = Number(raw);
    else if (kind === 'array' || kind === 'object') {
      try { out[name] = JSON.parse(raw); }
      catch (e) { throw new Error(`${name}: invalid JSON — ${(e as Error).message}`); }
    }
    else out[name] = raw;
  }
  return out;
}

function renderToolList() {
  toolsSection.hidden = loaded.length === 0;
  toolListEl.innerHTML = '';
  loaded.forEach((t, i) => {
    const desc = resolveLocalizedString(t.def.description);
    const schema = parseSchema(t.def.parametersSchema);
    const propNames = Object.keys(schema.properties);
    const hasProps = propNames.length > 0;
    const schemaJson = t.def.parametersSchema ? escapeHtml(t.def.parametersSchema) : '';

    let runUI: string;
    if (hasProps) {
      const fields = propNames
        .map((n) => renderArgInput(n, schema.properties[n]!, schema.required.has(n)))
        .join('');
      runUI = `<form class="tool-args" data-i="${i}">${fields}<button type="submit" class="tool-run">Run</button></form>`;
    } else {
      runUI = `<button class="tool-run tool-run-empty" data-i="${i}">Run with empty args</button>`;
    }

    const schemaDetails = schemaJson
      ? `<details class="schema-details"><summary>view schema</summary><pre class="schema-pre">${schemaJson}</pre></details>`
      : '';

    const li = document.createElement('li');
    li.innerHTML = `
      <div><span class="tool-name">${escapeHtml(t.def.name)}</span>
        <span class="muted"> · from ${escapeHtml(t.source)}</span></div>
      <div class="tool-desc">${escapeHtml(desc)}</div>
      ${schemaDetails}
      ${runUI}
      <div class="tool-result" data-result="${i}" hidden></div>
    `;
    toolListEl.appendChild(li);
  });
}

async function runTool(i: number, args: Record<string, unknown>): Promise<void> {
  const t = loaded[i];
  if (!t) return;
  const resultEl = toolListEl.querySelector<HTMLElement>(`[data-result="${i}"]`);
  if (!resultEl) return;
  resultEl.hidden = false;
  resultEl.classList.remove('err');
  resultEl.textContent = 'running…';
  const argsPreview = Object.keys(args).length === 0 ? '{}' : JSON.stringify(args);
  log(`calling ${t.def.name}(${argsPreview}) · from ${t.source}`);
  const t0 = performance.now();
  try {
    const argBytes = encodeCbor(args);
    const result = await t.provider.callTool(t.def.name, argBytes, []);
    const ms = Math.round(performance.now() - t0);
    if (result.tag === 'immediate') {
      const parts: string[] = [];
      let errEv: string | null = null;
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
          const msg = resolveLocalizedString(ev.val.message);
          parts.push(`error: ${ev.val.kind} · ${msg}`);
          errEv = `${ev.val.kind} · ${msg}`;
        }
      }
      resultEl.textContent = parts.join('\n');
      if (errEv) {
        resultEl.classList.add('err');
        log(`  ✗ ${t.def.name} → ${errEv} (${ms} ms)`, 'err');
      } else {
        log(`  → ${t.def.name} returned ${result.val.length} event${result.val.length === 1 ? '' : 's'} (${ms} ms)`, 'ok');
      }
    } else {
      // Streaming variant — the host has already drained the stream and given
      // us an array of tool-events in result.val. Render them the same way as
      // immediate, but mime-type from wasi:http content-part comes as an
      // option<string> variant `{tag:'some',val:string}` rather than a plain
      // string, so normalise first.
      const parts: string[] = [];
      let errEv: string | null = null;
      for (const ev of result.val) {
        if (ev.tag === 'content') {
          const rawMime = ev.val.mimeType;
          const mime: string =
            typeof rawMime === 'string'
              ? rawMime
              : rawMime && typeof rawMime === 'object' && (rawMime as { tag?: string }).tag === 'some'
                ? String((rawMime as { val: string }).val)
                : 'application/octet-stream';
          const data = ev.val.data instanceof Uint8Array
            ? ev.val.data
            : new Uint8Array(Array.isArray(ev.val.data) ? (ev.val.data as number[]) : []);
          if (mime.startsWith('text/') || mime === 'application/json') {
            parts.push(new TextDecoder().decode(data));
          } else if (mime === 'application/cbor') {
            parts.push(`(cbor, ${data.length} bytes)`);
          } else {
            parts.push(`(${mime}, ${data.length} bytes)`);
          }
        } else {
          const msg = resolveLocalizedString(ev.val.message);
          parts.push(`error: ${ev.val.kind} · ${msg}`);
          errEv = `${ev.val.kind} · ${msg}`;
        }
      }
      resultEl.textContent = parts.join('') || '(streaming returned 0 events)';
      if (errEv) {
        resultEl.classList.add('err');
        log(`  ✗ ${t.def.name} → ${errEv} (streaming, ${ms} ms)`, 'err');
      } else {
        log(`  → ${t.def.name} streamed ${result.val.length} event${result.val.length === 1 ? '' : 's'} (${ms} ms)`, 'ok');
      }
    }
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const msg = String((err as Error).message || err);
    resultEl.classList.add('err');
    resultEl.textContent = msg;
    log(`  ✗ ${t.def.name} threw: ${msg} (${ms} ms)`, 'err');
  }
}

toolListEl.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.tool-run-empty');
  if (!btn) return;
  const i = Number(btn.dataset['i']);
  await runTool(i, {});
});

toolListEl.addEventListener('submit', async (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>('form.tool-args');
  if (!form) return;
  e.preventDefault();
  const i = Number(form.dataset['i']);
  let args: Record<string, unknown>;
  try {
    args = collectFormValues(form);
  } catch (err) {
    const i2 = Number(form.dataset['i']);
    const resultEl = toolListEl.querySelector<HTMLElement>(`[data-result="${i2}"]`);
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.classList.add('err');
      resultEl.textContent = String((err as Error).message || err);
    }
    return;
  }
  await runTool(i, args);
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
