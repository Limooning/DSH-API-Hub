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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleRequest, useCredentialService, useSettingsService } from ${JSON.stringify(SERVER_URL)};
const home = process.env.USERPROFILE || process.env.HOME;
const call = async (path) => {
  const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  const req = { method: "GET", url: path, headers: {}, on(event, cb) { if (event === "end") cb(); return this; } };
  await handleRequest(req, res, "");
  return { code: res.code, body: res.body };
};
const post = async (path, body) => {
  const payload = JSON.stringify(body);
  const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  const req = {
    method: "POST", url: path, headers: {},
    on(event, cb) { if (event === "data") cb(payload); else if (event === "end") cb(); return this; },
  };
  await handleRequest(req, res, "");
  return { code: res.code, body: res.body };
};
const out = {};
for (const path of ["/api/health", "/api/state", "/api/skills", "/api/nope"]) out[path] = await call(path);
out.rename = null;
out.renameEmpty = null;
out.afterRename = null;
const first = JSON.parse(out["/api/state"].body).providers[0].id;
out.firstId = first;
out.cardRename = await post("/api/providers/rename", { id: first, name: "  我的 中转\\n " });
out.cardRenameEmpty = await post("/api/providers/rename", { id: first, name: " " });
out.cardRenameUnknown = await post("/api/providers/rename", { id: "nope", name: "x" });
out.afterCardRename = await call("/api/state");

// A skill to rename and tag: the smallest SKILL.md DSH would accept.
const skillDir = join(home, ".dsh", "skills", "demo-skill");
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, "SKILL.md"), "---\\nname: demo-skill\\ndescription: 演示技能\\n---\\n\\n正文一行\\n", "utf8");
out.skillRename = await post("/api/skills/rename", { id: "demo-skill", name: "  演示   技能  " });
out.skillRenameEmpty = await post("/api/skills/rename", { id: "demo-skill", name: "  " });
out.skillRenameUnknown = await post("/api/skills/rename", { id: "nope", name: "x" });
out.skillTags = await post("/api/skills/tags", { id: "demo-skill", tags: ["写作", " 写作 ", "图像", ""] });
out.afterTags = await call("/api/skills");
out.tagsFileAfterSet = readFileSync(join(home, ".dsh", "api-hub", "skill-tags.json"), "utf8");
out.skillTagsCleared = await post("/api/skills/tags", { id: "demo-skill", tags: [] });
out.skillTagsUnknown = await post("/api/skills/tags", { id: "nope", tags: ["x"] });

// A second skill, so a saved order has two entries to disagree about.
const skillDir2 = join(home, ".dsh", "skills", "demo-skill-b");
mkdirSync(skillDir2, { recursive: true });
writeFileSync(join(skillDir2, "SKILL.md"), "---\\nname: demo-skill-b\\ndescription: 第二个技能\\n---\\n\\n另一行\\n", "utf8");
out.skillReorder = await post("/api/skills/reorder", { order: ["demo-skill-b", "demo-skill", "ghost"] });
out.afterReorder = await call("/api/skills");
out.orderFile = readFileSync(join(home, ".dsh", "api-hub", "skill-order.json"), "utf8");
out.skillReorderBadType = await post("/api/skills/reorder", { order: "nope" });
out.skillReorderEmpty = await post("/api/skills/reorder", { order: [] });

// Key edits go through DSH's credential service when the host half attaches one.
// The service owns the YAML, so the panel must not touch that file itself — and
// with no service attached it still has to fall back to writing the file.
const credCalls = [];
const fakeService = {
  set: (ref, value) => { credCalls.push({ op: "set", ref, value }); return Promise.resolve(); },
  unset: (ref) => { credCalls.push({ op: "unset", ref }); return Promise.resolve(); },
};
const credsFile = join(home, ".dsh", ".credentials.yaml");
writeFileSync(credsFile, "version: 1\\nrefs:\\n  DEEPSEEK_API_KEY: sk-old-value-000000\\nrecords:\\n", "utf8");
out.healthBeforeAttach = JSON.parse((await call("/api/health")).body).credentials;
useCredentialService(fakeService);
out.healthAfterAttach = JSON.parse((await call("/api/health")).body).credentials;
out.keyViaService = await post("/api/key", { id: "deepseek-api", key: "sk-through-service-111111" });
out.credCalls = credCalls;
out.credsFileAfterServiceWrite = readFileSync(credsFile, "utf8");
useCredentialService(null);
out.healthAfterDetach = JSON.parse((await call("/api/health")).body).credentials;
out.keyViaFile = await post("/api/key", { id: "deepseek-api", key: "sk-through-file-222222" });
out.credsFileAfterFileWrite = readFileSync(credsFile, "utf8");

// A second chat endpoint on a host DSH does not ship itself, so the route
// assertions have something that really becomes a route: the seeded DeepSeek
// provider now resolves to DSH's built-in one and must not add a second row.
out.addRelay = await post("/api/providers/add", {
  name: "Relay",
  baseURL: "https://relay.example/v1",
  key: "sk-relay-333333",
  models: ["relay-large"],
  selected: ["relay-large"],
});

// The panel can also hand these endpoints to DSH itself: every chat endpoint
// becomes a llm-pi-ai route, so the models show up in DSH's own picker. The
// settings section is written through the settings service; without one the
// routes stay untouched and the panel says so.
const settingsCalls = [];
const settingsRemovals = [];
const fakeSettings = {
  // Includes the route an older version of the panel wrote for DeepSeek, so the
  // retirement path has something real to remove.
  read: () => ({
    providers: {
      keepme: { displayName: "keep" },
      "deepseek-api": {
        displayName: "DeepSeek 官方",
        baseURL: "https://api.deepseek.com",
        api: "openai-completions",
        apiKeyEnv: "APIHUB_DEEPSEEK_API_KEY",
        models: [{ id: "deepseek-flash" }],
      },
    },
  }),
  // Mirrors DSH: update merges a layer, so leaving a key out cannot delete it;
  // only the unset op removes one.
  update: (patch) => { settingsCalls.push(patch); return Promise.resolve(); },
  remove: (ids) => { settingsRemovals.push(ids); return Promise.resolve(); },
};
out.planBeforeAttach = JSON.parse((await call("/api/dsh/plan")).body);
out.syncNoService = await post("/api/dsh/sync", {});
useCredentialService(fakeService);
useSettingsService(fakeSettings);
out.planAfterAttach = JSON.parse((await call("/api/dsh/plan")).body);
out.sync = await post("/api/dsh/sync", {});
out.settingsCalls = settingsCalls;
out.settingsRemovals = settingsRemovals;
useSettingsService(null);
useCredentialService(null);

