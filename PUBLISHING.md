# Publishing

## Status

- ✅ Repository URLs filled in (`kaiexi/dsh-browser-search`).
- ✅ git installed (2.55.0.5 via winget).
- ✅ GitHub repository created and pushed — <https://github.com/kaiexi/dsh-browser-search>.
- ❌ **npm publishing: decided against.** The distribution channel is GitHub only, so the package is
  intentionally absent from the registry and `README.md` says so. No npm credential was ever stored on
  the build machine (no user-level `.npmrc`). The instructions below are kept in case that changes —
  they are **not** a pending task.

## Pre-flight (only if you decide to publish to npm)

- [ ] **Log in to npm** — `npm login`, or set a token:
      `npm config set //registry.npmjs.org/:_authToken=<token>`.
- [ ] **Pick the version.** `0.1.0` is a reasonable first release; bump with
      `npm version patch|minor|major` (this also creates a git tag).
- [ ] **Confirm the package name is still free** — `dsh-browser-search` returned 404 (available) when
      checked. Re-check with `npm view dsh-browser-search` (a 404 means still free).
- [ ] **Un-mark it in `README.md`** — replace the "From npm — not published" section with real install
      instructions, otherwise the README will contradict the registry.

### Git and the system proxy

Git does **not** read the Windows system proxy, so on a machine whose GitHub access depends on one, a
direct `git push` fails with `Recv failure: Connection was reset` even though browsers reach GitHub
fine. Point git at the proxy — repo-local is enough, and keeps it out of `.git/config`'s committed
neighbours:

```powershell
git config http.proxy http://127.0.0.1:<port>
git config https.proxy http://127.0.0.1:<port>
```

Read the current value from `HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
(`ProxyServer`). If the proxy is later turned off, unset these or git in this repo will fail to connect.

## Verify the tarball

`npm pack --dry-run` works without credentials and is the real safety net: it shows exactly what would be
uploaded.

```powershell
npm pack --dry-run
```

Expected — **8 files, ~19 kB packed / ~54 kB unpacked**:

```
LICENSE  README.md  bin/cli.js  cordis.patch.yml  index.js  lib/cdp.js  lib/search.js  package.json
```

`test/`, `scripts/` and `node_modules/` are excluded by the `files` whitelist, so the ~105 MB dev shim can
never leak into a release. If the file list ever grows beyond the eight above, fix `files` before
publishing.

## Publish to npm

```powershell
npm run verify          # last sanity check: all engines end to end
npm publish
```

Unscoped packages publish public by default, so no `--access` flag is needed.

## Publish to GitHub

Already done for the initial commit; for later changes:

```powershell
git add .
git commit -m "<what changed>"
git push
```

The `.gitignore` excludes `node_modules/` (the dev shim), `*.tgz`, editor directories and the runtime
status file the plugin writes during local runs. Check `git status` before the first commit of a fresh
clone: if `node_modules` appears, the shim was built in the wrong place.

## After publishing

- Add the repository URL to the README if you want badges or a clone command.
- The engine measurements in `lib/search.js` and the README are dated (2026-10). Search DOMs change, so
  re-run `test/verify-engines.mjs` and `test/flakiness.mjs` before claiming an engine works. An engine
  that has quietly started failing is worse than one that was never listed.
