// API Hub — local panel to manage and call API providers.
// No dependencies. Binds 127.0.0.1 only.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, renameSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// User data lives in ~/.dsh/api-hub, not inside the installed package, so a
// linked working copy and a package installed from a tarball read the same files.
const DATA_DIR = join(homedir(), '.dsh', 'api-hub');
const REGISTRY_PATH = join(DATA_DIR, 'providers.json');
// Shipped with the package (lib/ -> package root) and copied on first run.
const EXAMPLE_PATH = join(HERE, '..', 'providers.example.json');
const DSH_CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml');
const SKILLS_DIR = join(homedir(), '.dsh', 'skills');
const SKILLS_OFF = join(SKILLS_DIR, '.disabled');

const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
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

function jsonGet(obj, path) {
  let cur = obj;
  for (const seg of path) { if (cur == null) return ''; cur = cur[seg]; }
  return typeof cur === 'string' ? cur : '';
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
      return jsonGet(JSON.parse(readFileSync(file, 'utf8')), src.jsonPath);
    }
  } catch { return ''; }
  return '';
}

function writeKey(provider, value) {
  const src = provider.keySource;
  if (src.type === 'dsh-credentials') return writeDshRef(src.ref, value);
  if (src.type === 'env') throw new Error('这个接口的 Key 来自环境变量，请在启动 DSH 的环境里修改');
  if (src.type === 'json') {
    const file = expandHome(src.path);
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

function skillsFrom(base, enabled) {
  if (!existsSync(base)) return [];
  const out = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = join(base, e.name);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    let fm = {};
    try { fm = parseFrontmatter(readFileSync(file, 'utf8')); } catch { /* ignore */ }
    const st = statSync(file);
    const { files, bytes } = skillStats(dir);
    out.push({
      id: e.name,
      name: fm.name || e.name,
      description: String(fm.description ?? '').slice(0, 260),
      enabled,
      files,
      bytes,
      path: dir,
      modified: st.mtime.toISOString(),
    });
  }
  return out;
}

const listSkills = () => [...skillsFrom(SKILLS_DIR, true), ...skillsFrom(SKILLS_OFF, false)]
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }));

/** Skill directories other agent tools use, offered for import into DSH. */
function otherSkillRoots() {
  return [
    { source: 'codex', dir: join(homedir(), '.codex', 'skills') },
    { source: 'claude', dir: join(homedir(), '.claude', 'skills') },
    { source: 'agents', dir: join(homedir(), '.agents', 'skills') },
  ].filter((root) => existsSync(root.dir));
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
  const usedRefs = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'dsh-credentials').map((p) => p.keySource.ref));
  const usedEnv = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'env').map((p) => p.keySource.name));

  const credentials = listDshRefs()
    .filter((entry) => API_REF.test(entry.ref) && entry.value)
    .map((entry) => ({
      ref: entry.ref,
      masked: mask(entry.value),
      used: usedRefs.has(entry.ref),
      preset: presetFor(entry.ref),
    }));

  const envKeys = Object.keys(process.env)
    .filter((name) => API_REF.test(name) && (process.env[name] || '').length >= 8)
    .map((name) => ({
      name,
      masked: mask(process.env[name]),
      used: usedEnv.has(name),
      preset: presetFor(name),
    }));

  const managed = new Set(listSkills().map((skill) => skill.id));
  const skills = [];
  for (const root of otherSkillRoots()) {
    for (const skill of skillsFrom(root.dir, true)) {
      if (managed.has(skill.id)) continue;
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
    files: discoverKnownFiles(reg),
    codex: discoverCodexProviders(reg),
    managed: reg.providers.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      enabled: p.enabled !== false,
      source: p.keySource?.type === 'dsh-credentials'
        ? '凭据库 refs.' + p.keySource.ref
        : p.keySource?.type === 'env'
          ? '环境变量 ' + p.keySource.name
          : String(p.keySource?.path ?? '').replace(homedir(), '~'),
    })),
    skills,
    scannedAt: new Date().toISOString(),
  };
}

// Third-party config files this hub knows how to read. A key found here can be
// imported without copying it: the provider keeps pointing at the file.
const KNOWN_FILES = [
  {
    path: () => join(homedir(), '.config', 'jws-image', 'config.json'),
    jsonPath: ['apiKey'],
    preset: { name: 'JWS 生图', baseURL: 'https://image.aijws.com/v1', protocol: 'JWS Catalog + OpenAI Images', kind: 'image', tag: '图片' },
  },
  {
    path: () => join(homedir(), '.codex', '88api-image-gen-config.json'),
    jsonPath: ['workers', 0, 'apiKey'],
    preset: { name: '88API 生图', baseURL: 'https://88api.ai/v1', protocol: 'OpenAI Images', kind: 'image', tag: '图片' },
  },
];

