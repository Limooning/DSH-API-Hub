// A small YAML reader for the shapes a model config actually uses: block
// mappings, block sequences, quoted and plain scalars, flow arrays/objects and
// the `|` / `>` scalars. Anchors, aliases, tags and multi-document streams are
// out of scope on purpose — if a file needs them we say so instead of guessing.

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);

function stripComment(text) {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text;
}

function scalar(raw) {
  const text = String(raw).trim();
  if (!text) return null;
  if (NULLS.has(text)) return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;
  if ((text.startsWith('"') && text.endsWith('"') && text.length > 1) || (text.startsWith("'") && text.endsWith("'") && text.length > 1)) {
    const body = text.slice(1, -1);
    return text[0] === '"' ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body.replace(/''/g, "'");
  }
  if (/^[[{]/.test(text)) return flow(text);
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

// Flow collections: `[a, b]` and `{a: 1, b: {c: 2}}`, commas inside quotes kept.
function flow(text) {
  let at = 0;
  const skip = () => { while (at < text.length && /\s/.test(text[at])) at += 1; };
  const value = () => {
    skip();
    if (text[at] === '[') {
      at += 1;
      const out = [];
      skip();
      if (text[at] === ']') { at += 1; return out; }
      for (;;) {
        out.push(value());
        skip();
        if (text[at] === ',') { at += 1; continue; }
        if (text[at] === ']') { at += 1; return out; }
        throw new Error('flow 数组没有闭合');
      }
    }
    if (text[at] === '{') {
      at += 1;
      const out = {};
      skip();
      if (text[at] === '}') { at += 1; return out; }
      for (;;) {
        skip();
        const key = bareKey();
        skip();
        if (text[at] !== ':') throw new Error('flow 对象缺少冒号');
        at += 1;
        out[key] = value();
        skip();
        if (text[at] === ',') { at += 1; continue; }
        if (text[at] === '}') { at += 1; return out; }
        throw new Error('flow 对象没有闭合');
      }
    }
    if (text[at] === '"' || text[at] === "'") {
      const quote = text[at];
      let out = '';
      at += 1;
      while (at < text.length && text[at] !== quote) {
        if (text[at] === '\\' && quote === '"') { out += text[at + 1]; at += 2; continue; }
        out += text[at];
        at += 1;
      }
      at += 1;
      return out;
    }
    let out = '';
    while (at < text.length && !/[,\]}]/.test(text[at])) { out += text[at]; at += 1; }
    return scalar(out);
  };
  const bareKey = () => {
    let out = '';
    while (at < text.length && !/[:,}]/.test(text[at])) { out += text[at]; at += 1; }
    return String(scalar(out) ?? '');
  };
  return value();
}

function fail(line, message) {
  const error = new Error(`第 ${line} 行：${message}`);
  error.line = line;
  return error;
}

