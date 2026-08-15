# DSH Studio Branch and Upstream Sync Rules

This file owns the fork-local branch policy for DSH Studio. The upstream
`AGENTS.md` keeps upstream engineering rules; this file keeps the release
engineering rules that must survive weekly upstream rebases.

## Hard invariants

1. `master` is a read-only mirror of `upstream/master`.
   - No Studio commits, merges, or direct edits on `master`.
   - Update only with fast-forward from upstream.
2. All Studio product work lives on `studio` and short-lived `feature/*`
   branches. Never merge `studio` into `master`.
3. The official remote is `upstream`; the private fork/backup is `origin`.
   - Push `studio` and `feature/*` only to `origin`.
   - Never push Studio branches to `upstream`.
4. Never force-push `master` or any `upstream/*` ref.
   - `--force-with-lease` is allowed only for your own `studio` and
     `feature/*` branches after a local rebase.
5. Keep `git config rerere.enabled true`; generated docs and `pnpm-lock.yaml`
   recur in upstream conflicts.

## Remote layout

```text
upstream/master
     │ fetch + ff-only
     ▼
  master                  upstream mirror, zero local commits
     │ rebase
     ▼
  studio                  DSH Studio integration branch
     │
     ├── feature/desktop-kernel
     ├── feature/agent-board
     ├── feature/git-worktree
     ├── feature/plugin-center
     └── feature/automation
```

Baseline tag: `studio-base-0.1.0-rc.5` at upstream
`47f943859bef60e4160492346772ded9b24f765a`.

## Weekly upstream sync

Run from a clean worktree.

```bash
git status

# 1. Update the master mirror.
git switch master
git fetch upstream --prune
git merge --ff-only upstream/master
git push origin master

# 2. Rebase Studio onto the new upstream baseline.
git switch studio
git rebase master
```

Use `git rebase --rebase-merges master` when Studio merge topology must be
preserved. After any conflict:

```bash
git status
# edit the conflicting files
git add <files>
git rebase --continue
```

After the rebase completes, push with a lease:

```bash
git push --force-with-lease origin studio
```

## Recurring conflict surface

After rebasing, regenerate every derived file before resolving documentation
gates:

```bash
pnpm install
pnpm run gen-third-party-notices
pnpm run gen-cordis-catalog
pnpm run gen-config-catalog
pnpm run gen-module-graph
pnpm run gen-doc-graphs

pnpm exec tsx scripts/verify-translation-pairing.ts --write \
  docs/config-catalog.md \
  docs/module-graph.md \
  docs/capability-seams.md \
  docs/subsystems/client-modules.md
```

## Required gates after every upstream rebase

```bash
pnpm run build:desktop
pnpm run typecheck
pnpm run lint
pnpm run check:ci:static

pnpm exec vitest run \
  packages/client/connection-desktop/tests/protocol.spec.ts \
  apps/desktop/tests/desktop-ipc.integration.spec.ts \
  apps/desktop/tests/harness-process.spec.ts
```

Run `pnpm run knip` after adding or removing workspace packages, and
`pnpm run verify-translation-pairing` after any `*.i18n.yaml` change.

## Feature workflow

```bash
git switch studio
git switch -c feature/<name>

# develop, commit, and publish to the private fork
git add -A
git commit -m "feat(<name>): ..."
git push -u origin feature/<name>

# integrate back to studio with an explicit merge boundary
git switch studio
git merge --no-ff feature/<name>
git push origin studio
```

Delete a feature branch only after its integration has been accepted and its
history is reachable from `studio`:

```bash
git branch -d feature/<name>
git push origin --delete feature/<name>
```

## Recovery

- `master` accidentally receives a local commit:
  confirm the commit is expendable, then `git switch master && git reset
  --hard upstream/master && git push --force-with-lease origin master`.
  Prefer `revert` over reset when the commit has already been shared.
- `studio` rebase becomes tangled:
  `git rebase --abort`, return to the pre-rebase commit, and split the sync
  into one upstream merge per feature before retrying.
