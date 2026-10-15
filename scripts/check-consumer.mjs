import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts');
const release = JSON.parse(await readFile(path.join(artifacts, 'release-manifest.json')));
const consumer = await mkdtemp(path.join(os.tmpdir(), 'template-pulse-consumer-'));
for (const pkg of release) {
  assert.equal(
    createHash('sha256').update(await readFile(path.join(artifacts, pkg.filename))).digest('hex'),
    pkg.sha256,
    `Archive checksum mismatch: ${pkg.filename}`,
  );
}
const dependencies = {
  react: '18.3.1', 'react-dom': '18.3.1', 'react-router-dom': '6.30.6',
  ...Object.fromEntries(release.map(pkg => [pkg.name, `file:${path.join(artifacts, pkg.filename).replaceAll('\\', '/')}`])),
};
await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'template-pulse-consumer-check', version: '1.0.0', private: true, dependencies }));
// Locate npm's JS entry point in standard Node installations, including setup-node.
const nodeDirectory = path.dirname(process.execPath);
const npmCli = [
  path.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
  path.join(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
].find(existsSync);
assert.ok(npmCli, 'Cannot locate npm CLI beside Node.js');
const npm = args => spawnSync(process.execPath, [npmCli, ...args], {
  cwd: consumer, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
});
const install = npm(['install', '--ignore-scripts', '--strict-peer-deps', '--no-fund', '--no-audit', '--registry=https://registry.npmjs.org']);
assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
const require = createRequire(path.join(consumer, 'package.json'));
for (const pkg of release) {
  assert.ok(require.resolve(pkg.name).startsWith(consumer), 'Package resolved outside isolated consumer');
  if (pkg.name.endsWith('-backend') || pkg.name.includes('-backend-module-')) {
    assert.equal(require(pkg.name).default.$$type, '@backstage/BackendFeature');
  }
}
const common = require('@abayramli/backstage-plugin-template-pulse-common');
assert.equal(common.executionsReadAllPermission.name, 'template-pulse.read-all');
const node = require('@abayramli/backstage-plugin-template-pulse-node');
assert.equal(typeof node.HistoryClient, 'function');
assert.equal(node.parseExecutionQuery({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }).scope, 'mine');
const bundle = await build({
  stdin: {
    contents: "import plugin from '@abayramli/backstage-plugin-template-pulse'; globalThis.templatePulse = plugin;",
    resolveDir: consumer,
  },
  bundle: true, write: false, minify: true, treeShaking: true,
  platform: 'browser', format: 'esm',
  define: { 'process.env.NODE_ENV': '"production"' },
});
assert.ok(bundle.outputFiles.some(file => file.text.includes('.template-pulse-analytics-toolbar')), 'Production bundling removed plugin styles');
await writeFile(path.join(artifacts, 'consumer-path.txt'), consumer);
console.log(`Consumer install, backend imports and production frontend bundle passed: ${consumer}`);
const audit = npm(['audit', '--omit=dev', '--json', '--registry=https://registry.npmjs.org']);
assert.ok(audit.status === 0 || audit.status === 1, audit.stderr);
const report = JSON.parse(audit.stdout);
assert.ok(report.metadata?.vulnerabilities, `Audit failed: ${audit.stdout}`);
await writeFile(path.join(artifacts, 'consumer-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
const counts = report.metadata.vulnerabilities;
console.log(`Consumer audit: ${JSON.stringify(counts)}. Full report: artifacts/consumer-audit.json`);
// Verification remains useful while upstream fixes are pending; publishing fails on high/critical.
if (process.argv.includes('--enforce') && (counts.high || counts.critical)) process.exitCode = 1;