function discoverKnownFiles(reg) {
  const used = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'json')
    .map((p) => expandHome(p.keySource.path)));
  const out = [];
  for (const known of KNOWN_FILES) {
    const file = known.path();
    if (!existsSync(file)) continue;
    let value = '';
    try {
      value = jsonGet(JSON.parse(readFileSync(file, 'utf8')), known.jsonPath);
    } catch { continue; }
    if (!value) continue;
    out.push({
      path: file.replace(homedir(), '~'),
      absolutePath: file,
      jsonPath: known.jsonPath,
      masked: mask(value),
      preset: known.preset,
      used: used.has(file),
    });
  }
  return out;
}

/** Reads `[model_providers.<id>]` blocks from Codex's TOML config. */
function discoverCodexProviders(reg) {
  const file = join(homedir(), '.codex', 'config.toml');
  if (!existsSync(file)) return [];
  const usedEnv = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'env').map((p) => p.keySource.name));
  const out = [];
  let current = null;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = line.match(/^\[model_providers\.([^\]]+)\]$/);
    if (head) {
      current = { id: head[1].replace(/^"|"$/g, ''), baseURL: '', envKey: '' };
      out.push(current);
      continue;
    }
    if (/^\[/.test(line)) { current = null; continue; }
    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (kv[1] === 'base_url') current.baseURL = value;
    if (kv[1] === 'env_key') current.envKey = value;
  }
  return out
    .filter((p) => /^https?:\/\//i.test(p.baseURL))
    .map((p) => ({
      id: p.id,
      baseURL: p.baseURL,
      envKey: p.envKey,
      hasKey: Boolean(p.envKey && process.env[p.envKey]),
      used: Boolean(p.envKey && usedEnv.has(p.envKey)),
    }));
}


/** `openai key` -> `openai-key`, guaranteed unique in the registry. */
function uniqueProviderId(reg, base) {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  let id = slug;
  let n = 2;
  while (reg.providers.some((p) => p.id === id)) id = slug + '-' + n++;
  return id;
}

