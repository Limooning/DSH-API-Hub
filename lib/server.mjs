// API Hub — local panel to manage and call API providers.
// No dependencies. Binds 127.0.0.1 only.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, renameSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
/** DSH resolves its own roots from an explicit config, then $DSH_HOME /
 *  $DSH_AGENTS_HOME, then ~/.dsh and ~/.agents. Reading the two environment
 *  overrides matters: a user who moved their data would otherwise see an empty
 *  list here while DSH happily loads the same skills from the other directory. */
const homeRoot = (env, dirName) => {
  const configured = String(process.env[env] ?? '').trim();
  return configured ? resolve(expandHome(configured)) : join(homedir(), dirName);
};
const DSH_HOME = homeRoot('DSH_HOME', '.dsh');
const AGENTS_HOME = homeRoot('DSH_AGENTS_HOME', '.agents');
const SKILLS_DIR = join(DSH_HOME, 'skills');
const SKILLS_OFF = join(SKILLS_DIR, '.disabled');

// User data lives in <DSH_HOME>/api-hub, not inside the installed package, so a
// linked working copy and a package installed from a tarball read the same files.
// It sits under the same root DSH uses, which is `~/.dsh` unless the user moved it.
const DATA_DIR = join(DSH_HOME, 'api-hub');
const REGISTRY_PATH = join(DATA_DIR, 'providers.json');
// Shipped with the package (lib/ -> package root) and copied on first run.
const EXAMPLE_PATH = join(HERE, '..', 'providers.example.json');
const DSH_CREDENTIALS = join(DSH_HOME, '.credentials.yaml');

const mask = (key) => (!key ? '' : key.length <= 8 ? '****' : key.slice(0, 5) + '…' + key.slice(-4));

/** Seed providers.json from the bundled example the first time the hub runs. */
function ensureRegistry() {
  if (existsSync(REGISTRY_PATH)) return;
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(EXAMPLE_PATH)) {
    writeFileSync(REGISTRY_PATH, readFileSync(EXAMPLE_PATH, 'utf8'), 'utf8');
    return;
  }
  const empty = { version: 1, defaults: { llm: null, image: null }, providers: [] };
  writeFileSync(REGISTRY_PATH, JSON.stringify(empty, null, 2) + '\n', 'utf8');
}

const loadRegistry = () => {
  ensureRegistry();
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
};
const saveRegistry = (reg) => writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf8');

// ---------- credential readers / writers ----------

function readDshRef(ref) {
  if (!existsSync(DSH_CREDENTIALS)) return '';
  const lines = readFileSync(DSH_CREDENTIALS, 'utf8').split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) return '';
    if (inRefs) {
      const m = line.match(/^\s+([A-Za-z0-9_.\-/]+):\s*(.*)$/);
      if (m && m[1] === ref) return m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

function writeDshRef(ref, value) {
  const text = existsSync(DSH_CREDENTIALS) ? readFileSync(DSH_CREDENTIALS, 'utf8') : 'version: 1\nrecords:\n';
  const lines = text.split(/\r?\n/);
  let refsStart = -1, refsEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^refs:\s*$/.test(lines[i])) {
      refsStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\S/.test(lines[j]) && lines[j].trim() !== '') { refsEnd = j; break; }
      }
      if (refsEnd === -1) refsEnd = lines.length;
      break;
    }
  }
  const entry = `  ${ref}: ${value}`;
  if (refsStart === -1) {
    const idx = lines.findIndex((l) => /^version:/.test(l));
    lines.splice(idx === -1 ? 0 : idx + 1, 0, 'refs:', entry);
  } else {
    let replaced = false;
    for (let i = refsStart + 1; i < refsEnd; i++) {
      const m = lines[i].match(/^(\s+)([A-Za-z0-9_.\-/]+):/);
      if (m && m[2] === ref) { lines[i] = entry; replaced = true; break; }
    }
    if (!replaced) lines.splice(refsEnd, 0, entry);
  }
  writeFileSync(DSH_CREDENTIALS, lines.join('\n'), 'utf8');
}

// ---------- the DSH credential service, when it is there ----------
//
// Reads stay on the file: DSH's own credential service watches that same file,
// so both sides see the same bytes, and a sync read keeps every route simple.
// Writes are the half that cannot be done by hand — two writers racing on one
// YAML can corrupt it, and a hand-written file never announces itself, so DSH
// keeps serving the old key until the watcher happens to notice. Going through
// `ctx.credentials` inherits the store's file lock, its atomic write and its
// `credentials/reference-updated` event, which is what makes an edited key take
// effect without a restart.
//
// The host half attaches the service after importing this module, and reattaches
// it whenever this file is re-imported on an edit, so the writer is swapped and
// never cached across revisions.
let credentialWriter = null;

/** Called by the host half. `null` detaches and falls back to the plain file write. */
export function useCredentialService(service) {
  credentialWriter = service && typeof service.set === 'function' ? service : null;
  return Boolean(credentialWriter);
}

export const hasCredentialService = () => Boolean(credentialWriter);

async function storeDshRef(ref, value) {
  if (credentialWriter) {
    // An empty value means "remove this reference", which the service spells
    // `unset`; `set` refuses empty strings on purpose.
    if (value) await credentialWriter.set(ref, value);
    else if (typeof credentialWriter.unset === 'function') await credentialWriter.unset(ref);
    return;
  }
  writeDshRef(ref, value);
}

// ---- DSH model routes ------------------------------------------------------
// DSH ships `@deepseek-ai/dsh-llm-pi-ai`, a multi-provider adapter that stays
// dormant until its settings section names a provider. The panel can fill that
// section in: each hub endpoint becomes one route there, so the models show up in
// DSH's own picker and a conversation can actually call them. Writes go through
// the settings service when the host half found one, because that service owns
// the profile patch and its reload.

const PI_AI_NAMESPACE = 'llm-pi-ai';

let settingsBridge = null;

/** Called by the host half. `null` detaches and leaves the routes unmanaged. */
export function useSettingsService(service) {
  settingsBridge = service && typeof service.update === 'function' ? service : null;
  return Boolean(settingsBridge);
}

export const hasSettingsService = () => Boolean(settingsBridge);

/**
 * Which routes the panel wrote. DSH's model list is shared ground: a route the
 * user registered by hand must survive a sync, but a provider that was disabled
 * or removed in the hub has to disappear from it. Remembering our own ids is the
 * only way to tell those two cases apart, because the settings section does not
 * carry an owner.
 */
const DSH_OWNED_PATH = join(DATA_DIR, 'dsh-routes.json');

function loadDshOwned() {
  try {
    const raw = JSON.parse(readFileSync(DSH_OWNED_PATH, 'utf8'));
    return Array.isArray(raw?.ids) ? raw.ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveDshOwned(ids) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DSH_OWNED_PATH, JSON.stringify({ ids }, null, 2) + '\n', 'utf8');
  } catch { /* the next sync writes it again */ }
}

const sameRoute = (left, right) => routeSignature(left) === routeSignature(right);

/**
 * What a route means, ignoring everything DSH fills in from its schema defaults
 * (context window, overrides, rendered model names…). Comparing the raw objects
 * would report drift forever and rewrite the section on every page load.
 */
function routeSignature(profile) {
  return JSON.stringify({
    displayName: profile?.displayName ?? '',
    api: profile?.api ?? '',
    baseURL: profile?.baseURL ?? '',
    apiKeyEnv: profile?.apiKeyEnv ?? '',
    models: (Array.isArray(profile?.models) ? profile.models : []).map((model) => model?.id ?? ''),
  });
}

/**
 * Does DSH's model list already say what the panel says? `null` means the
 * question cannot be answered here (no settings service, unreadable section) and
 * the caller should stay quiet instead of rewriting anything.
 */
async function dshDrift(providers) {
  if (!settingsBridge || typeof settingsBridge.read !== 'function') return null;
  let existing;
  try {
    const current = await settingsBridge.read();
    existing = current?.providers && typeof current.providers === 'object' ? current.providers : {};
  } catch {
    return null;
  }
  const owned = loadDshOwned();
  const stale = owned.filter((id) => !(id in providers));
  let drift = stale.length > 0;
  for (const [id, profile] of Object.entries(providers)) {
    if (!(id in existing) || !sameRoute(existing[id], profile)) {
      drift = true;
      break;
    }
  }
  return { drift, stale, owned: owned.length };
}

/**
 * The credential reference a route authenticates with. A provider whose key
 * already lives in the credential store keeps that ref; anything else gets a
 * stable synthetic one, built from the id and — for ids written entirely in
 * Chinese — from the host, so two relays never collide on one name.
 */
function routeRefName(provider) {
  if (provider.keySource?.type === 'dsh-credentials' && provider.keySource.ref) {
    return provider.keySource.ref;
  }
  const slugOf = (text) => String(text ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  let slug = slugOf(provider.id);
  if (!/\w/.test(slug)) {
    try { slug = slugOf(new URL(provider.baseURL).host); } catch { slug = ''; }
  }
  return 'APIHUB_' + (slug || 'PROVIDER') + '_API_KEY';
}

/**
 * Models a route advertises: exactly what the user ticked in the panel. The
 * probe cache is only a fallback for a provider that was never narrowed down —
 * handing DSH the whole `/models` answer would bury the one model that was
 * actually chosen. A chat picker also cannot use images, speech or embeddings,
 * so those are dropped even when a ticked id looks like one.
 */
function routeModels(provider) {
  const nameOf = (entry) => {
    if (entry && typeof entry === 'object') return String(entry.id ?? entry.model ?? entry.name ?? '').trim();
    return String(entry ?? '').trim();
  };
  const picked = (provider.selectedModels ?? []).map(nameOf).filter(Boolean);
  const fallback = picked.length
    ? []
    : (provider.modelsCache?.list ?? []).map(nameOf).filter(Boolean);
  const all = picked.length
    ? picked
    : fallback.length
      ? fallback
      : [provider.defaultModel].filter(Boolean).map(nameOf);
  const chat = all.filter((id) => modelTypes(id).includes('llm'));
  return [...new Set(chat.length ? chat : all)].map((id) => ({ id }));
}

/**
 * The provider profiles the hub would hand DSH. Pure: no writes, no reads beyond
 * the key lookup the caller already has. Chat endpoints only — an image endpoint
 * has no place in a chat model picker.
 */
function planDshRoutes(reg) {
  const providers = {};
  const skipped = [];
  for (const p of reg.providers) {
    const kinds = p.kinds ?? (p.kind ? [p.kind] : ['llm']);
    if (!p.enabled) { skipped.push({ id: p.id, name: p.name, why: '已停用' }); continue; }
    if (!kinds.includes('llm')) { skipped.push({ id: p.id, name: p.name, why: '不是对话接口' }); continue; }
    const models = routeModels(p);
    if (!models.length) { skipped.push({ id: p.id, name: p.name, why: '没有模型列表，先在面板里点一次「模型」' }); continue; }
    if (!p.baseURL) { skipped.push({ id: p.id, name: p.name, why: '没有 Base URL' }); continue; }
    providers[p.id] = {
      displayName: p.name || p.id,
      baseURL: p.baseURL,
      api: 'openai-completions',
      apiKeyEnv: routeRefName(p),
      models,
    };
  }
  return { providers, skipped };
}

/** Key values each planned route still needs stored as a credential reference. */
function dshRefWrites(reg) {
  const writes = [];
  for (const p of reg.providers) {
    if (!p.enabled) continue;
    const kinds = p.kinds ?? (p.kind ? [p.kind] : ['llm']);
    if (!kinds.includes('llm')) continue;
    if (p.keySource?.type === 'dsh-credentials') continue;
    const ref = routeRefName(p);
    let value = '';
    try { value = readKey(p) || ''; } catch { value = ''; }
    if (value) writes.push({ ref, value, provider: p.id });
  }
  return writes;
}

function jsonGet(obj, path) {
  let cur = obj;
  for (const seg of path) { if (cur == null) return ''; cur = cur[seg]; }
  return typeof cur === 'string' ? cur : '';
}

/** Field names a config file actually has, so a wrong 字段路径 can say what to use. */
function fieldNames(node, path = [], out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 2 || out.length >= 10) return out;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) fieldNames(v, [...path, k], out, depth + 1);
    else if (typeof v === 'string') out.push([...path, k].join('.'));
    if (out.length >= 10) break;
  }
  return out;
}

