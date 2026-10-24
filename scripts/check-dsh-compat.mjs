// Does the newest published DSH still fall inside the range this plugin declares?
//
// `engines.dsh` is enforced by DSH itself at install time: a build outside the
// range is refused with `incompatible-version`. That protects the user, but it
// also means a new DSH release can quietly make the plugin uninstallable. This
// script turns that into a red check, so the range gets widened on purpose
// (after the plugin was actually tried against the new build) instead of after
// a failed install.
//
// Usage: node scripts/check-dsh-compat.mjs [--registry <url>] [--json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { satisfiesRange } from '../lib/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
const range = manifest.engines?.dsh;
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const registryFlag = args.indexOf('--registry');
const registry = registryFlag >= 0 ? args[registryFlag + 1] : 'https://registry.npmjs.org';

const fail = (message, extra = {}) => {
  if (asJson) console.log(JSON.stringify({ ok: false, message, ...extra }));
  else console.error(message);
  process.exit(1);
};

if (!range) fail('package.json has no engines.dsh, so DSH cannot refuse an incompatible build');

let meta;
try {
  const response = await fetch(`${registry.replace(/\/$/, '')}/@deepseek-ai%2Fdsh`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`registry answered ${response.status}`);
  meta = await response.json();
} catch (error) {
  // A network failure is not a compatibility failure: report it without red.
  const message = `could not reach the registry: ${error?.message ?? error}`;
  if (asJson) console.log(JSON.stringify({ ok: null, message, range }));
  else console.warn(`::warning::${message}`);
  process.exit(0);
}

const latest = meta['dist-tags']?.latest ?? null;
if (!latest) fail('the registry published no `latest` tag for @deepseek-ai/dsh', { range });

const compatible = satisfiesRange(latest, range);
const report = { ok: compatible === true, range, latest, plugin: manifest.version };

if (compatible === null) fail(`cannot read the range "${range}"`, report);
if (!compatible) {
  fail(
    `@deepseek-ai/dsh@${latest} is outside engines.dsh "${range}" — install it by hand, try this plugin `
      + 'against it, then widen the range and release.',
    report,
  );
}

if (asJson) console.log(JSON.stringify(report));
else console.log(`ok: @deepseek-ai/dsh@${latest} satisfies engines.dsh "${range}" (plugin ${manifest.version})`);