function importDiscovered(reg, { source, key, path, baseURL, name, kind, protocol }) {
  if (!['credential', 'env', 'file'].includes(source)) {
    throw new Error('source 必须是 credential / env / file');
  }
  if (!/^https?:\/\//i.test(String(baseURL || ''))) throw new Error('Base URL 必须以 http(s):// 开头');

  let preset = null;
  let keySource = null;

  if (source === 'credential') {
    const found = listDshRefs().find((entry) => entry.ref === key && entry.value);
    if (!found) throw new Error('凭据库里没有这个 ref：' + key);
    preset = presetFor(key);
    keySource = { type: 'dsh-credentials', ref: key };
  } else if (source === 'env') {
    if (!(process.env[key] || '')) throw new Error('环境变量里没有这个值：' + key);
    preset = presetFor(key);
    keySource = { type: 'env', name: key };
  } else {
    // A file-based candidate: the provider keeps pointing at the original file,
    // so the secret is never copied into providers.json.
    const known = KNOWN_FILES.find((entry) => entry.path() === path);
    if (!known) throw new Error('未知的配置文件');
    let value = '';
    try { value = jsonGet(JSON.parse(readFileSync(known.path(), 'utf8')), known.jsonPath); } catch { /* unreadable */ }
    if (!value) throw new Error('这个文件里没有读到 Key');
    preset = known.preset;
    keySource = { type: 'json', path: known.path(), jsonPath: known.jsonPath };
  }

  const finalName = String(name || preset?.name || key).trim();
  const finalKind = (kind || preset?.kind) === 'image' ? 'image' : 'llm';
  const provider = {
    id: uniqueProviderId(reg, finalName),
    name: finalName,
    kind: finalKind,
    tag: finalKind === 'image' ? '图片' : '文本',
    enabled: true,
    baseURL: String(baseURL).replace(/\/+$/, ''),
    protocol: protocol || preset?.protocol || 'OpenAI Chat Completions',
    notes: '自动检索导入',
    keySource,
    test: { method: 'GET', path: '/models' },
  };
  reg.providers.push(provider);
  saveRegistry(reg);
  return provider;
}

// ---------- provider calls ----------

async function callProvider(provider, { method = 'GET', path, body, timeoutMs = 30000 } = {}) {
  const key = readKey(provider);
  if (!key) throw Object.assign(new Error('未配置 Key'), { code: 'NO_KEY' });
  const url = provider.baseURL.replace(/\/$/, '') + (path || '/models');
  const headers = { Authorization: `Bearer ${key}` };
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

// ---------- panel state ----------

function providerView(reg, p) {
  const key = readKey(p);
  const cache = p.modelsCache?.list ?? [];
  const selected = Array.isArray(p.selectedModels) ? p.selectedModels : null;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    tag: p.tag,
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
      return json(res, 200, { ok: true, pid: process.pid, uptime: Math.round(process.uptime()) });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());

    // ---- skills ----
    if (req.method === 'GET' && url.pathname === '/api/skills') {
      return json(res, 200, { dir: SKILLS_DIR, skills: listSkills() });
    }

    if (req.method === 'GET' && url.pathname === '/api/skills/read') {
      const id = url.searchParams.get('id') ?? '';
      const off = url.searchParams.get('off') === '1';
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      const file = join(off ? SKILLS_OFF : SKILLS_DIR, id, 'SKILL.md');
      if (!existsSync(file)) return json(res, 404, { error: 'skill not found' });
      return json(res, 200, { id, path: file, content: readFileSync(file, 'utf8').slice(0, 120000) });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/toggle') {
      const { id, enabled } = await readBody(req);
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      const from = join(enabled ? SKILLS_OFF : SKILLS_DIR, id);
      const to = join(enabled ? SKILLS_DIR : SKILLS_OFF, id);
      if (!existsSync(join(from, 'SKILL.md'))) return json(res, 404, { error: 'skill not found' });
      if (existsSync(to)) return json(res, 400, { error: '目标位置已有同名技能' });
      mkdirSync(SKILLS_OFF, { recursive: true });
      renameSync(from, to);
      return json(res, 200, { ok: true, skills: listSkills() });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/remove') {
      const { id, off } = await readBody(req);
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      const dir = join(off ? SKILLS_OFF : SKILLS_DIR, id);
      if (!existsSync(join(dir, 'SKILL.md'))) return json(res, 404, { error: 'skill not found' });
      if (!dir.startsWith(SKILLS_DIR)) return json(res, 400, { error: '拒绝删除技能目录之外的路径' });
      rmSync(dir, { recursive: true, force: true });
      return json(res, 200, { ok: true, skills: listSkills() });
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
      writeKey(p, value);
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
        return json(res, 200, { at: p.modelsCache.at, list: p.modelsCache.list, cached: true });
      }
      try {
        const r = await callProvider(p, { method: p.test?.method ?? 'GET', path: p.test?.path });
        if (r.status < 200 || r.status >= 300) {
          return json(res, 200, { error: `HTTP ${r.status}`, list: p.modelsCache?.list ?? [], at: p.modelsCache?.at ?? null });
        }
        const list = parseModelList(r.text);
        p.modelsCache = { at: new Date().toISOString(), list };
        saveRegistry(reg);
        return json(res, 200, { at: p.modelsCache.at, list, cached: false });
      } catch (e) {
        return json(res, 200, { error: String(e.message || e), list: p.modelsCache?.list ?? [], at: p.modelsCache?.at ?? null });
      }
    }

    // ---- save model selection ----
    if (req.method === 'POST' && url.pathname === '/api/models') {
      const { id, selected, defaultModel } = await readBody(req);
      const reg = loadRegistry();
      const p = reg.providers.find((x) => x.id === id);
      if (!p) return json(res, 404, { error: 'unknown provider' });
      const known = new Set((p.modelsCache?.list ?? []).map((m) => m.id));
      const chosen = Array.isArray(selected) ? selected.filter((m) => known.has(m)) : null;
      if (defaultModel && chosen && !chosen.includes(defaultModel)) {
        return json(res, 400, { error: '默认模型必须在已选模型里' });
      }
      if (chosen) p.selectedModels = chosen; else delete p.selectedModels;
      if (defaultModel) p.defaultModel = defaultModel; else delete p.defaultModel;
      saveRegistry(reg);
      return json(res, 200, { ok: true, ...state() });
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

      const candidates = [base + '/models'];
      if (!/\/v\d+$/i.test(base)) candidates.push(base + '/v1/models');
      candidates.push(base + '/catalog/models?type=image', base + '/catalog/models');

      const tried = [];
      for (const target of [...new Set(candidates)]) {
        try {
          const res2 = await fetch(target, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(20000),
          });
          const text = await res2.text();
          const models = parseModelList(text);
          tried.push({ path: target.replace(base, ''), status: res2.status, count: models.length });
          if (res2.ok && models.length) {
            return json(res, 200, { ok: true, path: target.replace(base, ''), models, tried });
          }
        } catch (e) {
          tried.push({ path: target.replace(base, ''), status: 0, error: String(e.message || e) });
        }
      }
      return json(res, 200, { ok: false, error: '没有探测到模型列表', tried });
    }

    // ---- discovery: what is already on this machine ----
    if (req.method === 'GET' && url.pathname === '/api/discover') {
      return json(res, 200, discover());
    }

    if (req.method === 'POST' && url.pathname === '/api/discover/import') {
      const body = await readBody(req);
      const reg = loadRegistry();
      try {
        const provider = importDiscovered(reg, body);
        return json(res, 200, { ok: true, provider: providerView(reg, provider), ...state() });
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/import') {
      const { from, id } = await readBody(req);
      if (!isSafeName(id)) return json(res, 400, { error: 'bad id' });
      const src = resolve(String(from || ''));
      const root = otherSkillRoots().find((entry) => src.startsWith(resolve(entry.dir) + sep));
      if (!root) return json(res, 400, { error: '只能从已知的技能目录导入' });
      if (!existsSync(join(src, 'SKILL.md'))) return json(res, 404, { error: '源目录里没有 SKILL.md' });
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
      const entry = {
        id,
        name: String(body.name ?? '').trim() || host,
        kind: body.kind === 'image' ? 'image' : 'llm',
        tag: body.kind === 'image' ? '图片' : '文本',
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
      writeKey(entry, key);
      reg.providers.push(entry);
      saveRegistry(reg);
      return json(res, 200, { ok: true, id, ...state() });
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
