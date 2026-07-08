/**
 * Universal "load a tool by URL" — supports `oci://`, `https://`, plus
 * arbitrary `File` objects for drag-and-drop.
 *
 * All paths converge on `Uint8Array` containing a packed wasm component,
 * which the caller hands to `@actcore/web-runtime`'s `runComponent`.
 */

const OCI_CORS_PROXY = 'https://oci-cors.actcore.dev';

/**
 * Registries the browser can reach directly because they already serve
 * permissive CORS — these bypass the `oci-cors-proxy`. `tokenPath` is the
 * Distribution-Spec token realm (the `WWW-Authenticate: Bearer realm=…` the
 * registry advertises on a 401), relative to the registry origin.
 *
 * Every other host is routed through `OCI_CORS_PROXY`, whose token realm is the
 * Docker-default `/token`.
 */
const DIRECT_REGISTRIES: Record<string, { tokenPath: string }> = {
  // actpkg.dev: zot behind a Django-issued bearer token (anonymous pulls are
  // granted for public components). See actpkg.dev backend `accounts/oci_token`.
  'actpkg.dev': { tokenPath: '/api/v1/token' },
};

interface RegistryEndpoints {
  /** Base for `/v2/...` requests (no trailing slash). */
  base: string;
  /** Absolute URL of the token realm (without query string). */
  tokenEndpoint: string;
}

function registryEndpoints(host: string): RegistryEndpoints {
  const direct = DIRECT_REGISTRIES[host];
  if (direct) {
    const origin = `https://${host}`;
    return { base: origin, tokenEndpoint: `${origin}${direct.tokenPath}` };
  }
  const base = `${OCI_CORS_PROXY}/${host}`;
  return { base, tokenEndpoint: `${base}/token` };
}

export interface LoadProgress {
  (msg: string, level?: 'info' | 'ok' | 'err'): void;
}

export async function loadFromUrl(
  url: string,
  log: LoadProgress = () => {},
): Promise<Uint8Array> {
  url = url.trim();
  if (url.startsWith('oci://')) return loadOci(url, log);
  if (url.startsWith('http://') || url.startsWith('https://')) return loadHttp(url, log);
  throw new Error(`Unsupported URL scheme. Use oci://, https://, or drag a .wasm file.`);
}

export async function loadFromFile(file: File, log: LoadProgress = () => {}): Promise<Uint8Array> {
  log(`reading ${file.name} (${file.size} bytes)…`);
  return new Uint8Array(await file.arrayBuffer());
}

async function loadHttp(url: string, log: LoadProgress): Promise<Uint8Array> {
  log(`fetching ${url}…`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  log(`  fetched ${bytes.length} bytes`, 'ok');
  return bytes;
}

/**
 * Pull a wasm component from an OCI registry.
 *
 * Most registries are reached through the public CORS proxy; registries in
 * `DIRECT_REGISTRIES` (e.g. actpkg.dev) are fetched directly because they serve
 * permissive CORS themselves.
 *
 * Steps (standard OCI Distribution Spec bearer flow):
 *  1. Resolve a pull-scoped Bearer token from the registry's token endpoint.
 *  2. Fetch the manifest at `/v2/<repo>/manifests/<tag>` with that token.
 *  3. Find the `application/wasm` layer (or first layer if only one).
 *  4. Fetch the blob at `/v2/<repo>/blobs/<digest>`.
 *  5. Verify SHA-256 of the blob bytes locally against `<digest>`.
 *
 * Step 5 is the trust anchor — neither a malicious proxy NOR a malicious
 * registry can serve tampered bytes undetected, because the digest comes from
 * the manifest and the bytes are verified against it on the client.
 */
async function loadOci(url: string, log: LoadProgress): Promise<Uint8Array> {
  const ref = parseOciRef(url);
  const { base, tokenEndpoint } = registryEndpoints(ref.host);
  const direct = ref.host in DIRECT_REGISTRIES;
  log(
    `oci pull · registry=${ref.host} repo=${ref.repo} tag=${ref.tag}` +
      (direct ? ' (direct)' : ' (via cors proxy)'),
  );

  // 1. Token.
  const tokenUrl = `${tokenEndpoint}?service=${ref.host}&scope=repository:${ref.repo}:pull`;
  log(`  → token…`);
  const tokenResp = await fetch(tokenUrl);
  if (!tokenResp.ok) throw new Error(`token: HTTP ${tokenResp.status}`);
  const tokenJson = (await tokenResp.json()) as { token?: string; access_token?: string };
  const token = tokenJson.token ?? tokenJson.access_token;
  if (!token) throw new Error('token endpoint returned no token');

  // 2. Manifest.
  log(`  → manifest…`);
  const manifestUrl = `${base}/v2/${ref.repo}/manifests/${ref.tag}`;
  const manifestResp = await fetch(manifestUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:
        'application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json',
    },
  });
  if (!manifestResp.ok) throw new Error(`manifest: HTTP ${manifestResp.status}`);
  const manifest = (await manifestResp.json()) as OciManifest;

  // 3. Find wasm layer.
  if (!manifest.layers || manifest.layers.length === 0) {
    throw new Error('manifest has no layers');
  }
  const wasmLayer =
    manifest.layers.find((l) => l.mediaType === 'application/wasm') ??
    manifest.layers[0]!;
  log(`  layer: ${wasmLayer.mediaType} · ${wasmLayer.size} bytes · ${wasmLayer.digest}`);

  // 4. Blob.
  log(`  → blob…`);
  const blobUrl = `${base}/v2/${ref.repo}/blobs/${wasmLayer.digest}`;
  const blobResp = await fetch(blobUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!blobResp.ok) throw new Error(`blob: HTTP ${blobResp.status}`);
  const bytes = new Uint8Array(await blobResp.arrayBuffer());

  // 5. Verify digest.
  log(`  verifying SHA-256…`);
  const expected = wasmLayer.digest.replace(/^sha256:/, '').toLowerCase();
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`digest mismatch — expected sha256:${expected}, got sha256:${actual}`);
  }
  log(`  ✓ digest verified (${bytes.length} bytes)`, 'ok');

  return bytes;
}

interface OciManifest {
  schemaVersion: number;
  mediaType?: string;
  layers: Array<{ mediaType: string; digest: string; size: number }>;
}

interface OciRef {
  host: string;
  repo: string;
  tag: string;
}

function parseOciRef(url: string): OciRef {
  // oci://<host>/<repo-path...>:<tag>
  const m = /^oci:\/\/([^/]+)\/(.+?):([^:/]+)$/.exec(url);
  if (!m) {
    throw new Error(
      `Bad oci:// URL. Expected oci://<host>/<repo>:<tag>, got: ${url}`,
    );
  }
  return { host: m[1]!, repo: m[2]!, tag: m[3]! };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
