// Smoke tests for the panel backend.
//
// The backend resolves its data directory through os.homedir(), so every test
// runs the handler in a child process with a throwaway HOME. That keeps the
// developer's real ~/.dsh/api-hub/providers.json untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_URL = pathToFileURL(fileURLToPath(new URL("../lib/server.mjs", import.meta.url))).href;

const PROBE = `
import { handleRequest } from ${JSON.stringify(SERVER_URL)};
const call = async (path) => {
  const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  const req = { method: "GET", url: path, headers: {}, on(event, cb) { if (event === "end") cb(); return this; } };
  await handleRequest(req, res, "");
  return { code: res.code, body: res.body };
};
const out = {};
for (const path of ["/api/health", "/api/state", "/api/skills", "/api/nope"]) out[path] = await call(path);
console.log("PROBE " + JSON.stringify(out));
`;

// A directory a child process just released can still be locked for a moment on
// Windows, and an interrupted run leaves its throwaway home behind. Sweeping at
// start keeps those from piling up in %TEMP%; anything young enough to belong to
// a concurrent run is left alone.
function sweepStaleHomes() {
  const scratch = fileURLToPath(new URL("./.tmp/", import.meta.url));
  const cutoff = Date.now() - 120_000;
  const sweep = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (prefix && !entry.startsWith(prefix)) continue;
      const path = join(dir, entry);
      try {
        if (statSync(path).mtimeMs > cutoff) continue;
        rmSync(path, { recursive: true, force: true });
      } catch { /* still open: the next run picks it up */ }
    }
  };
  sweep(tmpdir(), "api-hub-test-");
  sweep(tmpdir(), "api-hub-verify-");
  sweep(tmpdir(), "api-hub-formats-");
  sweep(scratch, "");
}
sweepStaleHomes();

function probeInFreshHome() {
  const home = mkdtempSync(join(tmpdir(), "api-hub-test-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", PROBE], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "probe failed:\n" + result.stderr);
  const line = result.stdout.split("\n").find((row) => row.startsWith("PROBE "));
  assert.ok(line, "probe produced no result:\n" + result.stdout);
  return { home, out: JSON.parse(line.slice("PROBE ".length)) };
}

