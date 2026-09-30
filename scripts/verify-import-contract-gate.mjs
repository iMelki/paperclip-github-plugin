import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
assert.ok(pkg.scripts.test.startsWith(`${pkg.scripts['test:import-contract']} && `),
  'default test must enforce import characterization');
assert.match(workflow, /run: pnpm test\s*\n/, 'hosted CI must use the default test gate');

const args = [require.resolve('tsx/cli'), '--test', '--test-name-pattern=outer guard',
  'tests/bounded-import-contract.spec.ts'];
function probe(broken) {
  const env = { ...process.env };
  delete env.PAPERCLIP_IMPORT_CONTRACT_NEGATIVE_PROOF;
  if (broken) env.PAPERCLIP_IMPORT_CONTRACT_NEGATIVE_PROOF = '1';
  const result = spawnSync(process.execPath, args, {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'proof must finish without timeout or signal');
  return { exitCode: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const red = probe(true);
assert.equal(red.exitCode, 1, red.output);
assert.match(red.output, /forbidden GitHub request attempt/, 'failure must come from the outer violation ledger');
console.log(red.output);
const green = probe(false);
assert.equal(green.exitCode, 0, green.output);
console.log(green.output);
console.log(JSON.stringify({ gate: 'synthetic-import-contract', brokenExitCode: red.exitCode,
  restoredExitCode: green.exitCode, attribution: 'forbidden GitHub request attempt',
  scope: 'synthetic-fixture-no-live-host', mutationIntent: 'synthetic-fixture-only' }));
