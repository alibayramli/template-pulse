import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts');
const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json')));
const packages = [];
for (const directory of await readdir(path.join(root, 'plugins'))) {
  const cwd = path.join(root, 'plugins', directory);
  const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json')));
  packages.push({ cwd, manifest });
}
assert.equal(packages.length, 5, 'Review the release script when adding packages');
const names = new Set(packages.map(({ manifest }) => manifest.name));
await mkdir(output, { recursive: true });
const release = [];
assert.ok(process.env.COREPACK_ROOT, 'Run this script through corepack yarn pack:release');
const yarnCli = path.join(process.env.COREPACK_ROOT, 'dist', 'yarn.js');
for (const { cwd, manifest } of packages) {
  assert.equal(manifest.version, rootPackage.version, 'Release versions must match');
  assert.match(manifest.name, /^@abayramli\/backstage-plugin-/);
  const filename = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
  const archive = path.join(output, filename);
  // Invoke Yarn through Corepack's JS entry point to avoid shell quoting and Windows .cmd differences.
  execFileSync(process.execPath, [yarnCli, 'pack', '--out', archive], {
    cwd,
    stdio: 'inherit',
  });
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(entry => !entry.endsWith('/'));
  const contents = entry => execFileSync('tar', ['-xOf', archive, `package/${entry}`], { encoding: 'utf8' });
  const packed = JSON.parse(contents('package.json'));
  assert.equal(packed.name, manifest.name);
  assert.equal(packed.version, manifest.version);
  assert.equal(packed.publishConfig.access, 'public');
  assert.equal(packed.license, 'Apache-2.0');
  assert.equal(packed.repository.directory, path.relative(root, cwd).replaceAll('\\', '/'));
  assert.equal(packed.repository.url, rootPackage.repository.url);
  assert.ok(entries.includes('package/LICENSE'));
  assert.ok(entries.includes('package/README.md'));
  assert.equal(contents('LICENSE'), await readFile(path.join(root, 'LICENSE'), 'utf8'));
  for (const entry of entries) {
    assert.match(entry, /^package\/(?:dist\/|assets\/|package\.json$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$|config\.(?:d\.ts|schema\.json)$)/, `Unexpected release file: ${entry}`);
    assert.ok(!/(?:^|\/)(?:node_modules|\.env|\.git)(?:[/.]|$)|\.test\.|\.sqlite|\.pem$|\.key$/.test(entry), `Sensitive or development file: ${entry}`);
  }
  for (const entry of [packed.main, packed.module, packed.types].filter(Boolean)) {
    assert.match(entry, /^\.?\/?dist\//, `Entry must be compiled: ${entry}`);
    assert.ok(entries.includes(`package/${entry.replace(/^\.\//, '')}`), `Missing entry: ${entry}`);
  }
  function checkExport(value) {
    if (typeof value === 'string') {
      assert.ok(entries.includes(`package/${value.replace(/^\.\//, '')}`), `Missing export: ${value}`);
    } else {
      for (const [condition, target] of Object.entries(value)) {
        if (condition === 'backstage') {
          assert.match(target, /^@backstage\/(?:BackendFeature|FrontendPlugin)$/);
        } else {
          checkExport(target);
        }
      }
    }
  }
  checkExport(packed.exports);
  for (const dependencies of [packed.dependencies, packed.peerDependencies, packed.optionalDependencies]) {
    for (const [name, range] of Object.entries(dependencies ?? {})) {
      assert.ok(!/^(?:workspace:|file:|link:|portal:)/.test(range), `Local dependency in ${packed.name}: ${name}`);
      if (names.has(name)) assert.equal(range, `^${rootPackage.version}`);
    }
  }
  const feature = packed.backstage.features?.['.'];
  if (manifest.backstage.role.includes('plugin')) assert.ok(feature, 'Missing discoverable feature');
  if (packed.configSchema) assert.ok(entries.includes(`package/${packed.configSchema}`));
  if (manifest.backstage.role === 'frontend-plugin') {
    assert.ok(packed.sideEffects.includes('**/*.css.esm.js'));
    assert.ok(entries.some(entry => entry.endsWith('.css.esm.js')), 'Missing frontend style injection');
    assert.ok(entries.includes('package/THIRD_PARTY_NOTICES.md'), 'Missing bundled style-inject license');
  }
  // The postpack hook must restore the local TypeScript entry point.
  const restored = JSON.parse(await readFile(path.join(cwd, 'package.json')));
  assert.equal(restored.main, 'src/index.ts');
  release.push({ name: packed.name, version: packed.version, filename, sha256: createHash('sha256').update(await readFile(archive)).digest('hex'), files: entries.length });
}
await writeFile(path.join(output, 'release-manifest.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(`Verified ${release.length} release archives in ${output}`);