/** The endpoint a config file already carries, if any. */
function findBaseURL(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 3) return '';
  for (const [k, v] of Object.entries(node)) {
    if (URL_FIELD.test(k) && typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
    if (v && typeof v === 'object') {
      const nested = findBaseURL(v, depth + 1);
      if (nested) return nested;
    }
  }
  return '';
}

function jsonSet(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (cur[seg] == null) cur[seg] = typeof path[i + 1] === 'number' ? [] : {};
    cur = cur[seg];
  }
  cur[path[path.length - 1]] = value;
  return obj;
}

function readKey(provider) {
  const src = provider.keySource;
  try {
    if (src.type === 'dsh-credentials') return readDshRef(src.ref);
    // `env` keeps the secret out of any file: the key already lives in the
    // process environment of whoever started DSH.
    if (src.type === 'env') return process.env[src.name] || '';
    if (src.type === 'json') {
      const file = expandHome(src.path);
      if (!existsSync(file)) return '';
      // The same reader the importer used, so a JSON / TOML / .env source keeps
      // working after it has been imported.
      const doc = parseConfigFile(file);
      return doc ? jsonGet(doc, src.jsonPath) : '';
    }
  } catch { return ''; }
  return '';
}

/**
 * Not every relay reads `Authorization: Bearer`. A few take the key in
 * `x-api-key` (or `api-key` for Azure-style deployments); the import check
 * records which one answered so later calls use the same header.
 */
function authHeaders(provider, key) {
  const style = provider?.auth;
  if (style === 'x-api-key') return { 'x-api-key': key };
  if (style === 'api-key') return { 'api-key': key };
  return { Authorization: `Bearer ${key}` };
}

/**
 * 16x16 solid red PNG. Small enough to be free (a handful of tokens), large
 * enough that vendors which enforce a minimum image size accept it — a 1x1
 * image is rejected with "must be larger than 10", which would look like the
 * model has no eyes when it simply has a size policy.
 */
const VISION_PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4IyJCEmIY1TCqYfhqAAACcQQQFwFJQgAAAABJRU5ErkJggg==';

/**
 * Ask a model one question that only eyes can answer. A name cannot be
 * trusted (a family may ship both variants), so the panel tries the real API
 * and keeps the verdict in `provider.vision`.
 */
async function probeVision(provider, model, timeoutMs = 20000) {
  const key = readKey(provider);
  if (!key) return { ok: false, note: '未配置 Key' };
  const id = String(model || provider.defaultModel || '').trim();
  if (!id) return { ok: false, note: '没有可测试的模型' };
  const target = provider.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const payload = {
    model: id,
    max_tokens: 12,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么颜色？只回颜色两个字' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + VISION_PROBE_PNG } },
      ],
    }],
  };
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: { ...authHeaders(provider, key), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await r.text();
    const ms = Date.now() - started;
    if (!r.ok) {
      let note = text.slice(0, 160);
      try { note = JSON.parse(text)?.error?.message ?? note; } catch { /* keep the raw text */ }
      return { ok: false, status: r.status, ms, model: id, note: String(note) };
    }
    let answer = '';
    try { answer = JSON.parse(text)?.choices?.[0]?.message?.content ?? ''; } catch { /* not JSON */ }
    return { ok: true, status: r.status, ms, model: id, note: String(answer).slice(0, 40) || '接受了图片输入' };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, model: id, note: e.name === 'AbortError' ? '超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}


async function writeKey(provider, value) {
  const src = provider.keySource;
  if (src.type === 'dsh-credentials') return storeDshRef(src.ref, value);
  if (src.type === 'env') throw new Error('这个接口的 Key 来自环境变量，请在启动 DSH 的环境里修改');
  if (src.type === 'json') {
    const file = expandHome(src.path);
    // TOML / .env files are read-only here on purpose: rewriting them with a
    // JSON writer would destroy comments and formatting the owning tool needs.
    if (/\.toml$/i.test(file) || /\.env$/i.test(basename(file)) || /^\.env(\..+)?$/i.test(basename(file))) {
      throw new Error('这个 Key 存在 ' + basename(file) + ' 里，请直接改那个文件；本面板只读不写');
    }
    mkdirSync(dirname(file), { recursive: true });
    let doc = {}, pretty = false;
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      pretty = raw.includes('\n');
      try { doc = JSON.parse(raw); } catch { doc = {}; }
    }
    jsonSet(doc, src.jsonPath, value);
    writeFileSync(file, pretty ? JSON.stringify(doc, null, 2) + '\n' : JSON.stringify(doc), 'utf8');
    return;
  }
  throw new Error('unknown key source');
}

// ---------- skills ----------

