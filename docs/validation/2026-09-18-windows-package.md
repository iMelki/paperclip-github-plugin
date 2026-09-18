# Windows package qualification — 2026-09-18

Tracking: [Paperclip #130](https://github.com/iMelki/paperclip/issues/130).
Runtime rollout: [Paperclip #129](https://github.com/iMelki/paperclip/issues/129).

The workspace-policy test now normalizes CRLF to LF before evaluating its
existing content assertions. Previously the same valid YAML failed on a Windows
checkout. The change preserves the required esbuild and release-exception values.

## Evidence

- Production source: merged `2cff6ee7414ea6dcd4a8982aa5974781d213ce01`,
  including security port PR #2 and Windows launcher PR #3.
- Node: private validation runtime `24.21.0`; Windows archive SHA-256
  `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`,
  verified against the official versioned Node checksum file before extraction.
- Plugin package manager: `pnpm@12.4.1`, private Corepack cache and store.
  Frozen-lockfile installation passed; SDK resolved to `2026.831.1`.
- Typecheck passed. Direct TypeScript test suites: 368 passed, 0 failed.
- Build-script suite: reproduced CRLF failure (6 passed, 1 failed), then
  7 passed after input normalization. This includes shell-free Windows argv proof.
- Build succeeded. `npm pack --ignore-scripts` produced the already-built
  `paperclip-github-plugin-0.17.6.tgz` (830946 bytes; 7 packaged files).
- Package SHA-256:
  `c437978b050cf5af2faa2377802a20c781a41116a218b496408de60b27f79d64`.
- Worker SHA-256:
  `970457202998b46106d1101e0c2c4ed6a995edab605a76816186f244868e920c`.
- Lockfile checkout-byte SHA-256:
  `b6be995c8e81cfedcdefa78275d5c6a3392db5da4b7f772f4416bf4215a825fb`.

## Limits and next step

The archive was built before this test-only correction. Production inputs are
unchanged by the correction. This is build/package qualification, not proof of
installation in the live Factory, migration safety, credential resolution, or
bounded import behavior. Retain the archive for isolated host qualification.
Host package-manager version is independent: the selected host release uses
`pnpm@9.15.4`.
