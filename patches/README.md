# Dependency patches

This directory contains patches that Bun applies automatically during
dependency installation. Do not edit files under `node_modules` manually.

## Hono stream abort fix

`hono@4.9.9.patch` backports
[Hono PR #5274](https://github.com/honojs/hono/pull/5274). The fix prevents a
rejected asynchronous stream-abort listener from becoming an unhandled promise
rejection that terminates the Bun proxy process.

The patch is registered in `package.json` under `patchedDependencies` and locked
in `bun.lock`. These files and the patch must be committed together.

## Install and run

From PowerShell in the repository root:

```powershell
bun run internal-install
bun run dev
```

`internal-install` refreshes the Enzyme credential and runs
`bun install --frozen-lockfile`, which applies the patch automatically. The
patch file is not executed directly.

Do not use `npm install`: npm does not support Bun's `patchedDependencies`, so it
would install an unpatched Hono package. This also means an install script that
ultimately invokes `npm install` is not suitable for this checkout.

## Verify the patch

```powershell
bun test tests/hono-stream-abort.test.ts
```

The test must pass without emitting an unhandled `AbortError`.

## Remove the patch later

When the Enzyme feed contains Hono 4.13.4 or newer:

1. Upgrade the `hono` dependency to the available fixed version.
2. Remove the `hono@4.9.9` entry from `patchedDependencies`.
3. Delete `patches/hono@4.9.9.patch`.
4. Refresh `bun.lock` using the Enzyme registry.
5. Run the regression test and the full test suite.