export function parseYaml(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = source.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i].replace(/\s+$/, '');
    if (!raw.trim()) continue;
    if (/^\s*#/.test(raw)) continue;
    if (/^\s*\t/.test(raw) || /^\t/.test(raw)) throw fail(i + 1, '缩进请用空格，不要用 tab');
    const indent = raw.length - raw.replace(/^\s+/, '').length;
    lines.push({ indent, text: stripComment(raw.slice(indent)), line: i + 1, raw, index: i });
  }
  if (!lines.length) return null;
  let at = 0;

  const block = (indent) => (lines[at].text.startsWith('- ') || lines[at].text === '-' ? sequence(indent) : mapping(indent));

  const scalarBlock = (indent, style, headerLine) => {
    const gather = [];
    while (at < lines.length && lines[at].indent > indent) {
      gather.push(rows[lines[at].index].slice(lines[at].indent));
      at += 1;
    }
    if (!gather.length) return '';
    if (style === '|') return gather.join('\n') + '\n';
    return gather.join(' ').replace(/\s+/g, ' ').trim() + '\n';
  };

  const mapping = (indent) => {
    const out = {};
    while (at < lines.length) {
      const row = lines[at];
      if (row.indent < indent) break;
      if (row.indent > indent) throw fail(row.line, '缩进比上一级更深，但没有对应的键');
      if (row.text.startsWith('- ') || row.text === '-') break;
      const match = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(row.text);
      if (!match) throw fail(row.line, '这一行既不是键值对，也不是列表项');
      const key = String(scalar(match[1]) ?? match[1]);
      const rest = (match[2] ?? '').trim();
      at += 1;
      if (rest === '|' || rest === '>') { out[key] = scalarBlock(indent, rest, row.line); continue; }
      if (rest) { out[key] = rest === '[]' ? [] : rest === '{}' ? {} : scalar(rest); continue; }
      if (at < lines.length && (lines[at].indent > indent || (lines[at].indent === indent && (lines[at].text.startsWith('- ') || lines[at].text === '-')))) {
        out[key] = lines[at].indent > indent ? block(lines[at].indent) : sequence(indent);
        continue;
      }
      out[key] = null;
    }
    return out;
  };

  const sequence = (indent) => {
    const out = [];
    while (at < lines.length) {
      const row = lines[at];
      if (row.indent < indent) break;
      if (row.indent > indent) throw fail(row.line, '列表项的缩进不对');
      if (!(row.text.startsWith('- ') || row.text === '-')) break;
      const rest = row.text === '-' ? '' : row.text.slice(2).trim();
      const line = row.line;
      at += 1;
      if (!rest) {
        if (at < lines.length && lines[at].indent > indent) out.push(block(lines[at].indent));
        else out.push(null);
        continue;
      }
      const inline = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(rest);
      if (inline && !/^[[{]/.test(rest)) {
        // `- key: value` opens a mapping whose remaining keys sit at this indent + 2
        const item = {};
        const key = String(scalar(inline[1]) ?? inline[1]);
        const value = (inline[2] ?? '').trim();
        if (value) item[key] = value === '[]' ? [] : value === '{}' ? {} : scalar(value);
        else if (at < lines.length && lines[at].indent > indent + 1) item[key] = block(lines[at].indent);
        else item[key] = null;
        while (at < lines.length && lines[at].indent > indent) {
          const next = lines[at];
          const pair = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(next.text);
          if (!pair) throw fail(next.line, '列表项里这一行不是键值对');
          const k = String(scalar(pair[1]) ?? pair[1]);
          const v = (pair[2] ?? '').trim();
          at += 1;
          if (v) item[k] = v === '[]' ? [] : v === '{}' ? {} : scalar(v);
          else if (at < lines.length && lines[at].indent > next.indent) item[k] = block(lines[at].indent);
          else item[k] = null;
        }
        out.push(item);
        continue;
      }
      out.push(scalar(rest));
      if (at < lines.length && lines[at].indent > indent) throw fail(lines[at].line, '标量列表项后面不该再有更深的内容');
    }
    return out;
  };

  const doc = block(lines[0].indent);
  if (at < lines.length) throw fail(lines[at].line, '这一行没有被解析（缩进对不上）');
  return doc;
}

// ---- models config -> provider candidates -------------------------------------

const PROTOCOLS = new Map([
  ['openai-completions', 'OpenAI 兼容'],
  ['openai-chat-completions', 'OpenAI 兼容'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic-messages', 'Anthropic Messages'],
  ['anthropic', 'Anthropic Messages'],
  ['google-generative-ai', 'Gemini'],
]);

function pickProtocol(entry) {
  const api = String(entry.api ?? entry.protocol ?? '').trim().toLowerCase();
  if (!api) return '';
  return PROTOCOLS.get(api) ?? api;
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.values(value);
  return [];
}

function modelIds(list) {
  return asList(list).map((m) => (typeof m === 'string' ? m : String(m?.id ?? m?.name ?? ''))).filter(Boolean);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const key = String(entry?.id ?? '');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Pull `providers` out of whichever wrapper the file used. */
export function providerEntries(doc) {
  if (!doc || typeof doc !== 'object') return [];
  if (Array.isArray(doc)) {
    // a cordis patch file: rows like `- id: llm-pi-ai` + `config: { providers }`
    const out = [];
    for (const row of doc) {
      if (!row || typeof row !== 'object') continue;
      if (row.id === 'llm-pi-ai') {
        out.push(...providerEntries({ providers: row.config?.providers ?? row.config ?? {} }));
        continue;
      }
      if (row.config && typeof row.config === 'object') out.push(...providerEntries(row.config));
    }
    return dedupe(out);
  }
  const bag = doc.providers ?? doc['llm-pi-ai']?.providers ?? doc['llm-pi-ai'] ?? null;
  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    return Object.entries(bag).map(([id, value]) => ({ id, ...(value && typeof value === 'object' ? value : {}) }));
  }
  // a bare map of `name: { baseURL, models }`
  const flat = Object.entries(doc).filter(([, value]) => value && typeof value === 'object' && (value.baseURL || value.models || value.apiKeyEnv || value.apiKey));
  return flat.map(([id, value]) => ({ id, ...value }));
}

export function candidatesFromYaml(text) {
  const doc = parseYaml(text);
  return providerEntries(doc).map((entry) => {
    const models = modelIds(entry.models ?? entry.modelIDs ?? entry.modelIds);
    const keyEnv = String(entry.apiKeyEnv ?? entry.apiKeyRef ?? entry.keyRef ?? '').trim();
    const inlineKey = String(entry.apiKey ?? entry.key ?? '').trim();
    return {
      id: String(entry.id ?? entry.name ?? '').trim(),
      name: String(entry.displayName ?? entry.name ?? entry.id ?? '').trim(),
      baseURL: String(entry.baseURL ?? entry.baseUrl ?? entry.url ?? '').trim().replace(/\/+$/, ''),
      protocol: pickProtocol(entry),
      headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : null,
      models,
      defaultModel: String(entry.defaultModel ?? models[0] ?? '').trim(),
      keyRef: keyEnv,
      key: inlineKey,
    };
  }).filter((c) => c.baseURL || c.models.length || c.keyRef || c.key);
}
