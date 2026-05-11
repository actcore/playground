import './styles.css';

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
        return (WebAssembly as unknown as Record<string, (b: ArrayBuffer, i?: unknown) => Promise<unknown>>)[nonStreamingName](buf, imports);
      }
    };
  };
  wrap('compileStreaming', 'compile');
  wrap('instantiateStreaming', 'instantiate');
}

import { runComponent, type ToolDefinition, type ToolProvider } from '@actcore/host';
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

interface LoadedTool {
  provider: ToolProvider;
  def: ToolDefinition;
  source: string;
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