// Nobody presses a button for this any more: the page compares the section with
// the registry and writes only on drift, so the two lists cannot disagree. The
// panel owns exactly the ids it wrote — a hand-registered route survives, one
// whose provider got disabled leaves, and an unchanged section stays quiet.
let section = { providers: { keepme: { displayName: "keep", api: "openai-completions", baseURL: "https://keep/v1", apiKeyEnv: "KEEP_KEY", models: [{ id: "keep-1" }] } } };
const pageCalls = [];
const pageRemovals = [];
const fakePage = {
  read: () => ({ providers: section.providers }),
  update: (patch) => { pageCalls.push(patch); section = { providers: { ...section.providers, ...patch.providers } }; return Promise.resolve(); },
  remove: (ids) => {
    pageRemovals.push(ids);
    for (const id of ids) delete section.providers[id];
    return Promise.resolve();
  },
};
useCredentialService(fakeService);
useSettingsService(fakePage);
out.planDrifted = JSON.parse((await call("/api/dsh/plan")).body);
out.syncDrifted = await post("/api/dsh/sync", {});
out.planClean = JSON.parse((await call("/api/dsh/plan")).body);
out.ownedFile = readFileSync(join(home, ".dsh", "api-hub", "dsh-routes.json"), "utf8");
out.sectionAfterSync = Object.keys(section.providers);
out.pageRemovals = pageRemovals;
out.disabled = await post("/api/enabled", { id: "relay", enabled: false });
out.planStale = JSON.parse((await call("/api/dsh/plan")).body);
out.syncEmpty = await post("/api/dsh/sync", {});
out.sectionAfterPrune = Object.keys(section.providers);
out.planAfterPrune = JSON.parse((await call("/api/dsh/plan")).body);
out.reenabled = await post("/api/enabled", { id: "relay", enabled: true });
useSettingsService(null);
useCredentialService(null);

out.skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf8");
out.tagsFile = readFileSync(join(home, ".dsh", "api-hub", "skill-tags.json"), "utf8");

// A tag is a shared filing label, not a property of one card: renaming it must
// reach every skill carrying it, and a name that already exists must merge.
out.skillTagsBoth = await post("/api/skills/tags", { id: "demo-skill", tags: ["写作", "图像"] });
out.skillTagsOther = await post("/api/skills/tags", { id: "demo-skill-b", tags: ["写作", "设计"] });
out.tagRename = await post("/api/skills/tags/rename", { from: "写作", to: "码字" });
out.afterTagRename = await call("/api/skills");
out.tagsFileAfterRename = readFileSync(join(home, ".dsh", "api-hub", "skill-tags.json"), "utf8");
out.tagRenameMerge = await post("/api/skills/tags/rename", { from: "码字", to: "设计" });
out.tagsFileAfterMerge = readFileSync(join(home, ".dsh", "api-hub", "skill-tags.json"), "utf8");
out.tagRenameEmpty = await post("/api/skills/tags/rename", { from: "设计", to: "  " });
out.tagRenameNoFrom = await post("/api/skills/tags/rename", { from: "", to: "x" });
out.tagRenameUnknown = await post("/api/skills/tags/rename", { from: "没有这个标签", to: "x" });
out.tagRenameSame = await post("/api/skills/tags/rename", { from: "设计", to: "设计" });

