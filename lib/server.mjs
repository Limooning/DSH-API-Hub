// API Hub — local panel to manage and call API providers.
// No dependencies. Binds 127.0.0.1 only.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, renameSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
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

/** DSH only lists a skill when its SKILL.md carries frontmatter with both a
 *  name and a description, so a directory without them is not offered. */
function readSkillFrontmatter(file) {
  try { return parseFrontmatter(readFileSync(file, 'utf8')); } catch { return {}; }
}
const isDshSkill = (fm) => Boolean(fm && fm.name && fm.description);

function skillsFrom(base, enabled) {
  if (!existsSync(base)) return [];
  const out = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = join(base, e.name);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = readSkillFrontmatter(file);
    const st = statSync(file);
    const { files, bytes } = skillStats(dir);
    out.push({
      id: e.name,
      name: fm.name || e.name,
      description: String(fm.description ?? '').slice(0, 260),
      dshFormat: isDshSkill(fm),
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
 * Skills are only taken from directories the user adds by hand. DSH's own
 * `~/.dsh/skills` is what the panel already manages, and other agents' skill
 * folders (`~/.codex/skills`, `~/.claude/skills`, …) are deliberately not
 * scanned: their skills are written for those tools, not for DSH.
 */
function otherSkillRoots() {
  return loadSources().skillDirs
    .filter((dir) => existsSync(dir))
    .map((dir) => ({ source: 'custom', dir }));
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
    for (const skill of skillsFrom(root.dir, true)) {
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
      skills: loadSources().skillDirs.map((dir) => dir.replace(homedir(), "~")),
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

const KEY_FIELD = /^(api[-_]?key|apikey|access[-_]?key|access[-_]?token|secret[-_]?key|auth[-_]?token|auth[-_]?key|bearer|authorization|token)$/i;
const URL_FIELD = /^(base[-_]?url|base_?uri|api[-_]?base|apiurl|endpoint|host|url)$/i;
// Skip vendored trees, caches, this hub's own data (its registry stores masked
// keys only, but scanning it would just re-list what is already managed), and
// other coding agents' folders — their configs are not DSH endpoints.
const SCAN_SKIP = /[\\/](node_modules|\.git|dist|build|out|coverage|logs?|caches?|Cache|GPUCache|attachments|sessions|blobs|objects|tmp|temp|keys|\.codex|\.claude|\.agents|\.cursor|\.continue|\.aider)[\\/]/i;
const MAX_SCAN_BYTES = 256 * 1024;
const MAX_SCAN_HITS = 24;

function scanRoots() {
  // Home itself is included (depth-limited) so a tool that drops `~/.openai.json`
  // or `~/mytool/config.json` is still found; heavy trees are skipped by SCAN_SKIP.
  const roots = [homedir(), join(homedir(), '.config'), join(homedir(), '.dsh')];
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA));           // Windows roaming
  if (process.env.XDG_CONFIG_HOME) roots.push(process.env.XDG_CONFIG_HOME); // explicit XDG
  if (process.platform === 'darwin') roots.push(join(homedir(), 'Library', 'Application Support'));
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

function scanJsonCredentials(reg) {
  const usedRefs = new Set(reg.providers
    .filter((p) => p.keySource?.type === 'json')
    .map((p) => expandHome(p.keySource.path).toLowerCase() + '#' + (p.keySource.jsonPath || []).map(String).join('.')));
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
      if (!/\.json$/i.test(entry.name)) continue;
      if (/^(package|package-lock|tsconfig|composer)\.json$/i.test(entry.name)) continue;
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      if (size > MAX_SCAN_BYTES) continue;
      let doc;
      try { doc = JSON.parse(readFileSync(full, 'utf8')); } catch { continue; }
      collectKeyHits(doc, full, [], hits);
    }
  };

  for (const root of scanRoots()) walk(root, 0);

  return hits.filter((hit) => {
    const tag = hit.path.toLowerCase() + '#' + hit.jsonPath.map(String).join('.');
    return !usedRefs.has(tag);
  }).map((hit) => {
    // Configs often store only the key; fall back to a path-based guess so the
    // row arrives with a usable Base URL instead of an empty box.
    const hint = hit.baseURL ? null : presetFromPath(hit.path);
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
  try { value = jsonGet(JSON.parse(readFileSync(target.path, 'utf8')), target.jsonPath); } catch { /* unreadable */ }
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
 */
async function verifyEndpoint(baseURL, key) {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Base URL 必须以 http(s):// 开头', tried: [] };
  if (!String(key || '').trim()) return { ok: false, error: '没有读到 Key', tried: [] };

  const candidates = [base + '/models'];
  if (!/\/v\d+$/i.test(base)) candidates.push(base + '/v1/models');
  candidates.push(base + '/catalog/models?type=image', base + '/catalog/models');

  const tried = [];
  const started = Date.now();
  for (const target of [...new Set(candidates)]) {
    try {
      const res2 = await fetch(target, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
      const text = await res2.text();
      const models = parseModelList(text);
      tried.push({ path: target.replace(base, ''), status: res2.status, count: models.length });
      // 2xx on any candidate means the address and the key both work; an empty
      // model list is still a reachable API (some relays only serve one model).
      if (res2.ok) {
        return { ok: true, path: target.replace(base, ''), status: res2.status, models, ms: Date.now() - started, tried };
      }
    } catch (e) {
      tried.push({ path: target.replace(base, ''), status: 0, error: String(e.message || e) });
    }
  }
  return { ok: false, error: explainAttempts(tried), ms: Date.now() - started, tried };
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
  const finalKind = (kind || preset?.kind) === 'image' ? 'image' : 'llm';
  const provider = {
    id: uniqueProviderId(reg, finalName),
    name: finalName,
    kind: finalKind,
    tag: finalKind === 'image' ? '图片' : '文本',
    enabled: true,
    baseURL: base,
    protocol: protocol || preset?.protocol || 'OpenAI Chat Completions',
    notes: '自动检索导入',
    keySource: resolved.keySource,
    test: { method: 'GET', path: '/models' },
    // The check just pulled a model list, so the card has models from minute one.
    modelsCache: check.models.length ? { at: new Date().toISOString(), list: check.models } : undefined,
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
      if (!root) return json(res, 400, { error: '只能从手动添加的技能目录导入' });
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