const isSafeName = (id) => typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..' && !/[\\/]/.test(id);

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2];
    if (v === '|' || v === '>' || v === '|-' || v === '>-') {
      const buf = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) buf.push(lines[++i].trim());
      v = buf.join(' ');
    }
    out[kv[1]] = String(v).replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function skillStats(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        try { bytes += statSync(p).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** DSH only lists a skill when its SKILL.md carries frontmatter with both a
 *  name and a description, so a directory without them is not offered. */
function readSkillFrontmatter(file) {
  try { return parseFrontmatter(readFileSync(file, 'utf8')); } catch { return {}; }
}
const isDshSkill = (fm) => Boolean(fm && fm.name && fm.description);

/** Renaming a skill rewrites only the `name:` line: the description, the rest of
 *  the frontmatter and the body stay byte-for-byte as they were. */
function setSkillName(file, name) {
  const text = readFileSync(file, 'utf8');
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/.exec(text);
  if (!m) throw new Error('SKILL.md 缺少 frontmatter，无法改名');
  const plain = /^[\p{L}\p{N}][\p{L}\p{N} ._+\-/()（）·]*$/u.test(name);
  const line = 'name: ' + (plain ? name : JSON.stringify(name));
  // Follow the file's own line endings: a skill written on Windows must not end
  // up with a half-CRLF frontmatter just because it was renamed.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let done = false;
  const lines = m[2].split(/\r?\n/).map((old) => {
    if (!done && /^\s*name\s*:/.test(old)) { done = true; return line; }
    return old;
  });
  if (!done) lines.unshift(line);
  writeFileSync(file, ['---', ...lines, '---'].join(eol) + eol + text.slice(m[0].length), 'utf8');
}

/** DSH only lists a skill when its name matches this pattern and its SKILL.md
 *  carries both a name and a description; anything else is dropped silently, so
 *  the panel says so instead of pretending the skill is loadable. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Workspace folders DSH has opened, from its own storage. Project-level skills
 *  only exist for these, and a workspace that was deleted must not keep its
 *  ghost skills in the list. */
function workspacePaths() {
  const out = [];
  try {
    const doc = JSON.parse(readFileSync(join(DSH_HOME, 'storages', 'workspace.json'), 'utf8'));
    for (const ws of Object.values(doc?.tables?.workspaces ?? {})) {
      if (ws && typeof ws.path === 'string' && ws.path && existsSync(ws.path)) out.push(resolve(ws.path));
    }
  } catch { /* nothing opened yet */ }
  return [...new Set(out)];
}

/** Every root DSH walks, in its own precedence order (project .dsh 100,
 *  project .agents 200, then the user's ~/.dsh 400 and ~/.agents 500). Only the
 *  managed root is a place the panel is allowed to move files in. */
function skillRoots() {
  const roots = [];
  for (const ws of workspacePaths()) {
    roots.push({ path: join(ws, '.dsh', 'skills'), scope: 'project', rank: 100, managed: false });
    roots.push({ path: join(ws, '.agents', 'skills'), scope: 'project', rank: 200, managed: false });
  }
  roots.push({ path: SKILLS_DIR, scope: 'global', rank: 400, managed: true });
  roots.push({ path: join(AGENTS_HOME, 'skills'), scope: 'agents', rank: 500, managed: false });
  const seen = new Set();
  return roots.filter((root) => {
    const key = resolve(root.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.rank - b.rank);
}

/** One root, in the two shapes DSH accepts: `<name>/SKILL.md` or a bare
 *  `<name>.md`. */
function skillsFrom(root, enabled) {
  const base = root.path;
  if (!existsSync(base)) return [];
  const out = [];
  const push = (id, file, path, fm, stats, files, bytes) => out.push({
    id,
    name: fm.name || id,
    description: String(fm.description ?? '').slice(0, 260),
    dshFormat: isDshSkill(fm),
    dshValidName: SKILL_NAME.test(String(fm.name ?? '')),
    enabled,
    managed: Boolean(root.managed),
    scope: root.scope,
    root: root.path,
    files,
    bytes,
    path,
    file,
    modified: stats.mtime.toISOString(),
  });
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(base, e.name);
    if (e.isDirectory()) {
      const file = join(full, 'SKILL.md');
      if (!existsSync(file)) continue;
      const { files, bytes } = skillStats(full);
      push(e.name, file, full, readSkillFrontmatter(file), statSync(file), files, bytes);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const stats = statSync(full);
      push(e.name.replace(/\.md$/i, ''), full, full, readSkillFrontmatter(full), stats, 1, stats.size);
    }
  }
  return out;
}

// Tags are the panel's own filing system: they live beside the registry instead
// of inside the skill folder, so updating or re-importing a skill never erases
// them, and a skill installed by another tool can be tagged without being moved.
const SKILL_TAGS_PATH = join(homedir(), '.dsh', 'api-hub', 'skill-tags.json');

function loadSkillTags() {
  try {
    const doc = JSON.parse(readFileSync(SKILL_TAGS_PATH, 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

function saveSkillTags(doc) {
  mkdirSync(dirname(SKILL_TAGS_PATH), { recursive: true });
  writeFileSync(SKILL_TAGS_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

const cleanTags = (list) => [...new Set((Array.isArray(list) ? list : [])
  .map((tag) => String(tag ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 16))
  .filter(Boolean))].slice(0, 12);

// Hand-picked skill order, same idea as the tag file: it belongs to the panel,
// not to the skill folders, so enabling, renaming or re-importing a skill never
// shuffles the list back into alphabetical order.
const SKILL_ORDER_PATH = join(homedir(), '.dsh', 'api-hub', 'skill-order.json');

function loadSkillOrder() {
  try {
    const doc = JSON.parse(readFileSync(SKILL_ORDER_PATH, 'utf8'));
    const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.order) ? doc.order : [];
    return list.filter((id) => typeof id === 'string' && id);
  } catch {
    return [];
  }
}

function saveSkillOrder(ids) {
  mkdirSync(dirname(SKILL_ORDER_PATH), { recursive: true });
  writeFileSync(SKILL_ORDER_PATH, JSON.stringify({ order: ids.filter((id) => typeof id === 'string' && id) }, null, 2) + '\n', 'utf8');
}

const listSkills = () => {
  const saved = loadSkillTags();
  const order = loadSkillOrder();
  const rank = new Map(order.map((id, index) => [id, index]));
  const byName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
  const roots = skillRoots();
  const seen = new Set();
  const all = [];
  // Same rule DSH applies: the first root that offers an id wins, and the
  // panel's own disabled copy never hides a skill DSH can still load.
  for (const root of roots) {
    for (const skill of skillsFrom(root, true)) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      all.push(skill);
    }
  }
  for (const skill of skillsFrom({ path: SKILLS_OFF, scope: 'global', managed: true }, false)) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    all.push(skill);
  }
  return all
    .map((skill) => ({ ...skill, tags: cleanTags(saved[skill.id]) }))
    // Known skills keep the dragged order; anything new falls in after them, so
    // a fresh import never disappears at the bottom of the list.
    .sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ra === rb ? byName(a, b) : ra - rb;
    });
};

const skillById = (id) => listSkills().find((skill) => skill.id === id);

const allSkillTags = () => {
  const set = new Set();
  for (const list of Object.values(loadSkillTags())) for (const tag of cleanTags(list)) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
};

// Extra scan locations the user adds from the panel. Kept in the data dir so a
// packaged install and a linked working copy share them.
const SOURCES_PATH = join(homedir(), '.dsh', 'api-hub', 'scan-sources.json');

function loadSources() {
  try {
    const doc = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
    return {
      files: Array.isArray(doc.files) ? doc.files : [],
      skillDirs: Array.isArray(doc.skillDirs) ? doc.skillDirs : [],
    };
  } catch {
    return { files: [], skillDirs: [] };
  }
}

function saveSources(doc) {
  mkdirSync(dirname(SOURCES_PATH), { recursive: true });
  writeFileSync(SOURCES_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

/**
 * Skill folders scanned besides DSH's own `~/.dsh/skills` — which this panel
 * already manages, so the automatic pass has nothing left to look at there.
 * Every other folder is opt-in: a skill that declares `name` and `description`
 * is importable no matter which tool created it, and anything without that
 * frontmatter is counted and skipped instead of being offered.
 */
function otherSkillRoots() {
  const roots = loadSources().skillDirs.map((dir) => ({ source: 'custom', dir }));
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    let real = root.dir;
    try { real = resolve(root.dir).toLowerCase(); } catch { /* keep as-is */ }
    if (seen.has(real)) continue;
    let ok = false;
    try { ok = existsSync(root.dir); } catch { ok = false; }
    if (!ok) continue;
    seen.add(real);
    out.push(root);
  }
  return out;
}

// ---------- discovery ----------

// Well-known endpoints, so a discovered key can become a provider in one click.
// Anything not listed here still shows up, it just needs a Base URL typed in.
const PRESETS = [
  { test: /^DEEPSEEK_API_KEY$/i, name: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com', protocol: 'OpenAI Responses' },
  { test: /^OPENAI_API_KEY$/i, name: 'OpenAI', baseURL: 'https://api.openai.com/v1', protocol: 'OpenAI Chat Completions' },
  { test: /^DASHSCOPE_API_KEY$/i, name: '阿里云百炼', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'OpenAI Chat Completions' },
  { test: /^MOONSHOT_API_KEY$/i, name: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1', protocol: 'OpenAI Chat Completions' },
  { test: /^SILICONFLOW_API_KEY$/i, name: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', protocol: 'OpenAI Chat Completions' },
  { test: /^OPENROUTER_API_KEY$/i, name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', protocol: 'OpenAI Chat Completions' },
  { test: /^GROQ_API_KEY$/i, name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', protocol: 'OpenAI Chat Completions' },
  { test: /^(GEMINI|GOOGLE)_API_KEY$/i, name: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'OpenAI Chat Completions' },
];
const presetFor = (name) => PRESETS.find((entry) => entry.test.test(name)) ?? null;

/** Only credentials that look like API keys; session tokens stay hidden. */
const API_REF = /(_API_KEY|_KEY)$/i;

function listDshRefs() {
  if (!existsSync(DSH_CREDENTIALS)) return [];
  const out = [];
  let inRefs = false;
  for (const line of readFileSync(DSH_CREDENTIALS, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) break;
    if (!inRefs) continue;
    const m = line.match(/^\s+([A-Za-z0-9_.\-/]+):\s*(.*)$/);
    if (m) out.push({ ref: m[1], value: m[2].trim().replace(/^["']|["']$/g, '') });
  }
  return out;
}

function discover() {
  const reg = loadRegistry();
  // Everything the panel already manages is left out: the dialog answers one
  // question only — what is on this machine but missing from the panel.
  const usedRefs = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'dsh-credentials').map((p) => p.keySource.ref));
  const usedEnv = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'env').map((p) => p.keySource.name));
  const usedPaths = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'json').map((p) => expandHome(p.keySource.path)));

  const credentials = listDshRefs()
    .filter((entry) => API_REF.test(entry.ref) && entry.value && !usedRefs.has(entry.ref))
    .map((entry) => ({
      ref: entry.ref,
      masked: mask(entry.value),
      preset: presetFor(entry.ref),
    }));

  const envKeys = Object.keys(process.env)
    .filter((name) => API_REF.test(name) && (process.env[name] || '').length >= 8 && !usedEnv.has(name))
    .map((name) => ({
      name,
      masked: mask(process.env[name]),
      preset: presetFor(name),
    }));

  const managedSkills = new Set(listSkills().map((skill) => skill.id));
  const skills = [];
  let skillsSkipped = 0;
  for (const root of otherSkillRoots()) {
    for (const skill of skillsFrom({ path: root.dir, scope: 'foreign', managed: false }, true)) {
      if (managedSkills.has(skill.id)) continue;
      // A directory without DSH frontmatter would not load in DSH, so it is
      // counted and reported instead of being offered as an import.
      if (!skill.dshFormat) { skillsSkipped++; continue; }
      skills.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        source: root.source,
        files: skill.files,
        bytes: skill.bytes,
      });
    }
  }

  return {
    credentials,
    envKeys,
    files: discoverCustomFiles(reg).filter((entry) => !entry.used),
    auto: scanJsonCredentials(reg),
    skills,
    skillsSkipped,
    sources: loadSources(),
    scopes: {
      auto: scanRoots().map((dir) => dir.replace(homedir(), "~")),
      skills: otherSkillRoots().map((root) => root.dir.replace(homedir(), "~")),
      skillRoots: otherSkillRoots().map((root) => ({ source: root.source, path: root.dir.replace(homedir(), "~") })),
      // What the panel itself reads, spelled out so the settings copy can name the
      // real paths instead of repeating `~/.dsh` and drifting from the code.
      dshHome: DSH_HOME.replace(homedir(), "~"),
      agentsHome: AGENTS_HOME.replace(homedir(), "~"),
      credentials: DSH_CREDENTIALS.replace(homedir(), "~"),
      managedSkills: SKILLS_DIR.replace(homedir(), "~"),
      credentialService: hasCredentialService(),
      sep,
      skillDirs: loadSources().skillDirs.map((dir) => dir.replace(homedir(), "~")),
    },
    scannedAt: new Date().toISOString(),
  };
}

// No vendor-specific config file is hardcoded here. Anything under the default
// scan roots is found by the generic scan; anything elsewhere is supplied by the
// user through 「添加扫描位置」 and stays in scan-sources.json.

/** Candidates from locations the user added by hand. */
function discoverCustomFiles(reg) {
  const used = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'json')
    .map((p) => expandHome(p.keySource.path)));

  const out = [];
  for (const entry of loadSources().files) {
    const file = expandHome(entry.path);
    if (!file || !existsSync(file)) continue;
    let value = '';
    try {
      value = jsonGet(JSON.parse(readFileSync(file, 'utf8')), entry.jsonPath);
    } catch { continue; }
    if (!value) continue;
    out.push({
      path: file.replace(homedir(), '~'),
      absolutePath: file,
      jsonPath: entry.jsonPath,
      masked: mask(value),
      preset: entry.preset,
      custom: true,
      used: used.has(file),
    });
  }
  return out;
}

// ---------- generic machine scan ----------
// No vendor-specific config file is hardcoded here: walk common config roots,
// parse small JSON files, and report any string that looks like an API key
// together with a nearby base URL. Other coding agents' own folders are skipped —
// what is offered has to be an endpoint DSH itself can call.

// A key field can be bare (`apiKey`, `token`) or carry a service prefix, which
// is how `.env` style files and Codex's `auth.json` name theirs
// (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`).
const KEY_FIELD = /^(?:[A-Za-z0-9.\-]+[_-])?(api[-_]?key|apikey|access[-_]?key|access[-_]?token|secret[-_]?key|auth[-_]?token|auth[-_]?key|bearer|authorization|token)$/i;
const URL_FIELD = /^(base[-_]?url|base_?uri|api[-_]?base|apiurl|endpoint|host|url)$/i;
// Skip vendored trees, caches and this hub's own key store. Other agents'
// folders are scanned on purpose: a key that really works is worth importing
// no matter which tool wrote it down, and the live call decides that.
const SCAN_SKIP = /[\\/](node_modules|\.git|dist|build|out|coverage|logs?|caches?|Cache|GPUCache|attachments|sessions|blobs|objects|tmp|temp|keys)[\\/]/i;
const SCAN_FILE = /\.(json|toml|env)$|^\.env(\..+)?$/i;
const MAX_SCAN_BYTES = 256 * 1024;
const MAX_SCAN_HITS = 32;

function scanRoots() {
  // Automatic scanning stays inside DSH's own data dir. That is the part a user
  // cannot be expected to check by hand — the credential store, the skill folder
  // and whatever configs DSH itself drops there. Everything else (other tools'
  // configs, D 盘上的中转站) is opted in through 「添加扫描位置」.
  const roots = [DSH_HOME];
  return roots.filter((dir) => { try { return existsSync(dir); } catch { return false; } });
}

/** Does this string plausibly hold a secret rather than a sentence or a path? */
function looksLikeKey(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 16 || v.length > 512) return false;
  if (/\s/.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return false;
  if (/^(your|example|placeholder|xxx|test|changeme|todo)/i.test(v)) return false;
  return /^[A-Za-z0-9._\-+/=:]+$/.test(v);
}

/**
 * Walk a parsed JSON document and report key-bearing fields. The nearest
 * sibling URL in the same object becomes the suggested base URL.
 */
function collectKeyHits(node, file, path, hits, depth = 0, inheritedURL = '') {
  if (!node || typeof node !== 'object' || depth > 6 || hits.length >= MAX_SCAN_HITS) return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectKeyHits(item, file, [...path, i], hits, depth + 1, inheritedURL));
    return;
  }
  const entries = Object.entries(node);
  const urlEntry = entries.find(([k, v]) => URL_FIELD.test(k) && typeof v === 'string' && /^https?:\/\//i.test(v));
  // A URL on an ancestor still describes this endpoint — `{ endpoint, auth: { apiKey } }`
  // is a very common shape.
  const nearestURL = urlEntry ? urlEntry[1] : inheritedURL;
  for (const [k, v] of entries) {
    if (KEY_FIELD.test(k) && looksLikeKey(v)) {
      // A bare token/auth field is too generic to be an API credential unless
      // an endpoint is known; apiKey-style names stand alone.
      const generic = /^(token|authorization|bearer|auth[-_]?token|access[-_]?token|secret[-_]?key|auth[-_]?key)$/i.test(k);
      if (!generic || nearestURL) {
        hits.push({
          path: file,
          jsonPath: [...path, k],
          baseURL: nearestURL,
          masked: mask(v.trim()),
          // Same secret written in five files is still one API. The hash lets the
          // scan collapse duplicates without ever keeping the value around.
          fingerprint: createHash('sha1').update(v.trim()).digest('hex').slice(0, 12),
          auto: true,
        });
      }
    } else if (v && typeof v === 'object') {
      collectKeyHits(v, file, [...path, k], hits, depth + 1, nearestURL);
    }
  }
}

/** Guess a provider preset from the file path, for configs that store no URL. */
const PATH_PRESETS = [
  [/bailian|dashscope|aliyun/i, { name: '阿里云百炼', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }],
  [/deepseek/i, { name: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com' }],
  [/moonshot|kimi/i, { name: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1' }],
  [/siliconflow|silicon/i, { name: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1' }],
  [/openrouter/i, { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' }],
  [/groq/i, { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1' }],
  [/gemini|google/i, { name: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' }],
  [/openai/i, { name: 'OpenAI', baseURL: 'https://api.openai.com/v1' }],
  [/jws|aijws/i, { name: 'JWS 生图', baseURL: 'https://image.aijws.com/v1' }],
  [/88api/i, { name: '88API 生图', baseURL: 'https://88api.ai/v1' }],
];

function presetFromPath(file) {
  for (const [re, preset] of PATH_PRESETS) if (re.test(file)) return preset;
  return null;
}

/** `OPENAI_API_KEY=sk-…` lines, with optional `export` and quotes. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    if (value) out[m[1]] = value;
  }
  return out;
}

/** Strips a TOML comment without touching a `#` inside a quoted value. */
function stripTomlComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote && line[i - 1] !== '\\') quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/**
 * Small TOML subset: `[table.sub]` headings and `key = "value"` scalars, which
 * is what `config.toml` files from Codex-style tools actually use. Arrays and
 * inline tables are ignored rather than guessed at.
 */
function parseToml(text) {
  const root = {};
  let cursor = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      cursor = root;
      for (const part of table[1].split('.')) {
        const key = part.trim().replace(/^["']|["']$/g, '');
        if (!key) continue;
        if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
        cursor = cursor[key];
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.\-"']+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].replace(/^["']|["']$/g, '');
    let value = kv[2].trim();
    const str = value.match(/^(["'])([\s\S]*)\1$/);
    if (str) value = str[2];
    else if (/^(true|false)$/i.test(value)) value = value.toLowerCase() === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    else continue;                        // arrays / inline tables stay out
    cursor[key] = value;
  }
  return root;
}

function parseConfigFile(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const name = file.split(/[\\/]/).pop() || '';
  if (/^\.env(\..+)?$/i.test(name) || /\.env$/i.test(name)) return parseEnvFile(text);
  if (/\.toml$/i.test(name)) return parseToml(text);
  try { return JSON.parse(text); } catch { return null; }
}

function scanJsonCredentials(reg) {
  const usedRefs = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'json')
    .map((p) => expandHome(p.keySource.path).toLowerCase() + '#' + (p.keySource.jsonPath || []).map(String).join('.')));
  // The same secret already imported from somewhere else must not show up again
  // just because another tool wrote a second copy of it.
  const knownKeys = new Set(reg.providers
    .map((p) => { try { return readKey(p); } catch { return ''; } })
    .filter(Boolean)
    .map((value) => createHash('sha1').update(value.trim()).digest('hex').slice(0, 12)));
  const hits = [];
  const seenDirs = new Set();

  const walk = (dir, depth) => {
    if (hits.length >= MAX_SCAN_HITS || depth > 3) return;
    let real = dir;
    try { real = resolve(dir); } catch { /* keep as-is */ }
    if (seenDirs.has(real.toLowerCase())) return;
    seenDirs.add(real.toLowerCase());
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (hits.length >= MAX_SCAN_HITS) return;
      const full = join(dir, entry.name);
      if (SCAN_SKIP.test(full + sep)) continue;
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!SCAN_FILE.test(entry.name)) continue;
      if (/^(package|package-lock|tsconfig|composer)\.json$/i.test(entry.name)) continue;
      // `.env.example` / `settings.sample.json` hold placeholders, not keys.
      if (/\.(example|sample|template|dist)$/i.test(entry.name)) continue;
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      if (size > MAX_SCAN_BYTES) continue;
      const doc = parseConfigFile(full);
      if (!doc) continue;
      collectKeyHits(doc, full, [], hits);
    }
  };

  for (const root of scanRoots()) walk(root, 0);

  const fresh = hits.filter((hit) => {
    const tag = hit.path.toLowerCase() + '#' + hit.jsonPath.map(String).join('.');
    return !usedRefs.has(tag) && !knownKeys.has(hit.fingerprint);
  });

  // One secret written in five files is still one API: collapse by value,
  // keeping the shortest path (the canonical config, not a copy inside a skill
  // folder or a project checkout).
  const byValue = new Map();
  for (const hit of fresh) {
    const id = hit.fingerprint || hit.path + '#' + hit.jsonPath.map(String).join('.');
    const prev = byValue.get(id);
    if (!prev || hit.path.split(/[\\/]/).length < prev.path.split(/[\\/]/).length) byValue.set(id, hit);
  }

  return [...byValue.values()].map(({ fingerprint, ...hit }) => {
    // Configs often store only the key. The field name is the strongest hint
    // (`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`), the file path the fallback, so the
    // row arrives with a usable Base URL instead of an empty box.
    const fieldName = String(hit.jsonPath[hit.jsonPath.length - 1] ?? '');
    const named = hit.baseURL ? null : presetFor(fieldName);
    const hint = hit.baseURL
      ? null
      : named
        ? { name: named.name, baseURL: named.baseURL }
        : presetFromPath(hit.path);
    return hint
      ? { ...hit, hint, baseURL: hint.baseURL, name: hint.name }
      : hit;
  });
}


/** `openai key` -> `openai-key`, guaranteed unique in the registry. */
function uniqueProviderId(reg, base) {
  // Keep letters from any script so a Chinese provider name still yields a
  // readable id instead of collapsing to 'provider'.
  const slug = base.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'provider';
  let id = slug;
  let n = 2;
  while (reg.providers.some((p) => p.id === id)) id = slug + '-' + n++;
  return id;
}

/**
 * Resolve a discovery descriptor into the key source to store plus the live key
 * value used for the reachability check. Throws when the secret is gone.
 */
function resolveDiscovered({ source, key, path, jsonPath }) {
  if (source === 'credential') {
    const found = listDshRefs().find((entry) => entry.ref === key && entry.value);
    if (!found) throw new Error('凭据库里没有这个 ref：' + key);
    return { preset: presetFor(key), keySource: { type: 'dsh-credentials', ref: key }, value: found.value };
  }
  if (source === 'env') {
    const value = process.env[key] || '';
    if (!value) throw new Error('环境变量里没有这个值：' + key);
    return { preset: presetFor(key), keySource: { type: 'env', name: key }, value };
  }
  if (source !== 'file') throw new Error('source 必须是 credential / env / file');
  // A file-based candidate: the provider keeps pointing at the original file,
  // so the secret is never copied into providers.json.
  const custom = loadSources().files.find((entry) => expandHome(entry.path) === path);
  // A hit from the generic scan carries its own jsonPath; it is accepted only
  // if the value can be read back right now, so a stale hit cannot be pasted in.
  const scanned = !custom && Array.isArray(jsonPath) && jsonPath.length && existsSync(path)
    ? { path, jsonPath, preset: null }
    : null;
  const target = custom
    ? { path: expandHome(custom.path), jsonPath: custom.jsonPath, preset: custom.preset }
    : scanned;
  if (!target) throw new Error('未知的配置文件');
  let value = '';
  try { value = jsonGet(parseConfigFile(target.path), target.jsonPath); } catch { /* unreadable */ }
  if (!value) throw new Error('这个文件里没有读到 Key');
  return { preset: target.preset, keySource: { type: 'json', path: target.path, jsonPath: target.jsonPath }, value };
}

/** Turns the per-path results into one sentence a human can act on. */
function explainAttempts(tried) {
  const statuses = tried.map((t) => t.status).filter(Boolean);
  if (statuses.includes(401)) return 'Key 被接口拒绝（HTTP 401）';
  if (statuses.includes(403)) return 'Key 没有权限（HTTP 403）';
  if (statuses.includes(404) && statuses.every((s) => s === 404)) {
    return 'Base URL 不对：' + tried.map((t) => t.path + ' → 404').join('、');
  }
  const five = statuses.find((s) => s >= 500);
  if (five) return '接口自己出错（HTTP ' + five + '）';
  if (!statuses.length) return '连不上（网络错误或超时）';
  return '返回 HTTP ' + [...new Set(statuses)].join(' / ');
}

/**
 * Actually call the endpoint. An import is only allowed when the key is
 * accepted and the API answers right now — a discovered address that cannot be
 * used is worth nothing in the list.
 *
 * Two passes, because a 200 from the right address with the wrong header is
 * indistinguishable from a bad key: first `Authorization: Bearer`, then — only
 * when the server answered 401/403 — `x-api-key` / `api-key`, which some relays
 * and Azure-style deployments use. Whatever answered is remembered on the
 * provider so chat calls use the same header.
 */
function detectProtocol(baseURL) {
  let host = '';
  try { host = new URL(baseURL).host.toLowerCase(); } catch { /* keep blank */ }
  if (/(^|\.)anthropic\.com$/.test(host)) return 'Anthropic Messages';
  if (/(^|\.)generativelanguage\.googleapis\.com$/.test(host)) return 'Gemini';
  return 'OpenAI Chat Completions';
}

function modelPaths(base) {
  const paths = ['/models'];
  if (!/\/v\d+$/i.test(base)) paths.push('/v1/models');
  paths.push('/catalog/models?type=image', '/catalog/models');
  return paths;
}

async function probeModels(base, path, headers) {
  const target = /^https?:/i.test(path) ? path : base + path;
  const shown = path.replace(base, '').replace(/([?&]key=)[^&]+/i, '$1***');
  try {
    const res = await fetch(target, { headers, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    const models = parseModelList(text);
    return { path: shown, status: res.status, count: models.length, ok: res.ok, models };
  } catch (e) {
    return { path: shown, status: 0, error: String(e.message || e) };
  }
}

async function verifyEndpoint(baseURL, key) {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Base URL 必须以 http(s):// 开头', tried: [] };
  if (!String(key || '').trim()) return { ok: false, error: '没有读到 Key', tried: [] };
  const k = String(key).trim();
  const protocol = detectProtocol(base);
  const started = Date.now();
  const tried = [];
  const done = (hit, auth) => ({
    ok: true, protocol, auth, path: hit.path, status: hit.status,
    models: hit.models, ms: Date.now() - started, tried,
  });

  for (const path of modelPaths(base)) {
    const hit = await probeModels(base, path, { Authorization: `Bearer ${k}` });
    tried.push(hit);
    if (hit.ok) return done(hit, 'bearer');
    // A refused connection, a DNS failure or a timeout answers every route the
    // same way; trying the remaining paths would only burn another 10s each.
    if (!hit.status) break;
  }

  // The address is alive but did not take the bearer token: try the other
  // header names rather than declaring a good key dead.
  if (tried.some((t) => t.status === 401 || t.status === 403)) {
    for (const style of ['x-api-key', 'api-key']) {
      for (const path of modelPaths(base).slice(0, 2)) {
        const hit = await probeModels(base, path, { [style]: k });
        tried.push(hit);
        if (hit.ok) return done(hit, style);
      }
    }
  }

  // Explain a "no" that is really a "yes, wrong protocol": Anthropic answers
  // /v1/messages rather than the OpenAI routes this panel drives, and Gemini
  // takes the key as a query parameter.
  if (protocol === 'Anthropic Messages') {
    const hit = await probeModels(base, '/models', { 'x-api-key': k, 'anthropic-version': '2023-06-01' });
    tried.push(hit);
    if (hit.ok) {
      return {
        ok: false,
        protocol,
        tried,
        error: 'Key 有效，但这是 Anthropic 原生协议（/v1/messages），面板只会调 OpenAI 兼容接口，所以没有导入',
      };
    }
  }
  if (protocol === 'Gemini') {
    for (const root of [base, base + '/v1beta']) {
      const hit = await probeModels(base, `${root}/models?key=${encodeURIComponent(k)}`, {});
      tried.push(hit);
      if (hit.ok) {
        return {
          ok: false,
          protocol,
          tried,
          error: 'Key 有效，但这是 Gemini 原生协议（models?key=…），面板只会调 OpenAI 兼容接口；把 Base URL 换成 …/v1beta/openai 再试',
        };
      }
    }
  }

  return { ok: false, protocol, error: explainAttempts(tried), ms: Date.now() - started, tried };
}

/** Verified import: nothing is written unless the API answers right now. */
async function importDiscovered(reg, body) {
  const { baseURL, name, kind, protocol } = body;
  const base = String(baseURL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Base URL 必须以 http(s):// 开头');
  const resolved = resolveDiscovered(body);

  const check = await verifyEndpoint(base, resolved.value);
  if (!check.ok) {
    const err = new Error('调不通，未导入：' + check.error);
    err.status = 400;
    err.tried = check.tried;
    throw err;
  }

  const preset = resolved.preset;
  const finalName = String(name || preset?.name || body.key || '接口').trim();
  // No kind passed and the preset knows none: the model list just fetched is
  // better evidence than a default, so ask it.
  const explicitKind = kind || preset?.kind;
  const inferred = classifyKind(check.models);
  const kinds = explicitKind ? [explicitKind === 'image' ? 'image' : 'llm'] : inferred.kinds;
  const types = explicitKind ? kinds : inferred.types;
  const finalKind = kinds[0];
  const provider = {
    id: uniqueProviderId(reg, finalName),
    name: finalName,
    kind: finalKind,
    kinds,
    types,
    kindSource: explicitKind ? 'manual' : 'auto',
    tag: typesLabel(types),
    enabled: true,
    baseURL: base,
    protocol: protocol || preset?.protocol || check.protocol || 'OpenAI Chat Completions',
    notes: '自动检索导入',
    keySource: resolved.keySource,
    test: { method: 'GET', path: '/models' },
    // The check just pulled a model list, so the card has models from minute one.
    modelsCache: check.models.length ? { at: new Date().toISOString(), list: check.models } : undefined,
  };
  if (check.auth && check.auth !== 'bearer') provider.auth = check.auth;
  reg.providers.push(provider);
  saveRegistry(reg);
  return provider;
}

// ---------- provider calls ----------

async function callProvider(provider, { method = 'GET', path, body, timeoutMs = 30000 } = {}) {
  const key = readKey(provider);
  if (!key) throw Object.assign(new Error('未配置 Key'), { code: 'NO_KEY' });
  const url = provider.baseURL.replace(/\/$/, '') + (path || '/models');
  const headers = authHeaders(provider, key);
  if (body) headers['Content-Type'] = 'application/json';
  const started = Date.now();
  const res = await fetch(url, {
    method, headers,
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - started, url, text };
}

function parseModelList(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const raw = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  return raw.map((m) => {
    if (typeof m === 'string') return { id: m, name: m };
    const id = m.id ?? m.slug ?? m.name;
    return {
      id: String(id),
      name: String(m.name ?? m.display_name ?? id),
      contextWindow: m.context_window ?? m.contextWindow ?? m.max_input_tokens ?? null,
      maxTokens: m.max_output_tokens ?? m.maxTokens ?? m.max_tokens ?? null,
      extra: m.pricingMode ?? (Array.isArray(m.modes) ? m.modes.join('/') : null),
    };
  }).filter((m) => m.id && m.id !== 'undefined')
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true, sensitivity: 'base' }));
}

// ---------- what kind of API is this? ----------
// The tag on a card is not a setting: it is the union of the types of the models
// the user ticked. An OpenAI-compatible address never says what it sells, but its
// model names do. `kinds` (llm/image) still decides which default slot a provider
// can hold; `types` is the richer list the panel shows.
const MODEL_PATTERNS = [
  ['video', /(?:^|[-_/.:])(?:sora|veo|kling|hailuo|seedance|pika|runway|ltx|vidu|luma|movie-?gen|minimax-?video|hunyuan-?video|wan(?:2)?[.\d]*-?video|cogvideo|t2v|i2v|video)/i],
  ['image', /(?:^|[-_/.:])(?:gpt-image|dall-?e|image-?gen|image|imagen|flux|stable-?diffusion|sdxl|sd-?3(?:\.\d)?|qwen-image|kolors|seedream|seededit|recraft|ideogram|midjourney|nano-?banana|cogview|hidream|wanx|jimeng|janus|kandinsky|playground-v)/i],
  ['audio', /(?:^|[-_/.:])(?:tts|whisper|asr|voice|speech|audio|suno|musicgen|music|fun-asr|paraformer|cosyvoice|sensevoice)/i],
  ['embedding', /(?:^|[-_/.:])(?:embed|rerank|bge|gte|jina-|voyage)/i],
];
// Models that read pictures *and* write text: one id, two capabilities. A name
// is only a hint — vendors ship the same family with and without eyes, and
// qwen3.8-max is exactly such a case — so the panel also probes for real and
// records what it saw in `provider.vision`.
const VISION_MODEL = /(?:^|[-_/.:])(?:gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|o3|o4|claude-3|claude-4|claude-(?:sonnet|opus|haiku)|gemini-|qwen-?vl|qwen2\.?5-vl|qwen3-vl|qwen3(?:\.\d+)?-(?:max|plus)|qwen-max|glm-4v|glm-4\.5v|glm-4\.6|glm-5|llava|pixtral|internvl|minicpm-v|moondream|vision|vl(?![a-z0-9])|step-[13]v|yi-vl|phi-\d-multimodal|kimi-k2|doubao-(?:seed|vision)|grok-4)/i;
const TYPE_LABEL = { llm: '文本', vision: '视觉', image: '图片', video: '视频', audio: '语音', embedding: '向量' };
const TYPE_ORDER = ['llm', 'vision', 'image', 'video', 'audio', 'embedding'];

/** Every capability one model has, judged by its name. */
export function modelTypes(id) {
  const name = String(id ?? '');
  for (const [type, pattern] of MODEL_PATTERNS) if (pattern.test(name)) return [type];
  if (VISION_MODEL.test(name)) return ['llm', 'vision'];
  return ['llm'];
}

/** Attach the types to each model so the panel can label rows without guessing. */
function annotateModels(models) {
  return (Array.isArray(models) ? models : []).map((m) => {
    const id = String(typeof m === 'string' ? m : (m?.id ?? m?.name ?? ''));
    const types = modelTypes(id);
    return typeof m === 'string' ? { id, type: types[0], types } : { ...m, id, type: types[0], types };
  });
}

/** "文本 · 视觉 · 图片" — what a card's tag shows. */
function typesLabel(types) {
  const set = new Set(Array.isArray(types) ? types : []);
  const parts = [];
  if (set.has('llm')) parts.push('文本');
  if (set.has('vision')) parts.push('视觉');
  if (set.has('image')) parts.push('图片');
  if (set.has('video')) parts.push('视频');
  if (set.has('audio')) parts.push('语音');
  if (set.has('embedding')) parts.push('向量');
  return (parts.length ? parts : ['文本']).join(' · ');
}

/**
 * Read the models the user actually ticked and work out what the endpoint offers.
 * `kind` / `kinds` keep deciding the default slot (chat vs media); `types` is the
 * union shown in the panel, so a multimodal model adds 视觉 and a relay selling
 * both chat and images shows both.
 */
export function classifyKind(models) {
  const list = annotateModels(models);
  const counts = { llm: 0, vision: 0, image: 0, video: 0, audio: 0, embedding: 0 };
  for (const m of list) for (const t of m.types) counts[t] = (counts[t] ?? 0) + 1;
  const media = counts.image + counts.video;
  const chat = counts.llm; // a multimodal model is chat *and* 视觉
  // Ties lead with 文本: a relay that sells both is a chat API with image models.
  const primary = media > 0 && media > chat ? 'image' : 'llm';
  const kinds = primary === 'image'
    ? ['image', ...(chat ? ['llm'] : [])]
    : ['llm', ...(media ? ['image'] : [])];
  const types = TYPE_ORDER.filter((t) => counts[t] > 0);
  const parts = types.map((t) => `${counts[t]} 个${TYPE_LABEL[t]}模型`);
  const shown = types.length ? types : ['llm'];
  return {
    kind: primary,
    kinds,
    types: shown,
    label: typesLabel(shown),
    reason: parts.length ? parts.join('，') : '没有模型列表，按文本类处理',
    counts,
    media,
    chat,
    known: list.length > 0,
  };
}

/**
 * Re-read a cached model list and follow what it says. `kindSource: 'manual'`
 * marks a provider whose kind came from a preset or an import path, not a probe,
 * so that one is left alone.
 */
function syncKind(reg, p) {
  if (p.kindSource === 'manual') return null;
  // Only the models the user ticked count; the full catalog may be much larger.
  const cache = p.modelsCache?.list ?? [];
  const selected = Array.isArray(p.selectedModels) && p.selectedModels.length
    ? p.selectedModels.map(String)
    : null;
  const basis = selected
    ? cache.filter((m) => selected.includes(String(typeof m === 'string' ? m : (m?.id ?? m?.name ?? ''))))
    : cache;
  const guess = classifyKind(basis.length ? basis : cache);
  if (!guess.known) return null;
  const same = guess.kind === p.kind
    && JSON.stringify(guess.kinds) === JSON.stringify(p.kinds ?? [p.kind])
    && JSON.stringify(guess.types) === JSON.stringify(p.types ?? []);
  if (!same) {
    const old = p.kind;
    p.kind = guess.kind;
    p.kinds = guess.kinds;
    p.types = guess.types;
    p.tag = typesLabel(guess.types);
    p.kindSource = 'auto';
    if (reg.defaults && reg.defaults[old] === p.id) reg.defaults[old] = null;
  }
  return guess;
}

/**
 * The types a provider shows. Stored the first time it is probed; derived from
 * the ticked models otherwise, so a card written before 视觉 / 视频 existed still
 * reads right without a migration.
 */
function providerTypes(p) {
  const named = (() => {
    if (Array.isArray(p.types) && p.types.length) return p.types;
    const cache = p.modelsCache?.list ?? [];
    const selected = Array.isArray(p.selectedModels) && p.selectedModels.length
      ? p.selectedModels.map(String)
      : null;
    const basis = selected
      ? cache.filter((m) => selected.includes(String(typeof m === 'string' ? m : (m?.id ?? m?.name ?? ''))))
      : cache;
    const guess = classifyKind(basis.length ? basis : cache);
    return guess.known ? guess.types : (p.kinds ?? [p.kind]);
  })();
  // A proven image call outranks a name: qwen3.8-max reads like a plain text
  // model until you hand it a picture and it answers "红色".
  const out = p.vision?.ok && !named.includes('vision') ? [...named, 'vision'] : named;
  return out.slice().sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b));
}

/** What the panel shows about a provider's types and why it believes it. */
function kindView(p) {
  const guess = classifyKind(p.modelsCache?.list);
  const types = providerTypes(p);
  return {
    kind: p.kind,
    kinds: p.kinds ?? [p.kind],
    types,
    label: typesLabel(types),
    source: p.kindSource ?? 'auto',
    guessed: guess.kind,
    guessedTypes: guess.types,
    reason: guess.reason,
    known: guess.known,
  };
}
// ---------- panel state ----------

function providerView(reg, p) {
  const key = readKey(p);
  const cache = p.modelsCache?.list ?? [];
  const selected = Array.isArray(p.selectedModels) ? p.selectedModels : null;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    kinds: p.kinds ?? [p.kind],
    types: providerTypes(p),
    kindSource: p.kindSource ?? null,
    // What the last real image call said: the panel tooltip and the 视觉 chip use
    // it, so a guess never looks like a measurement.
    vision: p.vision ?? null,
    // Computed, not stored: an older provider whose tag predates 视觉 shows the
    // right one as soon as this list is read.
    tag: typesLabel(providerTypes(p)),
    baseURL: p.baseURL,
    protocol: p.protocol,
    notes: p.notes,
    usedBy: p.usedBy,
    enabled: p.enabled !== false,
    builtin: Boolean(p.builtin),
    isDefault: (reg.defaults ?? {})[p.kind] === p.id,
    keyPresent: Boolean(key),
    keyMasked: mask(key),
    keySource: p.keySource.type === 'dsh-credentials'
      ? `凭据库 refs.${p.keySource.ref}`
      : p.keySource.type === 'env'
        ? `环境变量 ${p.keySource.name}`
        : expandHome(p.keySource.path).replace(homedir(), '~'),
    keyManaged: p.keySource.type === 'json'
      && expandHome(p.keySource.path).startsWith(join(homedir(), '.dsh', 'api-hub', 'keys')),
    defaultModel: p.defaultModel ?? null,
    selectedModels: selected,
    selectedCount: selected ? selected.length : null,
    cachedCount: cache.length,
    cacheAt: p.modelsCache?.at ?? null,
  };
}

function state() {
  const reg = loadRegistry();
  return {
    title: reg.panel?.title ?? 'API Hub',
    defaults: reg.defaults ?? {},
    providers: reg.providers.map((p) => providerView(reg, p)),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Chromium asks before a page may reach a private-network address; the
  // Electron shell loads from a non-http origin, so every call is cross-origin.
  'Access-Control-Allow-Private-Network': 'true',
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(obj));
};

const findProvider = (id) => loadRegistry().providers.find((x) => x.id === id);

/**
 * Handle one panel request.
 * `prefix` lets an embedding host mount the panel under a sub-path (DSH mounts
 * it at /api-hub); the internal paths stay identical to the standalone server.
 */
export async function handleRequest(req, res, prefix = '') {
  let pathname = req.url ?? '/';
  if (prefix && pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length) || '/';
  const url = new URL(pathname, 'http://127.0.0.1');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        credentials: hasCredentialService(),
        settings: hasSettingsService(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());

    // ---- DSH model routes ----
    // What the panel would hand DSH, before anything is written. Reading this is
    // always safe, so the page can preview the mapping and show what is missing.
    if (req.method === 'GET' && url.pathname === '/api/dsh/plan') {
      const plan = planDshRoutes(loadRegistry());
      const drift = await dshDrift(plan.providers);
      return json(res, 200, {
        settings: hasSettingsService(),
        credentials: hasCredentialService(),
        namespace: PI_AI_NAMESPACE,
        drift: drift ? drift.drift : null,
        stale: drift ? drift.stale : [],
        routes: Object.entries(plan.providers).map(([id, profile]) => ({
          id,
          name: profile.displayName,
          baseURL: profile.baseURL,
          ref: profile.apiKeyEnv,
          models: profile.models.map((model) => model.id),
        })),
        skipped: plan.skipped,
        refs: dshRefWrites(loadRegistry()).map((write) => write.ref),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/dsh/sync') {
      if (!settingsBridge) {
        return json(res, 501, { error: '这个 DSH 没有组成设置服务，面板无法写入模型路由' });
      }
      const reg = loadRegistry();
      const plan = planDshRoutes(reg);
      const writes = dshRefWrites(reg);
      const owned = loadDshOwned();
      // An empty plan is a legitimate state: every chat provider was disabled or
      // removed, so the routes the panel put there earlier should go too.
      if (!Object.keys(plan.providers).length && !owned.length) {
        return json(res, 200, { ok: true, routes: 0, models: 0, ids: [], refs: [], pruned: [], skipped: plan.skipped });
      }
      if (writes.length && !hasCredentialService()) {
        return json(res, 501, { error: '这个 DSH 没有组成凭据服务，写不了接口的 Key' });
      }
      const stored = [];
      try {
        for (const write of writes) {
          await credentialWriter.set(write.ref, write.value);
          stored.push(write.ref);
        }
      } catch (error) {
        return json(res, 400, { error: '写 Key 失败：' + (error?.message ?? String(error)), stored });
      }
      let merged = plan.providers;
      const pruned = [];
      if (typeof settingsBridge.read === 'function') {
        try {
          const current = await settingsBridge.read();
          const existing = current?.providers && typeof current.providers === 'object' ? current.providers : {};
          // Keep whatever the Models page already registered, drop the routes the
          // panel wrote for providers that are now disabled or gone, then write
          // the current plan over the rest.
          merged = { ...existing };
          for (const id of owned) {
            if (!(id in plan.providers) && id in merged) {
              delete merged[id];
              pruned.push(id);
            }
          }
          Object.assign(merged, plan.providers);
        } catch { /* unreadable section: write ours alone */ }
      }
      try {
        await settingsBridge.update({ providers: merged });
      } catch (error) {
        return json(res, 400, { error: 'DSH 拒绝了这份配置：' + (error?.message ?? String(error)), stored });
      }
      saveDshOwned(Object.keys(plan.providers));
      return json(res, 200, {
        ok: true,
        routes: Object.keys(plan.providers).length,
        models: Object.values(plan.providers).reduce((sum, profile) => sum + profile.models.length, 0),
        ids: Object.keys(plan.providers),
        refs: stored,
        pruned,
        skipped: plan.skipped,
      });
    }

    // ---- skills ----
    if (req.method === 'GET' && url.pathname === '/api/skills') {
      return json(res, 200, { dir: SKILLS_DIR, skills: listSkills(), tags: allSkillTags() });
    }

    if (req.method === 'GET' && url.pathname === '/api/skills/read') {
      const id = url.searchParams.get('id') ?? '';
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      const skill = skillById(id);
      if (!skill) return json(res, 404, { error: 'skill not found' });
      return json(res, 200, { id, path: skill.file, scope: skill.scope, content: readFileSync(skill.file, 'utf8').slice(0, 120000) });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/toggle') {
      const { id, enabled } = await readBody(req);
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      const skill = skillById(id);
      if (!skill) return json(res, 404, { error: 'skill not found' });
      // Only ~/.dsh/skills belongs to the panel. A project or agents skill is
      // read where its owner put it; moving it would break that owner.
      if (!skill.managed) {
        const where = { project: '项目目录', agents: '~/.agents' }[skill.scope] ?? '其它目录';
        return json(res, 400, { error: `这个技能在${where}里，面板只读不改动` });
      }
      const single = skill.path === skill.file;
      const from = single ? join(enabled ? SKILLS_OFF : SKILLS_DIR, basename(skill.file)) : join(enabled ? SKILLS_OFF : SKILLS_DIR, id);
      const to = single ? join(enabled ? SKILLS_DIR : SKILLS_OFF, basename(skill.file)) : join(enabled ? SKILLS_DIR : SKILLS_OFF, id);
      if (!existsSync(from)) return json(res, 404, { error: 'skill not found' });
      if (existsSync(to)) return json(res, 400, { error: '目标位置已有同名技能' });
      mkdirSync(SKILLS_OFF, { recursive: true });
      renameSync(from, to);
      return json(res, 200, { ok: true, skills: listSkills() });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/rename') {
      const { id, name } = await readBody(req);
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      const clean = String(name ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!clean) return json(res, 400, { error: '名字不能为空' });
      const skill = skillById(id);
      if (!skill) return json(res, 404, { error: 'skill not found' });
      try {
        setSkillName(skill.file, clean);
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
      return json(res, 200, { ok: true, name: clean, skills: listSkills(), tags: allSkillTags() });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/tags') {
      const { id, tags } = await readBody(req);
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      if (!skillById(id)) return json(res, 404, { error: 'skill not found' });
      const doc = loadSkillTags();
      const clean = cleanTags(tags);
      if (clean.length) doc[id] = clean;
      else delete doc[id];
      saveSkillTags(doc);
      return json(res, 200, { ok: true, tags: allSkillTags(), skills: listSkills() });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/reorder') {
      const { order } = await readBody(req);
      if (!Array.isArray(order)) return json(res, 400, { error: 'order 必须是 id 数组' });
      // Only ids that are still on disk are worth storing; a deleted skill must
      // not leave a ghost entry that pushes the next list around.
      const known = new Set(listSkills().map((s) => s.id));
      const ids = [...new Set(order.map((id) => String(id ?? '')))].filter((id) => known.has(id));
      if (!ids.length) return json(res, 400, { error: 'order 里没有现有的技能' });
      saveSkillOrder(ids);
      return json(res, 200, { ok: true, skills: listSkills() });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/remove') {
      const { id } = await readBody(req);
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      const skill = skillById(id);
      if (!skill) return json(res, 404, { error: 'skill not found' });
      if (!skill.managed) return json(res, 400, { error: '这个技能不在面板管理的目录里，面板不删它' });
      const target = resolve(skill.path);
      const managedRoots = [resolve(SKILLS_DIR), resolve(SKILLS_OFF)];
      if (!managedRoots.some((root) => target === root || target.startsWith(root + sep))) {
        return json(res, 400, { error: '拒绝删除技能目录之外的路径' });
      }
      rmSync(target, { recursive: true, force: true });
      // A removed skill must not leave its filing behind for a future skill
      // that happens to reuse the same id.
      const doc = loadSkillTags();
      if (doc[id]) { delete doc[id]; saveSkillTags(doc); }
      const order = loadSkillOrder();
      if (order.includes(id)) saveSkillOrder(order.filter((x) => x !== id));
      return json(res, 200, { ok: true, skills: listSkills(), tags: allSkillTags() });
    }

    // ---- enable / disable ----
    if (req.method === 'POST' && url.pathname === '/api/enabled') {
      const { id, enabled } = await readBody(req);
      const reg = loadRegistry();
      const p = reg.providers.find((x) => x.id === id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      p.enabled = Boolean(enabled);
      if (!p.enabled && reg.defaults?.[p.kind] === p.id) {
        const alt = reg.providers.find((x) => x.kind === p.kind && x.enabled !== false && x.id !== p.id);
        reg.defaults[p.kind] = alt ? alt.id : null;
      }
      saveRegistry(reg);
      return json(res, 200, { ok: true, ...state() });
    }

    // ---- test ----
    if (req.method === 'POST' && url.pathname === '/api/test') {
      const { id } = await readBody(req);
      const p = findProvider(id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      try {
        const r = await callProvider(p, { method: p.test?.method ?? 'GET', path: p.test?.path });
        const models = parseModelList(r.text);
        return json(res, 200, {
          ok: r.status >= 200 && r.status < 300,
          status: r.status, ms: r.ms,
          count: models.length || null,
          sample: r.text.slice(0, 300),
        });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.code === 'NO_KEY' ? '未配置 Key' : String(e.message || e) });
      }
    }

    // ---- key ----
    if (req.method === 'POST' && url.pathname === '/api/key') {
      const { id, key } = await readBody(req);
      const p = findProvider(id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      const value = String(key ?? '').trim();
      if (!value) return json(res, 400, { error: 'Key 不能为空' });
      try {
        await writeKey(p, value);
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
      return json(res, 200, { ok: true, ...state() });
    }

    // ---- default provider (set, or clear when id is null) ----
    if (req.method === 'POST' && url.pathname === '/api/default') {
      const { kind, id } = await readBody(req);
      const reg = loadRegistry();
      if (!id) {
        if (kind !== 'llm' && kind !== 'image') return json(res, 400, { error: 'kind 必须是 llm 或 image' });
        reg.defaults = { ...(reg.defaults ?? {}), [kind]: null };
        saveRegistry(reg);
        return json(res, 200, { ok: true, ...state() });
      }
      const p = reg.providers.find((x) => x.id === id);
      if (!p || p.kind !== kind) return json(res, 400, { error: 'provider/kind mismatch' });
      if (p.enabled === false) return json(res, 400, { error: '该服务商已停用，先启用再设为默认' });
      reg.defaults = { ...(reg.defaults ?? {}), [kind]: id };
      saveRegistry(reg);
      return json(res, 200, { ok: true, ...state() });
    }

    // ---- model catalog ----
    if (req.method === 'GET' && url.pathname === '/api/models') {
      const id = url.searchParams.get('id');
      const reg = loadRegistry();
      const p = reg.providers.find((x) => x.id === id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      const refresh = url.searchParams.get('refresh') === '1';
      if (!refresh && p.modelsCache?.list?.length) {
        return json(res, 200, { at: p.modelsCache.at, list: annotateModels(p.modelsCache.list), cached: true, kind: kindView(p) });
      }
      try {
        const r = await callProvider(p, { method: p.test?.method ?? 'GET', path: p.test?.path });
        if (r.status < 200 || r.status >= 300) {
          return json(res, 200, { error: `HTTP ${r.status}`, list: annotateModels(p.modelsCache?.list), at: p.modelsCache?.at ?? null, kind: kindView(p) });
        }
        const list = parseModelList(r.text);
        p.modelsCache = { at: new Date().toISOString(), list };
        syncKind(reg, p);
        saveRegistry(reg);
        return json(res, 200, { at: p.modelsCache.at, list: annotateModels(list), cached: false, kind: kindView(p) });
      } catch (e) {
        return json(res, 200, { error: String(e.message || e), list: annotateModels(p.modelsCache?.list), at: p.modelsCache?.at ?? null, kind: kindView(p) });
      }
    }

    // ---- save model selection ----
    if (req.method === 'POST' && url.pathname === '/api/models') {
      const { id, selected, defaultModel } = await readBody(req);
      const reg = loadRegistry();
      const p = reg.providers.find((x) => x.id === id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      // A body without `selected` used to mean "clear the selection", which made
      // a malformed call silently wipe a provider's models. Absence is now an
      // error; clearing is spelled `selected: []`.
      if (!Array.isArray(selected)) return json(res, 400, { error: 'selected 必须是数组；清空请传 []' });
      const known = new Set((p.modelsCache?.list ?? []).map((m) => m.id));
      const chosen = selected.filter((m) => known.has(m));
      const dropped = selected.filter((m) => !known.has(m));
      const asked = defaultModel === undefined || defaultModel === null ? '' : String(defaultModel);
      if (asked && !chosen.includes(asked)) {
        return json(res, 400, { error: '默认模型必须在已选模型里' });
      }
      p.selectedModels = chosen;
      // No explicit default: keep the current one while it is still selected,
      // otherwise fall back to the first pick, and drop it when nothing is left.
      const next = asked || (chosen.includes(p.defaultModel) ? p.defaultModel : chosen[0] ?? '');
      if (next) p.defaultModel = next; else delete p.defaultModel;
      syncKind(reg, p);
      saveRegistry(reg);
      return json(res, 200, { ok: true, kind: kindView(p), dropped, ...state() });
    }

    // ---- balance ----
    if (req.method === 'GET' && url.pathname === '/api/balance') {
      const id = url.searchParams.get('id');
      const p = findProvider(id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      if (!p.balance) return json(res, 200, { ok: false, error: '该服务商没有余额查询接口' });
      try {
        const r = await callProvider(p, { method: p.balance.method ?? 'GET', path: p.balance.path });
        if (r.status < 200 || r.status >= 300) return json(res, 200, { ok: false, error: `HTTP ${r.status}` });
        let v = JSON.parse(r.text);
        for (const seg of p.balance.extract ?? []) v = v?.[seg];
        const num = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(num)) return json(res, 200, { ok: false, error: '响应里没有余额字段' });
        return json(res, 200, {
          ok: true, amount: num,
          currency: p.balance.currency ?? '',
          label: p.balance.label ?? '余额',
        });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    // ---- probe an unknown endpoint ----
    if (req.method === 'POST' && url.pathname === '/api/probe') {
      const { baseURL, key } = await readBody(req);
      const base = String(baseURL ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) return json(res, 400, { error: '地址必须以 http:// 或 https:// 开头' });
      if (!String(key ?? '').trim()) return json(res, 400, { error: 'Key 不能为空' });

      // Same check the importer uses, so the preview and the real call agree on
      // which header style the address wants.
      const check = await verifyEndpoint(base, key);
      if (check.ok && check.models?.length) {
        return json(res, 200, { ok: true, path: check.path, models: annotateModels(check.models), tried: check.tried, kind: classifyKind(check.models) });
      }
      return json(res, 200, {
        ok: false,
        error: check.ok ? '没有探测到模型列表' : check.error,
        tried: check.tried ?? [],
      });
    }

    // ---- discovery: what is already on this machine ----
    if (req.method === 'GET' && url.pathname === '/api/discover') {
      return json(res, 200, discover());
    }

    // ---- dry run: can this discovered candidate actually be called? ----
    if (req.method === 'POST' && url.pathname === '/api/discover/verify') {
      const body = await readBody(req);
      try {
        const resolved = resolveDiscovered(body);
        const check = await verifyEndpoint(body.baseURL, resolved.value);
        return json(res, 200, check);
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/discover/import') {
      const body = await readBody(req);
      const reg = loadRegistry();
      try {
        const provider = await importDiscovered(reg, body);
        return json(res, 200, { ok: true, provider: providerView(reg, provider), ...state() });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e), tried: e.tried });
      }
    }

    // ---- extra scan locations the user adds ----
    if (req.method === 'POST' && url.pathname === '/api/discover/sources') {
      const body = await readBody(req);
      const type = body.type === 'skills' ? 'skills' : 'file';
      const raw = String(body.path || '').trim();
      if (!raw) return json(res, 400, { error: '请填路径' });
      const abs = expandHome(raw);
      if (!existsSync(abs)) return json(res, 400, { error: '路径不存在：' + abs });

      const doc = loadSources();
      if (type === 'skills') {
        if (!statSync(abs).isDirectory()) return json(res, 400, { error: '技能位置必须是目录' });
        if (!doc.skillDirs.includes(abs)) doc.skillDirs.push(abs);
      } else {
        const jsonPath = String(body.jsonPath || 'apiKey')
          .split(/[.[\]]+/).map((part) => part.trim()).filter(Boolean);
        let cfg = null;
        try { cfg = JSON.parse(readFileSync(abs, 'utf8')); } catch { /* not JSON */ }
        if (!cfg) return json(res, 400, { error: '这个文件不是可读的 JSON：' + abs });
        if (!jsonGet(cfg, jsonPath)) {
          const names = fieldNames(cfg);
          return json(res, 400, {
            error: '这个文件里没有「' + jsonPath.join('.') + '」这个字段'
              + (names.length ? '；它有的字段：' + names.join('、') : ''),
          });
        }
        // A config that already carries its endpoint does not need the URL typed.
        let baseURL = String(body.baseURL || '').replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(baseURL)) baseURL = findBaseURL(cfg).replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(baseURL)) {
          return json(res, 400, { error: '这个文件里没有接口地址，请填 Base URL（http/https）' });
        }
        doc.files = doc.files.filter((entry) => expandHome(entry.path) !== abs)
          .concat([{
            path: abs,
            jsonPath,
            preset: {
              name: String(body.name || basename(abs).replace(/\.json$/i, '')),
              baseURL,
              protocol: 'OpenAI Chat Completions',
              kind: body.kind === 'image' ? 'image' : 'llm',
              tag: body.kind === 'image' ? '图片' : '文本',
            },
          }]);
      }
      saveSources(doc);
      return json(res, 200, { ok: true, ...discover() });
    }

    if (req.method === 'POST' && url.pathname === '/api/discover/sources/remove') {
      const { type, path } = await readBody(req);
      const abs = expandHome(String(path || ''));
      const doc = loadSources();
      if (type === 'skills') doc.skillDirs = doc.skillDirs.filter((dir) => dir !== abs);
      else doc.files = doc.files.filter((entry) => expandHome(entry.path) !== abs);
      saveSources(doc);
      return json(res, 200, { ok: true, ...discover() });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/import') {
      const { from, id } = await readBody(req);
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      const src = resolve(String(from || ''));
      const root = otherSkillRoots().find((entry) => src.startsWith(resolve(entry.dir) + sep));
      if (!root) return json(res, 400, { error: '只能从检索到的技能目录导入（其它 agent 的技能目录，或「添加扫描位置」里填的目录）' });
      const skillFile = join(src, 'SKILL.md');
      if (!existsSync(skillFile)) return json(res, 404, { error: '源目录里没有 SKILL.md' });
      if (!isDshSkill(readSkillFrontmatter(skillFile))) {
        return json(res, 400, { error: '不是 DSH 技能格式：SKILL.md 顶部需要 --- name: … description: … ---' });
      }
      const dest = join(SKILLS_DIR, id);
      if (existsSync(dest)) return json(res, 409, { error: '目标目录已存在：' + id });
      mkdirSync(SKILLS_DIR, { recursive: true });
      cpSync(src, dest, { recursive: true });
      return json(res, 200, { ok: true, skills: listSkills() });
    }

    // ---- add a provider ----
    if (req.method === 'POST' && url.pathname === '/api/providers/add') {
      const body = await readBody(req);
      const base = String(body.baseURL ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) return json(res, 400, { error: '地址必须以 http:// 或 https:// 开头' });
      const key = String(body.key ?? '').trim();
      if (!key) return json(res, 400, { error: 'Key 不能为空' });

      const reg = loadRegistry();
      const host = (() => { try { return new URL(base).host; } catch { return 'provider'; } })();
      const slug = (String(body.name ?? '').trim() || host)
        .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'provider';
      let id = slug;
      for (let i = 2; reg.providers.some((p) => p.id === id); i++) id = `${slug}-${i}`;

      const keyPath = `~/.dsh/api-hub/keys/${id}.json`;
      // The dialog probes the model list and the user ticks what they want; the
      // types come from those ticks only, never from a manual switch.
      const selected = Array.isArray(body.selected) ? body.selected.map(String) : [];
      const picked = (Array.isArray(body.models) ? body.models : [])
        .filter((m) => !selected.length || selected.includes(String(typeof m === 'string' ? m : (m?.id ?? m?.name ?? ''))));
      const guess = classifyKind(picked.length ? picked : body.models);
      const kinds = guess.kinds;
      const finalKind = kinds[0];
      const entry = {
        id,
        name: String(body.name ?? '').trim() || host,
        kind: finalKind,
        kinds,
        types: guess.types,
        kindSource: guess.known ? 'auto' : 'manual',
        tag: typesLabel(guess.types),
        enabled: true,
        baseURL: base,
        protocol: String(body.protocol ?? '').trim() || 'OpenAI 兼容',
        notes: String(body.notes ?? '').trim() || '手动添加',
        keySource: { type: 'json', path: keyPath, jsonPath: ['apiKey'] },
        test: { method: 'GET', path: String(body.testPath ?? '').trim() || '/models' },
        usedBy: '手动添加',
      };
      if (Array.isArray(body.models) && body.models.length) {
        entry.modelsCache = { at: new Date().toISOString(), list: body.models };
      }
      const chosen = Array.isArray(body.selected) ? body.selected.filter((m) => entry.modelsCache?.list.some((x) => x.id === m)) : null;
      if (chosen && chosen.length) entry.selectedModels = chosen;
      const def = String(body.defaultModel ?? '').trim();
      if (def) {
        if (entry.selectedModels && !entry.selectedModels.includes(def)) {
          return json(res, 400, { error: '默认模型必须在已选模型里' });
        }
        entry.defaultModel = def;
      }

      // write the key first: a provider whose key cannot be stored must not be registered
      await writeKey(entry, key);

      // A name is a hint, not a fact: ask the model itself whether it can see.
      // Only ever *adds* the 视觉 type — a probe that fails just means we show
      // what the names said.
      if (!entry.types.includes('vision') && body.checkVision !== false) {
        const seen = await probeVision(entry, entry.defaultModel || entry.modelsCache?.list?.[0]?.id);
        entry.vision = { tested: true, ok: seen.ok, status: seen.status ?? null, model: seen.model, note: seen.note, at: new Date().toISOString() };
      }

      reg.providers.push(entry);
      saveRegistry(reg);
      return json(res, 200, { ok: true, id, vision: entry.vision ?? null, ...state() });
    }

    // ---- does this provider's model really read images? ----
    if (req.method === 'POST' && url.pathname === '/api/vision') {
      const body = await readBody(req);
      const reg = loadRegistry();
      const p = reg.providers.find((x) => x.id === body.id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      const seen = await probeVision(p, String(body.model ?? '').trim() || p.defaultModel);
      p.vision = { tested: true, ok: seen.ok, status: seen.status ?? null, model: seen.model, note: seen.note, at: new Date().toISOString() };
      saveRegistry(reg);
      return json(res, 200, { ok: seen.ok, status: seen.status ?? null, ms: seen.ms, model: seen.model, note: seen.note, ...state() });
    }

    // ---- rename one provider (double-click the card title) ----
    if (req.method === 'POST' && url.pathname === '/api/providers/rename') {
      const body = await readBody(req);
      // Same rules as the panel title: one printable line, 40 chars at most.
      const name = String(body.name ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) return json(res, 400, { error: '名字不能为空' });
      const reg = loadRegistry();
      const p = reg.providers.find((x) => x.id === body.id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      p.name = name;
      saveRegistry(reg);
      return json(res, 200, { ok: true, name, ...state() });
    }

    // ---- remove a provider ----
    if (req.method === 'POST' && url.pathname === '/api/providers/remove') {
      const { id } = await readBody(req);
      const reg = loadRegistry();
      const idx = reg.providers.findIndex((x) => x.id === id);
      if (idx === -1) return json(res, 404, { error: 'unknown provider' });
      const p = reg.providers[idx];

      // only ever delete key files this hub owns; built-in keys live in other tools' configs
      const keyPath = p.keySource?.type === 'json' ? expandHome(p.keySource.path) : '';
      const hubKeysDir = join(homedir(), '.dsh', 'api-hub', 'keys');
      // Compare with the platform separator so the guard behaves the same on macOS.
      const hubKeysPrefix = hubKeysDir + sep;
      let keyFileRemoved = false;
      if (keyPath && (keyPath === hubKeysDir || keyPath.startsWith(hubKeysPrefix))) {
        try { rmSync(keyPath, { force: true }); keyFileRemoved = true; } catch { /* keep going */ }
      }

      reg.providers.splice(idx, 1);
      for (const kind of ['llm', 'image']) {
        if (reg.defaults?.[kind] === id) {
          const alt = reg.providers.find((x) => x.kind === kind && x.enabled !== false);
          reg.defaults[kind] = alt ? alt.id : null;
        }
      }
      saveRegistry(reg);
      return json(res, 200, { ok: true, keyFileRemoved, ...state() });
    }

    // ---- reorder providers ----
    if (req.method === 'POST' && url.pathname === '/api/providers/reorder') {
      const { order } = await readBody(req);
      const reg = loadRegistry();
      if (!Array.isArray(order) || order.length !== reg.providers.length) {
        return json(res, 400, { error: 'order 必须是全部服务商 id 的排列' });
      }
      const byId = new Map(reg.providers.map((p) => [p.id, p]));
      if (new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
        return json(res, 400, { error: 'order 里有重复或未知的 id' });
      }
      reg.providers = order.map((id) => byId.get(id));
      saveRegistry(reg);
      return json(res, 200, { ok: true, ...state() });
    }

    // ---- raw request ----
    if (req.method === 'POST' && url.pathname === '/api/request') {
      const { id, method, path, body, timeoutMs } = await readBody(req);
      const p = findProvider(id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      try {
        const r = await callProvider(p, {
          method: method || 'GET', path: path || '/models', body,
          timeoutMs: Math.min(Math.max(timeoutMs || 30000, 1000), 120000),
        });
        return json(res, 200, { status: r.status, ms: r.ms, url: r.url, body: r.text.slice(0, 20000), truncated: r.text.length > 20000 });
      } catch (e) {
        return json(res, 200, { error: e.code === 'NO_KEY' ? '未配置 Key' : String(e.message || e) });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}