// The roots DSH itself walks: a project workspace, the shared ~/.agents folder,
// a bare single-file skill, and a name DSH would refuse to load.
const agents = join(home, ".agents", "skills");
mkdirSync(join(agents, "agents-demo"), { recursive: true });
writeFileSync(join(agents, "agents-demo", "SKILL.md"), "---\\nname: agents-demo\\ndescription: 共享技能\\n---\\n\\n正文\\n", "utf8");
writeFileSync(join(agents, "lone-skill.md"), "---\\nname: lone-skill\\ndescription: 单文件技能\\n---\\n\\n正文\\n", "utf8");
const project = join(home, "proj");
mkdirSync(join(project, ".git"), { recursive: true });
mkdirSync(join(project, ".dsh", "skills", "proj-demo"), { recursive: true });
writeFileSync(join(project, ".dsh", "skills", "proj-demo", "SKILL.md"), "---\\nname: proj-demo\\ndescription: 项目技能\\n---\\n\\n正文\\n", "utf8");
mkdirSync(join(home, ".dsh", "storages"), { recursive: true });
writeFileSync(join(home, ".dsh", "storages", "workspace.json"), JSON.stringify({ tables: { workspaces: { w1: { path: project, title: "proj" } } } }), "utf8");
mkdirSync(join(home, ".dsh", "skills", "Odd_Name"), { recursive: true });
writeFileSync(join(home, ".dsh", "skills", "Odd_Name", "SKILL.md"), "---\\nname: Odd_Name\\ndescription: 名字不合规\\n---\\n\\n正文\\n", "utf8");
out.roots = await call("/api/skills");
out.toggleAgents = await post("/api/skills/toggle", { id: "agents-demo", enabled: false });
out.removeAgents = await post("/api/skills/remove", { id: "agents-demo" });
console.log("PROBE " + JSON.stringify(out));
`;

// Four edges that only show up when the same endpoint changes owner: a provider
// that gets no route of its own must still land its key, a reference nobody
// points at must be swept, an endpoint can opt into a route of its own, and a
// route this DSH cannot prune must stay owned instead of being forgotten.
const EDGES = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleRequest, useCredentialService, useSettingsService } from ${JSON.stringify(SERVER_URL)};
const home = process.env.USERPROFILE || process.env.HOME;
const call = async (path) => {
  const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  const req = { method: "GET", url: path, headers: {}, on(event, cb) { if (event === "end") cb(); return this; } };
  await handleRequest(req, res, "");
  return { code: res.code, body: res.body };
};
const post = async (path, body) => {
  const payload = JSON.stringify(body);
  const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  const req = {
    method: "POST", url: path, headers: {},
    on(event, cb) { if (event === "data") cb(payload); else if (event === "end") cb(); return this; },
  };
  await handleRequest(req, res, "");
  return { code: res.code, body: res.body };
};
const out = {};
const dataDir = join(home, ".dsh", "api-hub");
const keysDir = join(dataDir, "keys");
const credsFile = join(home, ".dsh", ".credentials.yaml");
const regFile = join(dataDir, "providers.json");
const ownedFile = join(dataDir, "dsh-routes.json");
mkdirSync(keysDir, { recursive: true });

// The store already holds DSH's own key, plus a reference 0.8.5 left behind.
writeFileSync(credsFile, "version: 1\\nrefs:\\n  DEEPSEEK_API_KEY: sk-dsh\\n  APIHUB_LEFTOVER_API_KEY: sk-old\\nrecords:\\n", "utf8");
writeFileSync(join(keysDir, "deepseek.json"), JSON.stringify({ key: "sk-panel" }), "utf8");

// The registry appears on the first request, seeded from the bundled example.
await call("/api/state");
const reg = JSON.parse(readFileSync(regFile, "utf8"));
reg.providers = [{
  id: "deepseek-api",
  name: "DeepSeek 官方",
  kind: "llm",
  baseURL: "https://api.deepseek.com",
  protocol: "openai",
  enabled: true,
  keySource: { type: "json", path: join(keysDir, "deepseek.json"), jsonPath: ["key"] },
  selectedModels: ["deepseek-chat"],
  defaultModel: "deepseek-chat",
}];
reg.defaults = { llm: "deepseek-api", image: null };
writeFileSync(regFile, JSON.stringify(reg, null, 2), "utf8");

const sets = [];
const unsets = [];
const updates = [];
// Behaves like the real store: a write is visible to the next read, and an
// unset really removes the reference, so the sweep is exercised end to end.
const setRef = (ref, value) => {
  const text = readFileSync(credsFile, "utf8");
  const line = "  " + ref + ": " + value;
  const rows = text.split("\\n");
  const at = rows.findIndex((row) => row.startsWith("  " + ref + ":"));
  if (at === -1) rows.splice(rows.indexOf("refs:") + 1, 0, line);
  else rows[at] = line;
  writeFileSync(credsFile, rows.join("\\n"), "utf8");
};
const unsetRef = (ref) => {
  const rows = readFileSync(credsFile, "utf8").split("\\n").filter((row) => !row.startsWith("  " + ref + ":"));
  writeFileSync(credsFile, rows.join("\\n"), "utf8");
};
const service = {
  set: (ref, value) => { sets.push([ref, value]); setRef(ref, value); return Promise.resolve(); },
  unset: (ref) => { unsets.push(ref); unsetRef(ref); return Promise.resolve(); },
};
useCredentialService(service);
useSettingsService({
  read: () => ({ providers: {} }),
  update: (patch) => { updates.push(patch); return Promise.resolve(); },
  remove: () => Promise.resolve(),
});

// No route, but the key still has to reach the store that DSH reads.
out.carriedPlan = JSON.parse((await call("/api/dsh/plan")).body);
out.carriedSync = JSON.parse((await post("/api/dsh/sync", {})).body);
out.keyPresent = (JSON.parse((await call("/api/state")).body).providers[0] || {}).keyPresent;
out.carriedSets = sets.slice();
out.carriedUnsets = unsets.slice();
out.ownedAfterCarried = existsSync(ownedFile) ? JSON.parse(readFileSync(ownedFile, "utf8")).ids : [];

// Same endpoint, but the user wants a row of its own.
out.routeOwn = (await post("/api/providers/route", { id: "deepseek-api", own: true })).code;
out.ownPlan = JSON.parse((await call("/api/dsh/plan")).body);
out.ownSync = JSON.parse((await post("/api/dsh/sync", {})).body);
out.ownRef = (updates.at(-1)?.providers?.["deepseek-api"] || {}).apiKeyEnv || "";

// Removing it must not take DSH's own key with it, but its own reference goes.
unsets.length = 0;
out.removed = (await post("/api/providers/remove", { id: "deepseek-api" })).code;
out.removeUnsets = unsets.slice();

// A route this DSH cannot prune: ownership has to survive, not be forgotten.
writeFileSync(regFile, JSON.stringify({
  version: reg.version ?? 1,
  defaults: { llm: "relay", image: null },
  providers: [{
    id: "relay",
    name: "中转",
    kind: "llm",
    baseURL: "https://relay.example.com/v1",
    protocol: "openai",
    enabled: true,
    keySource: { type: "json", path: join(keysDir, "relay.json"), jsonPath: ["key"] },
    selectedModels: ["relay-large"],
    defaultModel: "relay-large",
  }],
}, null, 2), "utf8");
writeFileSync(join(keysDir, "relay.json"), JSON.stringify({ key: "sk-relay" }), "utf8");
writeFileSync(ownedFile, JSON.stringify({ ids: ["gone", "relay"] }, null, 2), "utf8");
useCredentialService(service);
useSettingsService({
  // The stale row is really in the section, and this service cannot unset a
  // key: the panel wants it gone but cannot make it so, so ownership must not
  // say otherwise.
  read: () => ({ providers: { gone: { displayName: "gone" }, relay: { displayName: "relay" } } }),
  update: () => Promise.resolve(),
});
out.stuckSync = JSON.parse((await post("/api/dsh/sync", {})).body);
out.ownedAfterStuck = JSON.parse(readFileSync(ownedFile, "utf8")).ids;
useSettingsService(null);
useCredentialService(null);
console.log("EDGES " + JSON.stringify(out));
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

function probeInFreshHome(source = PROBE, tag = "PROBE") {
  const home = mkdtempSync(join(tmpdir(), "api-hub-test-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: join(home, ".dsh"), DSH_AGENTS_HOME: join(home, ".agents") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "probe failed:\n" + result.stderr);
  const line = result.stdout.split("\n").find((row) => row.startsWith(tag + " "));
  assert.ok(line, "probe produced no result:\n" + result.stdout);
  return { home, out: JSON.parse(line.slice(tag.length + 1)) };
}

test("a fresh home gets a seeded registry and healthy routes", () => {
  const { home, out } = probeInFreshHome();
  try {
    assert.equal(out["/api/health"].code, 200);
    assert.equal(JSON.parse(out["/api/health"].body).ok, true);

    // The panel reports both versions in play: DSH's own `engines.dsh` check
    // refuses an install it does not satisfy, so the page must be able to say
    // the same thing before the user hits the failure.
    const health = JSON.parse(out["/api/health"].body);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(health.plugin.version, manifest.version);
    assert.equal(health.dsh.requires, manifest.engines.dsh);
    assert.equal(typeof health.dsh.version === "string" || health.dsh.version === null, true);
    assert.equal([true, false, null].includes(health.dsh.compatible), true);

    assert.equal(out["/api/state"].code, 200);
    const state = JSON.parse(out["/api/state"].body);
    assert.equal(state.providers.length, 1, "the example registry ships one provider");
    assert.equal(state.providers[0].id, "deepseek-api");
    assert.equal(state.providers[0].kind, "llm");
    assert.equal(state.defaults.llm, "deepseek-api");

    // No ~/.dsh/skills on a fresh machine must stay a 200 with an empty list.
    assert.equal(out["/api/skills"].code, 200);
    assert.deepEqual(JSON.parse(out["/api/skills"].body).skills, []);

    // A card title is the user's label for that endpoint, not an identifier:
    // rename it, keep the id, and refuse blank or unknown ones.
    assert.equal(out.cardRename.code, 200);
    assert.equal(JSON.parse(out.cardRename.body).name, "我的 中转");
    assert.equal(JSON.parse(out.afterCardRename.body).providers[0].name, "我的 中转");
    assert.equal(JSON.parse(out.afterCardRename.body).providers[0].id, out.firstId);
    assert.equal(out.cardRenameEmpty.code, 400);
    assert.equal(out.cardRenameUnknown.code, 404);

    // Renaming a skill rewrites only the `name:` line of its frontmatter.
    assert.equal(out.skillRename.code, 200);
    assert.equal(JSON.parse(out.skillRename.body).name, "演示 技能");
    assert.match(out.skillMd, /^---\nname: 演示 技能\n/);
    assert.match(out.skillMd, /description: 演示技能/);
    assert.match(out.skillMd, /正文一行/);
    assert.equal(out.skillRenameEmpty.code, 400);
    assert.equal(out.skillRenameUnknown.code, 404);

    // Tags are the hub's own filing: trimmed, de-duplicated, kept outside the
    // skill folder, and visible on the next list call.
    const tagged = JSON.parse(out.skillTags.body);
    assert.equal(out.skillTags.code, 200);
    assert.deepEqual(tagged.tags, ["图像", "写作"].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")));
    const listed = JSON.parse(out.afterTags.body).skills.find((s) => s.id === "demo-skill");
    assert.deepEqual(listed.tags, ["写作", "图像"]);
    assert.deepEqual(JSON.parse(out.afterTags.body).tags, tagged.tags);
    assert.deepEqual(JSON.parse(out.tagsFileAfterSet)["demo-skill"], ["写作", "图像"]);
    assert.equal(out.skillTagsCleared.code, 200);
    assert.deepEqual(JSON.parse(out.tagsFile)["demo-skill"], undefined);
    assert.equal(out.skillTagsUnknown.code, 404);

    // A tag rename is a filing edit, not a per-card tweak: both skills move to
    // the new name in one call, the file agrees, and the old label is gone.
    assert.equal(out.tagRename.code, 200);
    const renamedBody = JSON.parse(out.tagRename.body);
    assert.equal(renamedBody.changed, 2);
    assert.equal(renamedBody.merged, false);
    assert.equal(renamedBody.tags.includes("写作"), false);
    const renamedSkills = JSON.parse(out.afterTagRename.body).skills;
    assert.deepEqual(renamedSkills.find((s) => s.id === "demo-skill").tags, ["码字", "图像"]);
    assert.deepEqual(renamedSkills.find((s) => s.id === "demo-skill-b").tags, ["码字", "设计"]);
    assert.deepEqual(JSON.parse(out.tagsFileAfterRename)["demo-skill"], ["码字", "图像"]);
    assert.deepEqual(JSON.parse(out.tagsFileAfterRename)["demo-skill-b"], ["码字", "设计"]);

    // Landing on a label that already exists merges the two instead of leaving
    // two chips that look the same but filter separately.
    assert.equal(out.tagRenameMerge.code, 200);
    const mergedBody = JSON.parse(out.tagRenameMerge.body);
    assert.equal(mergedBody.merged, true);
    assert.equal(mergedBody.changed, 2);
    assert.equal(mergedBody.tags.includes("码字"), false);
    assert.equal(mergedBody.tags.includes("设计"), true);
    assert.deepEqual(JSON.parse(out.tagsFileAfterMerge)["demo-skill"], ["设计", "图像"]);
    assert.deepEqual(JSON.parse(out.tagsFileAfterMerge)["demo-skill-b"], ["设计"]);

    // Blank names, a missing source label and a no-op rename each get an answer
    // the caller can show without guessing what happened.
    assert.equal(out.tagRenameEmpty.code, 400);
    assert.equal(out.tagRenameNoFrom.code, 400);
    assert.equal(out.tagRenameUnknown.code, 404);
    assert.equal(out.tagRenameSame.code, 200);
    assert.equal(JSON.parse(out.tagRenameSame.body).changed, 0);

    // Dragged order is stored beside the tags and wins over the alphabetical
    // default; ids that no longer exist are dropped instead of being kept.
    assert.equal(out.skillReorder.code, 200);
    const reordered = JSON.parse(out.afterReorder.body).skills.map((s) => s.id);
    assert.deepEqual(reordered.slice(0, 2), ["demo-skill-b", "demo-skill"]);
    assert.deepEqual(JSON.parse(out.orderFile).order, ["demo-skill-b", "demo-skill"]);
    assert.equal(out.skillReorderBadType.code, 400);
    assert.equal(out.skillReorderEmpty.code, 400);

    // With the credential service attached, a key edit is handed to it and the
    // YAML stays exactly as DSH left it; detached, the file writer comes back.
    assert.equal(out.healthBeforeAttach, false);
    assert.equal(out.healthAfterAttach, true);
    assert.equal(out.healthAfterDetach, false);
    assert.equal(out.keyViaService.code, 200);
    // The key edit goes to the store it came from. No route borrows
    // DEEPSEEK_API_KEY any more, so the only writes after it belong to the relay
    // route, under a reference of its own.
    assert.deepEqual(out.credCalls[0], { op: "set", ref: "DEEPSEEK_API_KEY", value: "sk-through-service-111111" });
    assert.ok(out.credCalls.slice(1).every((call) => call.ref === "APIHUB_RELAY_API_KEY"), JSON.stringify(out.credCalls));

    // A chat endpoint DSH does not ship becomes one route: the adapter speaks the
    // OpenAI chat protocol, the key is a credential ref, and the model list is
    // what the panel last probed. Existing routes in that section are left alone.
    assert.equal(out.planBeforeAttach.settings, false);
    assert.equal(out.syncNoService.code, 501);
    assert.equal(out.planAfterAttach.settings, true);
    assert.equal(out.planAfterAttach.routes.length, 1);
    assert.equal(out.planAfterAttach.routes[0].id, "relay");
    assert.equal(out.planAfterAttach.routes[0].ref, "APIHUB_RELAY_API_KEY");
    assert.deepEqual(out.planAfterAttach.routes[0].models, ["relay-large"]);
    // DeepSeek's endpoint is DSH's own provider: it is listed as covered instead
    // of being duplicated as a route.
    assert.equal(out.planAfterAttach.builtin.length, 1);
    assert.equal(out.planAfterAttach.builtin[0].id, "deepseek-api");
    assert.equal(out.planAfterAttach.builtin[0].provider, "deepseek-official");
    assert.equal(out.planAfterAttach.builtin[0].ref, "DEEPSEEK_API_KEY");
    // The route the panel wrote for DeepSeek before this change is retired: an
    // explicit unset, because `update` alone cannot drop a key from the layer.
    assert.deepEqual(out.settingsRemovals, [["deepseek-api"]]);
    assert.equal(out.sync.code, 200);
    assert.equal(JSON.parse(out.sync.body).routes, 1);
    const written = out.settingsCalls[0].providers;
    assert.equal(written.relay.api, "openai-completions");
    assert.equal(written.relay.apiKeyEnv, "APIHUB_RELAY_API_KEY");
    assert.equal(written.relay.baseURL, "https://relay.example/v1");
    assert.deepEqual(written.relay.models, [{ id: "relay-large" }]);
    assert.equal(written["deepseek-api"], undefined, "the built-in DeepSeek must not be duplicated as a route");
    // Routes the panel does not own stay where they are: the service merges this
    // patch into the existing layer, so `keepme` survives without being named.
    assert.match(out.credsFileAfterServiceWrite, /DEEPSEEK_API_KEY: sk-old-value-000000/);
    assert.equal(out.keyViaFile.code, 200);
    assert.match(out.credsFileAfterFileWrite, /DEEPSEEK_API_KEY: sk-through-file-222222/);

    // Drift detection is what the page uses instead of a button: fresh section →
    // drift, after a sync → clean, then a disabled provider → drift again with the
    // vanished id marked stale so the next sync can drop it. Routes the panel did
    // not write are never touched.
    assert.equal(out.planDrifted.drift, true);
    assert.equal(out.syncDrifted.code, 200);
    assert.equal(out.planClean.drift, false);
    assert.deepEqual(JSON.parse(out.ownedFile).ids, ["relay"]);
    assert.deepEqual(out.sectionAfterSync.sort(), ["keepme", "relay"]);
    assert.equal(out.planStale.drift, true);
    assert.deepEqual(out.planStale.stale, ["relay"]);
    assert.equal(out.syncEmpty.code, 200);
    assert.equal(JSON.parse(out.syncEmpty.body).routes, 0);
    assert.deepEqual(JSON.parse(out.syncEmpty.body).pruned, ["relay"]);
    assert.deepEqual(out.sectionAfterPrune, ["keepme"]);
    assert.equal(out.planAfterPrune.drift, false);
    assert.equal(out.reenabled.code, 200);

    // The list follows DSH's own roots: the project workspace, ~/.agents (a
    // folder plus a bare .md) and the differences between them.
    const skills = JSON.parse(out.roots.body).skills;
    const byId = new Map(skills.map((skill) => [skill.id, skill]));
    assert.ok(byId.has("proj-demo"), "project skill missing: " + skills.map((s) => s.id).join(","));
    assert.equal(byId.get("proj-demo").scope, "project");
    assert.equal(byId.get("agents-demo").scope, "agents");
    assert.equal(byId.get("lone-skill").scope, "agents");
    assert.equal(byId.get("lone-skill").files, 1);
    assert.equal(byId.get("demo-skill").managed, true);
    assert.equal(byId.get("agents-demo").managed, false);
    // A name DSH would refuse to load is still listed, but flagged. The probe
    // renamed demo-skill to 演示 技能 above, which is exactly such a name.
    assert.equal(byId.get("Odd_Name").dshValidName, false);
    assert.equal(byId.get("demo-skill").dshValidName, false);
    assert.equal(byId.get("demo-skill").dshFormat, true);
    assert.equal(byId.get("proj-demo").dshValidName, true);
    // The panel only moves files it owns.
    assert.equal(out.toggleAgents.code, 400);
    assert.equal(out.removeAgents.code, 400);

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
    // The probe registers one more endpoint of its own, so the seed is the
    // prefix of the file rather than the whole of it.
    assert.deepEqual(
      seeded.providers.map((p) => p.id).slice(0, example.providers.length),
      example.providers.map((p) => p.id),
    );
    assert.equal(example.providers.length, 1);
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
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: join(home, ".dsh"), DSH_AGENTS_HOME: join(home, ".agents") },
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

// A model name is a hint. qwen3.8-max is a text model that happens to read
// images, so the panel asks the API itself and keeps the verdict.
const VISION = `
import http from "node:http";
import { handleRequest } from ${JSON.stringify(SERVER_URL)};