test("a fresh home gets a seeded registry and healthy routes", () => {
  const { home, out } = probeInFreshHome();
  try {
    assert.equal(out["/api/health"].code, 200);
    assert.equal(JSON.parse(out["/api/health"].body).ok, true);

    assert.equal(out["/api/state"].code, 200);
    const state = JSON.parse(out["/api/state"].body);
    assert.equal(state.providers.length, 1, "the example registry ships one provider");
    assert.equal(state.providers[0].id, "deepseek-api");
    assert.equal(state.providers[0].kind, "llm");
    assert.equal(state.defaults.llm, "deepseek-api");

    // No ~/.dsh/skills on a fresh machine must stay a 200 with an empty list.
    assert.equal(out["/api/skills"].code, 200);
    assert.deepEqual(JSON.parse(out["/api/skills"].body).skills, []);

    assert.equal(existsSync(join(home, ".dsh", "api-hub", "providers.json")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the seeded registry is a copy of the bundled example", () => {
  const { home, out } = probeInFreshHome();
  try {
    const seeded = JSON.parse(readFileSync(join(home, ".dsh", "api-hub", "providers.json"), "utf8"));
    const example = JSON.parse(readFileSync(new URL("../providers.example.json", import.meta.url), "utf8"));
    assert.deepEqual(seeded.providers.map((p) => p.id), example.providers.map((p) => p.id));
    assert.equal(seeded.providers.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown routes answer 404 instead of crashing", () => {
  const { home, out } = probeInFreshHome();
  try {
    assert.equal(out["/api/nope"].code, 404);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A discovered endpoint must be callable before it may enter the registry, so
// this test spins up a throwaway relay that only answers with the right key.
const VERIFY = `
import http from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleRequest } from ${JSON.stringify(SERVER_URL)};

const relay = http.createServer((req, res) => {
  if (!req.url.startsWith("/v1/models")) { res.writeHead(404); return res.end("{}"); }
  const ok = req.headers.authorization === "Bearer good-key";
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(ok ? JSON.stringify({ data: [{ id: "probe-a" }, { id: "probe-b" }] }) : "{}");
});
await new Promise((done) => relay.listen(0, "127.0.0.1", done));
const port = relay.address().port;

const panel = http.createServer(async (req, res) => {
  try { await handleRequest(req, res, ""); } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((done) => panel.listen(0, "127.0.0.1", done));

const home = process.env.USERPROFILE || process.env.HOME;
const file = join(home, "relay-config.json");
writeFileSync(file, JSON.stringify({ relay: { apiKey: "good-key" }, wrong: { apiKey: "bad-key" } }));

const api = async (path, body) => {
  const res = await fetch("http://127.0.0.1:" + panel.address().port + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { code: res.status, body: await res.json() };
};

const base = "http://127.0.0.1:" + port + "/v1";
const good = { source: "file", path: file, jsonPath: ["relay", "apiKey"], baseURL: base };
const out = {
  verifyOk: await api("/api/discover/verify", good),
  verifyBadKey: await api("/api/discover/verify", { ...good, jsonPath: ["wrong", "apiKey"] }),
  verifyBadPath: await api("/api/discover/verify", { ...good, baseURL: "http://127.0.0.1:" + port + "/nope" }),
  importBadKey: await api("/api/discover/import", { ...good, jsonPath: ["wrong", "apiKey"], name: "坏 Key" }),
  importOk: await api("/api/discover/import", { ...good, name: "验证中转" }),
};
relay.close(); panel.close();
console.log("VERIFY " + JSON.stringify(out));
`;

function verifyInFreshHome() {
  const home = mkdtempSync(join(tmpdir(), "api-hub-verify-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", VERIFY], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "verify probe failed:\n" + result.stderr);
  const line = result.stdout.split("\n").find((row) => row.startsWith("VERIFY "));
  assert.ok(line, "verify probe produced no result:\n" + result.stdout);
  return { home, out: JSON.parse(line.slice("VERIFY ".length)) };
}

test("a live call decides whether a discovered endpoint can be imported", () => {
  const { home, out } = verifyInFreshHome();
  try {
    assert.equal(out.verifyOk.code, 200);
    assert.equal(out.verifyOk.body.ok, true);
    assert.deepEqual(out.verifyOk.body.models.map((m) => m.id), ["probe-a", "probe-b"]);

    assert.equal(out.verifyBadKey.body.ok, false);
    assert.match(out.verifyBadKey.body.error, /401/);

    assert.equal(out.verifyBadPath.body.ok, false);
    assert.match(out.verifyBadPath.body.error, /Base URL/);

    assert.equal(out.importBadKey.code, 400);
    assert.match(out.importBadKey.body.error, /调不通/);

    assert.equal(out.importOk.code, 200);
    assert.equal(out.importOk.body.provider.cachedCount, 2);

    // The provider must point at the original file instead of copying the secret.
    const reg = JSON.parse(readFileSync(join(home, ".dsh", "api-hub", "providers.json"), "utf8"));
    const added = reg.providers.find((p) => p.name === "验证中转");
    assert.ok(added, "the verified provider was written");
    assert.equal(added.keySource.type, "json");
    assert.equal(added.keySource.path, join(home, "relay-config.json"));
    assert.equal(reg.providers.some((p) => p.name === "坏 Key"), false, "a dead endpoint is never written");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Other tools write TOML / .env rather than JSON, and some relays want the key in
// `x-api-key` instead of `Authorization`. Both have to survive the round trip:
// scan → import → a real call through the panel.
const FORMATS = `
import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleRequest } from ${JSON.stringify(SERVER_URL)};

const bearerKey = "sk-toml-key-0000000001";
const xkeyKey = "sk-xkeykey-00000000002";

const bearer = http.createServer((req, res) => {
  const ok = req.headers.authorization === "Bearer " + bearerKey;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: ok ? [{ id: "toml-a" }, { id: "toml-b" }] : [] }));
});
const xkey = http.createServer((req, res) => {
  const ok = req.headers["x-api-key"] === xkeyKey;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: ok ? [{ id: "xkey-a" }] : [] }));
});
await new Promise((done) => bearer.listen(0, "127.0.0.1", done));
await new Promise((done) => xkey.listen(0, "127.0.0.1", done));

const panel = http.createServer(async (req, res) => {
  try { await handleRequest(req, res, ""); } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((done) => panel.listen(0, "127.0.0.1", done));

const home = process.env.USERPROFILE || process.env.HOME;
const mkdir = (rel) => { const dir = join(home, rel); mkdirSync(dir, { recursive: true }); return dir; };
const write = (rel, body) => { const file = join(home, rel); writeFileSync(file, body, "utf8"); return file; };

// The automatic pass only looks inside DSH's own data dir, so the fixtures live
// under ~/.dsh — that is the folder a user cannot be expected to comb by hand.
mkdir(".dsh/relay");
mkdir(".dsh/relay/extra");
const toml = write(".dsh/relay/config.toml",
  "[api]\\nbase_url = \\"http://127.0.0.1:" + bearer.address().port + "/v1\\"  # base url\\napi_key = \\"" + bearerKey + "\\"\\n");
// The same secret, second copy in a longer path: the scan must collapse it.
write(".dsh/relay/extra/copy.json", JSON.stringify({ api_key: bearerKey }));
// A template is not a credential.
write(".dsh/.env.example", "OPENAI_API_KEY=sk-example-key-0000000000\\n");
const envFile = write(".dsh/relay/.relay-xkey.env", "RELAY_API_KEY=" + xkeyKey + "\\n");

const api = async (path, body) => {
  const res = await fetch("http://127.0.0.1:" + panel.address().port + path, {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { code: res.status, body: await res.json() };
};

const bearerBase = "http://127.0.0.1:" + bearer.address().port + "/v1";
const xkeyBase = "http://127.0.0.1:" + xkey.address().port + "/v1";

const found = await api("/api/discover");
const auto = found.body.auto;
const tomlHit = auto.find((h) => h.path.endsWith("config.toml"));
const xkeyHit = auto.find((h) => h.path.endsWith(".relay-xkey.env"));

const imported = await api("/api/discover/import", {
  source: "file", path: toml, jsonPath: tomlHit.jsonPath, baseURL: bearerBase, name: "TOML 中转",
});
const importedX = await api("/api/discover/import", {
  source: "file", path: envFile, jsonPath: xkeyHit.jsonPath, baseURL: xkeyBase, name: "x-api-key 中转",
});
const tested = await api("/api/test", { id: importedX.body.provider.id });
const rewrote = await api("/api/key", { id: imported.body.provider.id, key: "sk-attempt-to-write-000000" });
const state = await api("/api/state");

bearer.close(); xkey.close(); panel.close();
console.log("FORMATS " + JSON.stringify({
  autoPaths: auto.map((h) => h.path),
  tomlHit: Boolean(tomlHit), xkeyHit: Boolean(xkeyHit),
  imported, importedX, tested, rewrote,
  providers: state.body.providers.map((p) => ({ name: p.name, keyPresent: p.keyPresent, cachedCount: p.cachedCount })),
}));
`;

function formatsInFreshHome() {
  // The scanner deliberately skips anything under a `temp` directory, so this
  // home is built inside the repo instead of os.tmpdir().
  const scratch = fileURLToPath(new URL("./.tmp/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "formats-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", FORMATS], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "formats probe failed:\n" + result.stderr);
  const line = result.stdout.split("\n").find((row) => row.startsWith("FORMATS "));
  assert.ok(line, "formats probe produced no result:\n" + result.stdout);
  return { home, out: JSON.parse(line.slice("FORMATS ".length)) };
}

test("TOML and .env sources import, survive a dedupe, and remember the header style", () => {
  const { home, out } = formatsInFreshHome();
  try {
    assert.equal(out.tomlHit, true, "a TOML config is scanned: " + JSON.stringify(out.autoPaths));
    assert.equal(out.xkeyHit, true, "an .env file is scanned: " + JSON.stringify(out.autoPaths));
    assert.equal(out.autoPaths.some((p) => p.endsWith(".env.example")), false, "templates are skipped");
    assert.equal(out.autoPaths.some((p) => p.endsWith("copy.json")), false,
      "the same secret in a second file is collapsed: " + JSON.stringify(out.autoPaths));

    assert.equal(out.imported.code, 200, JSON.stringify(out.imported.body));
    assert.equal(out.imported.body.provider.cachedCount, 2);
    assert.equal(out.importedX.code, 200, JSON.stringify(out.importedX.body));

    // The x-api-key style is remembered on the provider and used by real calls.
    const reg = JSON.parse(readFileSync(join(home, ".dsh", "api-hub", "providers.json"), "utf8"));
    const added = reg.providers.find((p) => p.name === "x-api-key 中转");
    assert.equal(added.auth, "x-api-key");
    assert.equal(out.tested.body.ok, true, JSON.stringify(out.tested.body));

    // A TOML file is never rewritten: the panel would destroy its comments.
    assert.equal(out.rewrote.code, 400);
    assert.match(out.rewrote.body.error, /只读不写/);

    const listed = out.providers.find((p) => p.name === "TOML 中转");
    assert.equal(listed.keyPresent, true, "the key is still readable after import");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the model list decides whether an endpoint is a chat or a media API", async () => {
  const { classifyKind } = await import(SERVER_URL);

  const image = classifyKind([
    "image:gpt-image-2-5-flare-official",
    "image:gpt-image-2.5-sunburst-adobe",
    "gpt-image-2.5-sunburst",
  ]);
  assert.equal(image.kind, "image", JSON.stringify(image));
  assert.equal(image.media, 3);
  assert.equal(image.known, true);

  const chat = classifyKind([{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }, "gpt-4o-mini"]);
  assert.equal(chat.kind, "llm", JSON.stringify(chat));

  // A relay reselling one image model among several chat models is still a chat API.
  const mixed = classifyKind(["qwen3.8-max", "qwen-vl-max", "qwen-image", "text-embedding-3-small"]);
  assert.equal(mixed.kind, "llm", JSON.stringify(mixed));
  assert.equal(mixed.media, 1);
  assert.equal(mixed.chat, 2, "embeddings are not chat models");

  const unknown = classifyKind([]);
  assert.equal(unknown.kind, "llm");
  assert.equal(unknown.known, false);

  // An endpoint that sells both is both kinds, and each is labelled by its name.
  const both = classifyKind(["deepseek-chat", "gpt-4o", "gpt-image-2", "sora-2", "text-embedding-3-small"]);
  assert.deepEqual(both.kinds, ["llm", "image"], JSON.stringify(both));
  assert.equal(both.counts.llm, 2);
  assert.equal(both.counts.image, 1);
  assert.equal(both.counts.video, 1, "sora counts as video, not chat");
  assert.equal(both.counts.embedding, 1);
});
