import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function resolveBundledNpxCli(nodeExecutable) {
  const nodeDirectory = dirname(nodeExecutable);
  const candidates = [
    join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Windows exposes npx as a .cmd shim, which child_process.spawn cannot execute
 * directly. Run npm's bundled JavaScript entry point with the current Node
 * executable so locally-controlled paths and version overrides never become a
 * cmd.exe command string.
 */
export function getNpxInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;

  if (platform === 'win32') {
    const npxCliPath = options.npxCliPath ?? resolveBundledNpxCli(nodeExecutable);
    if (!npxCliPath) {
      throw new Error(`Could not resolve npm's npx CLI next to Node executable ${nodeExecutable}.`);
    }

    return {
      command: nodeExecutable,
      args: [npxCliPath, ...args],
      windowsHide: true
    };
  }

  return { command: 'npx', args, windowsHide: false };
}