const eyes = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url.includes("/chat/completions")) {
    return res.end(JSON.stringify({ choices: [{ message: { content: "红色" } }] }));
  }
  res.end(JSON.stringify({ data: [{ id: "atlas-x" }] }));
});
const blind = http.createServer((req, res) => {
  if (req.url.includes("/chat/completions")) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "model does not support image input" } }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "atlas-y" }] }));
});
await new Promise((done) => eyes.listen(0, "127.0.0.1", done));
await new Promise((done) => blind.listen(0, "127.0.0.1", done));

const panel = http.createServer(async (req, res) => {
  try { await handleRequest(req, res, ""); } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((done) => panel.listen(0, "127.0.0.1", done));

const api = async (path, body) => {
  const res = await fetch("http://127.0.0.1:" + panel.address().port + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { code: res.status, body: await res.json() };
};

const add = (port, name, model) => api("/api/providers/add", {
  baseURL: "http://127.0.0.1:" + port + "/v1", key: "sk-atlas-" + port, name,
  models: [{ id: model }], selected: [model], defaultModel: model,
});
const withEyes = await add(eyes.address().port, "有眼睛", "atlas-x");
const noEyes = await add(blind.address().port, "没眼睛", "atlas-y");
const retest = await api("/api/vision", { id: withEyes.body.id });

const find = (state, id) => state.providers.find((p) => p.id === id);
const out = {
  eyesOk: withEyes.body.vision?.ok,
  
  
  eyesTypes: find(withEyes.body, withEyes.body.id)?.types,
  blindOk: noEyes.body.vision?.ok,
  blindTypes: find(noEyes.body, noEyes.body.id)?.types,
  blindNote: noEyes.body.vision?.note,
  retestOk: retest.body.ok,
  retestNote: retest.body.note,
};
eyes.close(); blind.close(); panel.close();
console.log("VISION " + JSON.stringify(out));
`;

function visionInFreshHome() {
  const home = mkdtempSync(join(tmpdir(), "api-hub-vision-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", VISION], {
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: join(home, ".dsh"), DSH_AGENTS_HOME: join(home, ".agents") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "vision probe failed:\n" + result.stderr);
  const line = result.stdout.split("\n").find((row) => row.startsWith("VISION "));
  assert.ok(line, "vision probe produced no result:\n" + result.stdout);
  return { home, out: JSON.parse(line.slice("VISION ".length)) };
}

test("vision is proven by a real image call, not by the model name", () => {
  const { home, out } = visionInFreshHome();
  try {
    assert.equal(out.eyesOk, true);
    assert.deepEqual(out.eyesTypes, ["llm", "vision"]);

    assert.equal(out.blindOk, false);
    assert.deepEqual(out.blindTypes, ["llm"]);
    assert.match(out.blindNote, /image input/);

    assert.equal(out.retestOk, true);
    assert.equal(out.retestNote, "红色");
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
// Two refs in DSH's store: one belongs to the panel itself (it writes APIHUB_*
// so a route keeps its key), one is somebody else's. Only the second is an
// endpoint a user could import, and the first has no Base URL to offer.
write(".dsh/.credentials.yaml",
  "version: 1\\nrefs:\\n  APIHUB_SOMETHING_API_KEY: sk-mine-00000000000001\\n  OTHER_TOOL_KEY: sk-other-000000000002\\nrecords:\\n");
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
  credentialRefs: (found.body.credentials || []).map((c) => c.ref),
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
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: join(home, ".dsh"), DSH_AGENTS_HOME: join(home, ".agents") },
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

    // The panel's own APIHUB_* refs are bookkeeping, not endpoints: offering them
    // produced "缺 Base URL" rows nobody could act on.
    assert.equal(out.credentialRefs.includes("OTHER_TOOL_KEY"), true,
      "another tool's key is still offered: " + JSON.stringify(out.credentialRefs));
    assert.equal(out.credentialRefs.some((ref) => ref.startsWith("APIHUB_")), false,
      "the panel's own refs are not offered: " + JSON.stringify(out.credentialRefs));

    assert.equal(out.imported.code, 200, JSON.stringify(out.imported.body));    assert.equal(out.imported.body.provider.cachedCount, 2);
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
  assert.deepEqual(both.types, ["llm", "vision", "image", "video", "embedding"], JSON.stringify(both));

  // A multimodal model is one model with two capabilities: chat *and* vision.
  const vision = classifyKind(["gpt-4o", "qwen-vl-max", "deepseek-chat"]);
  assert.equal(vision.kind, "llm");
  assert.equal(vision.counts.vision, 2, JSON.stringify(vision));
  assert.equal(vision.label, "文本 · 视觉");

  // Only ticked models count, so an image-only tick on a mixed catalog stays 图片.
  const onlyImages = classifyKind(["gpt-image-2", "sora-2"]);
  assert.deepEqual(onlyImages.kinds, ["image"]);
  assert.equal(onlyImages.label, "图片 · 视频");
});

// The host half is what decides whether key edits go through DSH's credential
// service. A fake cordis context is enough to check the handoff: `apply` mounts
// the route, and the route must answer `credentials: true` once the service is
// there — which also proves the service reaches every newly imported revision of
// the backend, not just the first one.
test("the host half hands the credential service to the backend", async () => {
  const hostUrl = pathToFileURL(fileURLToPath(new URL("../lib/index.js", import.meta.url))).href + "?host=" + Date.now();
  const { apply } = await import(hostUrl);
  let handler = null;
  const ctx = {
    inject(names, callback) {
      const host = {};
      if (names.includes("webServer")) {
        host.webServer = {
          register(route) { handler = route.handler; return () => {}; },
          getOrigin: () => "http://127.0.0.1:1",
        };
      }
      if (names.includes("credentials")) {
        host.credentials = { set: async () => {}, unset: async () => {} };
      }
      callback(host);
    },
    effect(run) { return run(); },
    on() {},
    logger: { warn() {} },
  };
  apply(ctx);
  assert.ok(handler, "the panel routes were never mounted");

  const res = { code: 0, body: "", writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
  await handler({ method: "GET", url: "/api-hub/api/health", headers: {}, on() { return this; } }, res);
  assert.equal(res.code, 200);
  assert.equal(JSON.parse(res.body).credentials, true);
});

// The README used to carry its own copy of the version, so every release left it
// one behind (it still said 0.6.1 when the package was at 0.7.5). The version now
// lives in package.json and CHANGELOG.md only; this keeps it that way.
test("the README does not pin a version of its own", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const pinned = [...readme.matchAll(/(?:dsh-api-hub-|当前版本[：:]\s*\*{0,2}v?)(\d+\.\d+\.\d+)/g)]
    .map((match) => match[0].replace(/\s+/g, " "));
  assert.deepEqual(pinned, [], "README 里写死了版本号，发布时会忘记改：" + pinned.join("、"));
});

// Saving a model selection used to treat a missing `selected` as "clear it", so a
// malformed request (or a half-written body) could silently wipe a provider's
// models — which is how this was found, by poking the live panel.
const MODELS = `
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleRequest, useSettingsService } from ${JSON.stringify(SERVER_URL)};

const home = process.env.USERPROFILE || process.env.HOME;
mkdirSync(join(home, ".dsh", "api-hub"), { recursive: true });
writeFileSync(join(home, ".dsh", ".credentials.yaml"), "version: 1\\nrefs:\\n  DEEPSEEK_API_KEY: sk-deepseek-000000000001\\n  FAKE_KEY: sk-fake-0000000000000001\\nrecords:\\n", "utf8");

// An upstream that lists its models in the wrong order on purpose, and records
// the model of every chat call, so the probe can see which one was used.
const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.startsWith("/models")) {
      res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }));
      return;
    }
    const body = raw ? JSON.parse(raw) : null;
    upstream.seen.push(body && body.model);
    res.end(JSON.stringify({ ok: true, model: body && body.model }));
  });
});
upstream.seen = [];
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
const upstreamBase = "http://127.0.0.1:" + upstream.address().port;

