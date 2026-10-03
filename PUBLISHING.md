# Publishing

Everything needed to publish is in place; two placeholders and two missing tools are not.

## Pre-flight

- [ ] **Replace the placeholder repository URLs** in `package.json` — `repository.url`, `bugs.url` and
      `homepage` all contain `REPLACE_WITH_YOUR_ACCOUNT`. They are metadata only (nothing breaks if they
      are wrong), but they end up on the npm page and in `npm repo`.
- [ ] **Pick the version.** `0.1.0` is a reasonable first release; bump with
      `npm version patch|minor|major` once the repo exists (it needs git for the tag).
- [ ] **Install git** — it is not on this machine (`git --version` fails), so `git init`, `npm version`
      tagging and pushing to GitHub cannot run yet. `winget install --id Git.Git -e` or
      <https://git-scm.com/download/win>.
- [ ] **Log in to npm** — `npm whoami` currently fails with `ENEEDAUTH`.
      Run `npm login`, or set a token: `npm config set //registry.npmjs.org/:_authToken=<token>`.
- [ ] **Confirm the package name is still free** — `dsh-browser-search` returned 404 (available) when
      checked. Re-check with `npm view dsh-browser-search` (a 404 means still free).

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

```powershell
git init
git add .
git commit -m "dsh-browser-search: browser_search tool for DeepSeek Harness"
git branch -M main
git remote add origin https://github.com/<account>/dsh-browser-search.git
git push -u origin main
```

The `.gitignore` already excludes `node_modules/` (the dev shim), `*.tgz`, editor directories and the
runtime status file the plugin writes during local runs. Check `git status` before the first commit: if
`node_modules` appears, the shim was built in the wrong place.

## After publishing

- Add the repository URL to the README if you want badges or a clone command.
- The engine measurements in `lib/search.js` and the README are dated (2026-10). Search DOMs change, so
  re-run `test/verify-engines.mjs` and `test/flakiness.mjs` before claiming an engine works. An engine
  that has quietly started failing is worse than one that was never listed.
