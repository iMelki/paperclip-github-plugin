import { execFile } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

test('build script reports missing local dependencies clearly when node_modules is absent', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'paperclip-github-plugin-build-no-deps-'));

  try {
    await cp(new URL('../scripts', import.meta.url), join(tempDir, 'scripts'), { recursive: true });
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      name: 'paperclip-github-plugin-test-fixture',
      version: '0.0.0-test',
      type: 'module'
    }, null, 2));

    let failure = null;

    try {
      await execFileAsync(process.execPath, [join(tempDir, 'scripts/build.mjs')], {
        cwd: tempDir
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'expected build.mjs to fail without installed dependencies');
    const output = `${failure?.stdout ?? ''}\n${failure?.stderr ?? ''}`;

    assert.match(output, /Missing build dependency "esbuild"/);
    assert.match(output, /Run `pnpm install`/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('built worker externalizes the pinned SDK with a company-scoped secret RPC', async () => {
  await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: packageRoot });

  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies['@paperclipai/plugin-sdk'], '2026.916.0');

  const builtWorker = await readFile(join(packageRoot, 'dist', 'worker.js'), 'utf8');
  assert.match(builtWorker, /from "@paperclipai\/plugin-sdk"/);

  const sdkRoot = await realpath(join(packageRoot, 'node_modules', '@paperclipai', 'plugin-sdk'));
  const installedSdkPackage = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
  assert.equal(installedSdkPackage.version, '2026.916.0');

  const workerRpcHost = await readFile(join(sdkRoot, 'dist', 'worker-rpc-host.js'), 'utf8');
  assert.match(
    workerRpcHost,
    /async resolve\(secretRef, options = \{\}\)\s*\{\s*return callHost\("secrets\.resolve", \{\s*secretRef,\s*companyId: options\.companyId,\s*configPath: options\.configPath/s
  );
});