writeFileSync(join(home, ".dsh", "api-hub", "providers.json"), JSON.stringify({
  version: 1,
  defaults: { llm: null, image: null },
  providers: [{
    id: "fake-relay", name: "假中转", kind: "llm", kinds: ["llm"], types: ["llm"],
    enabled: true, baseURL: "https://example.invalid",
    test: { method: "GET", path: "/models" },
    keySource: { type: "dsh-credentials", ref: "FAKE_KEY" },
    selectedModels: ["m1"], defaultModel: "m1",
    modelsCache: { at: new Date().toISOString(), list: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
  }, {
    id: "order-relay", name: "顺序中转", kind: "llm", kinds: ["llm"], types: ["llm"],
    enabled: true, baseURL: upstreamBase,
    test: { method: "GET", path: "/models" },
    keySource: { type: "dsh-credentials", ref: "FAKE_KEY" },
    selectedModels: ["m1", "m3"], defaultModel: "m3",
  }],
}), "utf8");

const panel = http.createServer(async (req, res) => {
  try { await handleRequest(req, res, ""); } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((done) => panel.listen(0, "127.0.0.1", done));
const base = "http://127.0.0.1:" + panel.address().port;
const call = (path, body) => fetch(base + path, body === undefined ? {} : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async (r) => ({ code: r.status, body: await r.text() }));
const view = (r) => {
  const doc = JSON.parse(r.body);
  const p = (doc.providers || []).find((x) => x.id === "fake-relay");
  return { code: r.code, selected: p ? p.selectedModels : undefined, def: p ? p.defaultModel : undefined, dropped: doc.dropped };
};

const before = view(await call("/api/state"));
const noField = view(await call("/api/models", { id: "fake-relay" }));
const afterNoField = view(await call("/api/state"));
const ghost = view(await call("/api/models", { id: "fake-relay", selected: ["m2", "ghost"] }));
const picked = view(await call("/api/models", { id: "fake-relay", selected: ["m2", "m3"], defaultModel: "m3" }));
const badDefault = view(await call("/api/models", { id: "fake-relay", selected: ["m2"], defaultModel: "m3" }));
const cleared = view(await call("/api/models", { id: "fake-relay", selected: [] }));

// The catalog leads with the default model, and a chat call that names none
// carries the default instead of letting the upstream pick its first one.
const order = JSON.parse((await call("/api/models?id=order-relay")).body);
const filled = await call("/api/request", { id: "order-relay", method: "POST", path: "/chat/completions", body: { messages: [] } });
const explicit = await call("/api/request", { id: "order-relay", method: "POST", path: "/chat/completions", body: { model: "m1", messages: [] } });

// Nobody presses a sync button for this: saving a selection has to reach the
// settings section on its own, or DSH keeps offering yesterday's models.
const autoWrites = [];
const autoSection = { providers: {} };
useSettingsService({
  read: () => ({ providers: autoSection.providers }),
  update: (patch) => {
    autoWrites.push(patch);
    autoSection.providers = patch.providers;
    return Promise.resolve();
  },
});
const autoSave = view(await call("/api/models", { id: "fake-relay", selected: ["m2", "m3"], defaultModel: "m2" }));
await new Promise((done) => setTimeout(done, 700));
const autoRoute = autoSection.providers["fake-relay"] || null;
const planAfterAuto = JSON.parse((await call("/api/dsh/plan")).body);
const auto = {
  saved: autoSave.selected,
  wrote: autoWrites.length,
  models: autoRoute ? autoRoute.models.map((model) => model.id) : null,
  drift: planAfterAuto.drift,
  lastOk: planAfterAuto.last ? planAfterAuto.last.ok : null,
};
useSettingsService(null);

// The Models page mirror: read-only, so it must work off the sections list alone
// and say so plainly when the host half is too old to offer it.
const mirrorOff = JSON.parse((await call("/api/dsh/models")).body);
useSettingsService({
  read: () => null,
  update: () => Promise.resolve(),
  sections: () => [
    // Real DSH never puts the key in this section: it names the reference and
    // the credential service resolves it. The flag has to mean "resolves",
    // not "the section happens to carry a secret".
    { ns: "llm-deepseek", value: {} },
    { ns: "llm-pi-ai", value: { providers: {
      "fake-relay": { displayName: "假中转", baseURL: "https://example.invalid", api: "openai-completions", apiKeyEnv: "DEEPSEEK_API_KEY", models: [{ id: "m2" }, { id: "m3" }] },
      "by-hand": { displayName: "手加的回转", baseURL: "https://relay.invalid", api: "openai-completions", apiKeyEnv: "OTHER_KEY", models: [{ id: "x" }] },
    } } },
  ],
});
const mirrorOn = JSON.parse((await call("/api/dsh/models")).body);
useSettingsService(null);
const mirror = {
  offOk: mirrorOff.ok,
  offReason: Boolean(mirrorOff.reason),
  rows: (mirrorOn.rows || []).map((row) => [row.name, row.origin, row.modelsCount]),
  configured: (mirrorOn.rows || []).map((row) => [row.name, row.configured]),
};

const ordered = {
  first: order.list[0] && order.list[0].id,
  def: order.defaultModel,
  selected: order.selected,
  filledModel: JSON.parse(filled.body).model,
  explicitModel: JSON.parse(explicit.body).model,
  upstreamSaw: upstream.seen,
};
upstream.close();
panel.close();
console.log("MODELS " + JSON.stringify({ before, noField, afterNoField, ghost, picked, badDefault, cleared, ordered, auto, mirror }));
`;

function modelsInFreshHome() {
  const home = mkdtempSync(join(tmpdir(), "api-hub-models-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", MODELS], {
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: join(home, ".dsh"), DSH_AGENTS_HOME: join(home, ".agents") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "models probe failed:\n" + result.stderr);
  const line = result.stdout.split("\n").find((row) => row.startsWith("MODELS "));
  assert.ok(line, "models probe produced no result:\n" + result.stdout);
  return { home, out: JSON.parse(line.slice("MODELS ".length)) };
}

test("saving a model selection cannot wipe it by omission", () => {
  const { home, out } = modelsInFreshHome();
  try {
    assert.equal(out.before.selected.length, 1);

    // A body without `selected` is a client bug, not a request to clear.
    assert.equal(out.noField.code, 400);
    assert.deepEqual(out.afterNoField.selected, out.before.selected);
    assert.equal(out.afterNoField.def, out.before.def);

    // Ids the catalog no longer lists are reported instead of stored.
    assert.equal(out.ghost.code, 200);
    assert.deepEqual(out.ghost.selected, ["m2"]);
    assert.deepEqual(out.ghost.dropped, ["ghost"]);
    assert.equal(out.ghost.def, "m2");

    assert.deepEqual(out.picked.selected, ["m2", "m3"]);
    assert.equal(out.picked.def, "m3");
    assert.equal(out.badDefault.code, 400);

    // Clearing is still possible, but only when asked for explicitly.
    assert.equal(out.cleared.code, 200);
    assert.deepEqual(out.cleared.selected, []);
    assert.equal(out.cleared.def, null);

    // The default model leads the catalog even though upstream listed m1 first,
    // and a chat body with no model carries the default instead of the first id.
    assert.equal(out.ordered.first, "m3");
    assert.equal(out.ordered.def, "m3");
    assert.deepEqual(out.ordered.selected, ["m1", "m3"]);
    assert.equal(out.ordered.filledModel, "m3");
    assert.equal(out.ordered.explicitModel, "m1");
    assert.deepEqual(out.ordered.upstreamSaw, ["m3", "m1"]);

    // A save alone reaches the settings section: no sync call, no page open.
    assert.deepEqual(out.auto.saved, ["m2", "m3"]);
    assert.equal(out.auto.wrote > 0, true, "the registry write never reached DSH");
    assert.deepEqual(out.auto.models, ["m2", "m3"]);
    assert.equal(out.auto.drift, false);
    assert.equal(out.auto.lastOk, true);

    // The mirror is read-only: an older host half gets a reason, not a crash,
    // and a host that offers `sections` gets every row with its owner labelled.
    assert.equal(out.mirror.offOk, false);
    assert.equal(out.mirror.offReason, true);
    assert.deepEqual(out.mirror.configured, [
      ["DeepSeek", true],
      ["假中转", true],
      ["手加的回转", false],
    ]);
    assert.deepEqual(out.mirror.rows, [
      ["DeepSeek", "builtin", 0],
      ["假中转", "panel", 2],
      ["手加的回转", "manual", 1],
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
// The range DSH enforces at install time is parsed by this package too, so the
// page can warn before a user upgrades into a plugin that will not load.
test("the declared DSH range reads the same way DSH reads it", async () => {
  const { satisfiesRange } = await import(SERVER_URL);
  const range = ">=0.2.1-rc.2 <0.3.0-0";
  assert.equal(satisfiesRange("0.2.1-rc.1", range), false);
  assert.equal(satisfiesRange("0.2.1-rc.2", range), true);
  assert.equal(satisfiesRange("0.2.9-rc.1", range), true);
  assert.equal(satisfiesRange("0.3.0-rc.1", range), false);
  assert.equal(satisfiesRange("0.3.0", range), false);
  assert.equal(satisfiesRange("0.1.9", range), false);
  // Caret keeps the leftmost non-zero part; tilde keeps major and minor.
  assert.equal(satisfiesRange("0.3.0", "^0.2.1"), false);
  assert.equal(satisfiesRange("0.2.5", "^0.2.1"), true);
  assert.equal(satisfiesRange("1.5.0", "^1.2.0"), true);
  assert.equal(satisfiesRange("0.2.5", "~0.2.1"), true);
  assert.equal(satisfiesRange("0.3.1", "~0.2.1"), false);
  // Anything that is not a version must not be reported as a mismatch.
  assert.equal(satisfiesRange("garbage", range), null);
  assert.equal(satisfiesRange("0.2.1-rc.2", "not a range"), null);
});
// The same endpoint can be owned by DSH or by a route of its own, and a key
// only has to reach one place either way. These four edges are what made the
// ownership model confusing, so each one is pinned down here.
test("a carried endpoint still lands its key, and ownership survives a prune it cannot do", () => {
  const { home, out } = probeInFreshHome(EDGES, "EDGES");
  try {
    // No route: DSH carries the endpoint, so the panel only feeds the key.
    assert.deepEqual(out.carriedPlan.builtin.map((row) => row.provider), ["deepseek-official"]);
    assert.equal(out.carriedPlan.routes.length, 0);
    assert.equal(out.carriedSync.routes, 0);
    // The key landed even though nothing was routed, and the 0.8.5 leftover is gone.
    assert.deepEqual(out.carriedSets, [["DEEPSEEK_API_KEY", "sk-panel"]], JSON.stringify(out.carriedSync));
    assert.equal(out.carriedUnsets.includes("APIHUB_LEFTOVER_API_KEY"), true);
    assert.equal(out.carriedUnsets.includes("DEEPSEEK_API_KEY"), false);
    assert.deepEqual(out.ownedAfterCarried, []);

    // Asking for a route of its own is allowed on the same endpoint.
    assert.equal(out.routeOwn, 200);
    assert.deepEqual(out.ownPlan.routes.map((row) => row.id), ["deepseek-api"]);
    assert.equal(out.ownRef.startsWith("APIHUB_"), true);
    assert.equal(out.ownSync.routes, 1);

    // Deleting the provider drops the reference it owned, never DSH's key.
    assert.equal(out.removed, 200);
    assert.equal(out.removeUnsets.includes("DEEPSEEK_API_KEY"), false);
    assert.equal(out.removeUnsets.includes(out.ownRef), true);

    // A settings service that cannot unset a key cannot prune either: the row
    // is reported as stuck, and ownership keeps saying the panel owns it.
    assert.equal(out.stuckSync.pruned.length, 0);
    assert.deepEqual(out.stuckSync.stuck, ["gone"]);
    assert.equal(out.ownedAfterStuck.includes("gone"), true);
    assert.equal(out.ownedAfterStuck.includes("relay"), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
// ---- importing a models config -------------------------------------------------

const IMPORT = `
import { handleRequest } from ${JSON.stringify(SERVER_URL)};
import { readFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.USERPROFILE || process.env.HOME;
const post = async (path, body) => {
  const payload = JSON.stringify(body);
  const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  const req = { method: "POST", url: path, headers: {}, on(event, cb) { if (event === "data") cb(payload); else if (event === "end") cb(); return this; } };
  await handleRequest(req, res, "");
  return { code: res.code, body: res.body };
};
const call = async (path) => {
  const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  const req = { method: "GET", url: path, headers: {}, on(event, cb) { if (event === "end") cb(); return this; } };
  await handleRequest(req, res, "");
  return { code: res.code, body: res.body };
};
const yaml = [
  "providers:",
  "  relay-one:",
  "    displayName: 中转一号",
  "    api: openai-completions",
  "    baseURL: https://relay.example.com/v1/",
  "    apiKey: sk-inline-secret",
  "    models:",
  "      - id: gpt-5",
  "      - id: gpt-5-mini",
  "  relay-two:",
  "    api: openai-responses",
  "    baseURL: https://relay2.example.com/v1",
  "    apiKeyEnv: MISSING_REF",
  "    models: [a, b]",
  "",
].join("\\n");
const out = {};
out.preview = await post("/api/providers/import", { text: yaml });
out.empty = await post("/api/providers/import", { text: "   " });
out.tab = await post("/api/providers/import", { text: "a:\\n\\tb: 1" });
out.nothing = await post("/api/providers/import", { text: "hello: world" });
out.beforeCount = JSON.parse((await call("/api/state")).body).providers.length;
out.applied = await post("/api/providers/import", { text: yaml, apply: true, ids: ["relay-one"] });
const after = JSON.parse((await call("/api/state")).body);
out.added = after.providers.find((p) => p.id === "relay-one") || null;
out.count = after.providers.length;
out.keyFile = readFileSync(join(home, ".dsh", "api-hub", "keys", "relay-one.json"), "utf8");
const second = yaml.replace("中转一号", "中转一号改名").replace("- id: gpt-5\\n", "- id: gpt-5-pro\\n");
out.again = await post("/api/providers/import", { text: second, apply: true, ids: ["relay-one"] });
const final = JSON.parse((await call("/api/state")).body);
out.finalName = (final.providers.find((p) => p.id === "relay-one") || {}).name || null;
out.finalCount = final.providers.length;
out.finalModels = (final.providers.find((p) => p.id === "relay-one") || {}).selectedModels || null;
console.log("IMPORT " + JSON.stringify(out));
`;

function importInFreshHome() {
  const home = mkdtempSync(join(tmpdir(), "api-hub-import-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", IMPORT], {
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: join(home, ".dsh"), DSH_AGENTS_HOME: join(home, ".agents") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "import probe failed:\n" + result.stderr);
  const line = result.stdout.split("\n").find((row) => row.startsWith("IMPORT "));
  assert.ok(line, "import probe produced no result:\n" + result.stdout);
  return { home, out: JSON.parse(line.slice("IMPORT ".length)) };
}

test("a models YAML pastes straight into the panel", () => {
  const { home, out } = importInFreshHome();
  try {
    // Preview: both entries read, only the one holding a key is importable.
    const preview = JSON.parse(out.preview.body);
    assert.equal(out.preview.code, 200);
    assert.equal(preview.candidates.length, 2);
    const one = preview.candidates.find((c) => c.id === "relay-one");
    const two = preview.candidates.find((c) => c.id === "relay-two");
    assert.equal(one.keyPresent, true);
    assert.equal(one.baseURL, "https://relay.example.com/v1");
    assert.equal(one.protocol, "OpenAI 兼容");
    assert.deepEqual(one.models, ["gpt-5", "gpt-5-mini"]);
    assert.equal(two.blocked.includes("MISSING_REF"), true);

    // Refusals carry a reason instead of a stack trace.
    assert.equal(out.empty.code, 400);
    assert.match(JSON.parse(out.empty.body).error, /内容为空/);
    assert.equal(out.tab.code, 400);
    assert.match(JSON.parse(out.tab.body).error, /tab/);
    assert.equal(out.nothing.code, 400);

    // Applying only the ticked entry writes the key where the panel reads it.
    assert.equal(out.applied.code, 200);
    const applied = JSON.parse(out.applied.body);
    assert.deepEqual(applied.imported.map((row) => row.id), ["relay-one"]);
    assert.equal(applied.imported[0].created, true);
    assert.deepEqual(applied.skipped.map((row) => row.id), ["relay-two"]);
    assert.match(applied.skipped[0].reason, /勾选/);
    assert.equal(out.count, out.beforeCount + 1);
    assert.equal(out.added.name, "中转一号");
    assert.equal(out.added.defaultModel, "gpt-5");
    assert.deepEqual(out.added.selectedModels, ["gpt-5", "gpt-5-mini"]);
    assert.equal(JSON.parse(out.keyFile).apiKey, "sk-inline-secret");
    assert.equal(out.added.keyMasked.startsWith("sk-"), true);

    // Pasting a newer copy updates that entry, it does not add a second one.
    const again = JSON.parse(out.again.body);
    assert.equal(again.imported[0].created, false);
    assert.equal(out.finalCount, out.count);
    assert.equal(out.finalName, "中转一号改名");
    assert.deepEqual(out.finalModels, ["gpt-5-pro", "gpt-5-mini"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});