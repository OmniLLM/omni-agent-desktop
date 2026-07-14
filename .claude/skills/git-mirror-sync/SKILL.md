---
allowed-tools: Read, Bash(git:*)
author: James Zhu <zhujian0805@gmail.com>
description: |
    Keeps a fork/mirror in sync by pulling all branches from an upstream remote into local branches,
    showing the diff of what changed, then pushing those branches to the origin remote.
    Ensures local and origin stay aligned with the upstream source of truth.
    Use when mirroring an upstream repo, syncing a fork, or propagating upstream branches to origin.
    Trigger with "mirror sync", "sync fork with upstream", "sync remote branches to origin", or "propagate upstream".
license: MIT
name: git-mirror-sync
version: 1.0.0
---
# Git Mirror Sync

Synchronizes local branches and the `origin` remote with an upstream remote. The flow is:
**upstream → local → origin**. After running, local branches and `origin` both match `upstream`.

## Overview

This skill is for the fork/mirror pattern where:
- **upstream** is the source of truth (the remote you track branches FROM)
- **local** is your working copy
- **origin** is your fork/mirror (the remote you push branches TO)

It fetches every branch from upstream, fast-forwards local branches, reports the diff so you
can review what moved, then pushes to origin.

## Prerequisites

- Git repository with at least two remotes configured
- One remote acting as the upstream source (default name guess: `upstream`)
- One remote acting as the push target (default name guess: `origin`)

**Note:** When generating commit messages, do not include 'Co-Authored-By: Claude <noreply@anthropic.com>' attribution.

## Instructions

### Step 0 — Identify remotes

```bash
git remote -v
```

- Determine the **upstream** remote (source). If a remote literally named `upstream` exists, use it.
  Otherwise ask the user which remote is the upstream source.
- Determine the **origin** remote (target). Default to `origin`; if absent or ambiguous, ask.
- Confirm the current working tree is clean before proceeding:

```bash
git status --porcelain
```

If there are uncommitted changes, stop and warn the user — do not overwrite their work.

### Step 1 — Sync remote branches to local

Fetch all branches from upstream (prune deleted ones):

```bash
git fetch <upstream> --prune
```

For each branch on upstream, fast-forward (or create) the matching local branch. Prefer a
non-destructive fast-forward. Only reset if the user explicitly wants a mirror (see Mirror Mode).

```bash
# List upstream branches
git branch -r --list '<upstream>/*'

# For each branch <b> (excluding HEAD):
#  - if local <b> exists: fast-forward it
#  - else: create local <b> tracking upstream/<b>
```

Use `git switch <b>` + `git merge --ff-only <upstream>/<b>` per branch, or update refs directly.
If a fast-forward is NOT possible (diverged history), STOP for that branch and report it — do not
force unless the user opts into Mirror Mode.

### Step 2 — Show the diff

Before pushing, show what changed so the user can review:

```bash
# Summary of commits gained per branch
git log --oneline <origin>/<b>..<b>      # what origin is missing
git diff --stat <origin>/<b>..<b>        # file-level changes
```

Present a concise per-branch summary: branches updated, commits added, files changed. Highlight
any branch that could not fast-forward.

### Step 3 — Push to origin

Push each synced branch to origin so origin matches upstream:

```bash
git push <origin> <b>:<b>
```

Or push all at once after review:

```bash
git push <origin> --all --prune
```

Only use `--prune` on push if the user wants origin to exactly mirror upstream (deletes origin
branches absent upstream). Confirm before pruning.

### Step 3.5 — Prune merged branches

After syncing, clean up local branches that have been fully merged into the main branch
(default branch, e.g. `main`/`master`) and no longer have work outstanding:

```bash
# Detect the default branch
git remote show <upstream> | sed -n 's/.*HEAD branch: //p'

# List local branches already merged into the default branch
git branch --merged <default>
```

For each merged branch (excluding the default branch and the current branch):

```bash
git branch -d <b>          # safe delete; refuses if not fully merged
```

Also prune stale remote-tracking refs (already done by `--prune` on fetch, but confirm):

```bash
git fetch <upstream> --prune
git fetch <origin> --prune
```

If the user wants the merged branches removed from origin too, confirm first, then:

```bash
git push <origin> --delete <b>
```

Never delete the default branch or the currently checked-out branch. Use `-d` (not `-D`) so
Git refuses to delete anything not fully merged, unless the user explicitly opts into a
force delete.

### Step 4 — Verify

Confirm local and origin now match upstream:

```bash
git branch -vv
git remote show <origin>
```

Report a final summary: which branches are now in sync, any that need manual attention.

## Mirror Mode (destructive, opt-in only)

If the user explicitly wants an exact mirror (discarding any origin-only or diverged history):

```bash
git fetch <upstream> --prune
git push <origin> --mirror   # DANGER: overwrites origin refs to match upstream
```

Never run Mirror Mode without explicit user confirmation, since it can delete or force-overwrite
branches and tags on origin.

## Safety Rules

1. Never force-push or reset without explicit user opt-in.
2. Stop on a dirty working tree.
3. On diverged branches, report and let the user decide — do not silently overwrite.
4. Always show the diff (Step 2) before pushing (Step 3).
5. When pruning merged branches (Step 3.5), use `git branch -d` (safe) not `-D`, and never
   delete the default or current branch. Confirm before deleting merged branches on origin.
