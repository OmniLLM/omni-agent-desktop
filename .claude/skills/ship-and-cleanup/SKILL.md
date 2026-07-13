---
name: ship-and-cleanup
description: Commit and push all pending changes on the current branch, merge any additional local feature branches into main, then delete every branch and worktree that is fully merged. Use when the user says "commit and push all", "ship everything", "merge to main and clean up", "close merged branches", "prune worktrees", or otherwise asks to finalize + tidy the repo in one shot.
---

# Ship and cleanup

One-shot: land pending work on `main`, then remove branches and worktrees whose commits are already on `main`. Non-destructive by design — nothing with unmerged commits is deleted.

## Preconditions

- Repo has a remote named `origin` and a branch named `main` (adjust if the project uses `master` / `trunk`).
- Author identity is set per `~/.claude/CLAUDE.md`:
  - `ghosthub.corp.blizzard.net` remotes → `--author="James Zhu <jzhu@blizzard.com>"`; mention "James Zhu (jzhu@blizzard.com)" in PR body.
  - Everything else → `--author="James Zhu <zhujian0805@gmail.com>"`.
- **Never** add `Co-Authored-By:` lines to commit messages.
- **Never** run destructive git ops beyond what this skill lists (no `push --force`, no `reset --hard` on `main`, no `checkout .`).

## Steps

### 1. Survey the repo

```bash
git remote -v
git status
git worktree list
git branch -vv
git branch --merged main
```

Confirm current branch, uncommitted files, tracked worktrees, and which branches are already fully in `main`.

### 2. Commit pending changes on the current branch

If `git status` shows modifications:

- Stage only the intended files by name — **never** `git add -A` / `git add .` (may pick up secrets or bundle artefacts).
- Skip anything that looks like a secret (`.env`, `credentials.json`, keyring dumps).
- Write the commit message via a single-quoted heredoc so `$` and backticks stay literal.
- Author flag per Preconditions.
- Do not amend; create a new commit.

```bash
git add <explicit paths…>
git commit --author="James Zhu <zhujian0805@gmail.com>" -m "$(cat <<'EOF'
<type>: <subject>

<why, not just what>
EOF
)"
```

If a pre-commit hook fails: fix the root cause, re-stage, create another new commit (never `--amend`, never `--no-verify`).

### 3. Push the current branch

```bash
git push origin <current-branch>
```

If the branch has no upstream yet: `git push -u origin <current-branch>`.

### 4. Merge local feature branches into main

For each local branch other than `main` that has commits not yet on `main`:

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff <branch> -m "Merge branch '<branch>'"
git push origin main
```

Rules:
- Use `--no-ff` so the merge is a distinct commit (easier to unwind).
- If merge fails with conflicts, **stop** and surface the conflict to the user. Do not resolve blindly.
- If a branch is already an ancestor of `main` (fast-forward would be a no-op), skip it — step 5 will clean it up.

### 5. Delete merged local branches

```bash
git branch --merged main | grep -v '^\*' | grep -vE '^\s*(main|master|trunk|release/.*)\s*$' | xargs -r git branch -d
```

- `-d` (not `-D`) so git refuses to drop anything with unmerged commits.
- Never touch `main`, `master`, `trunk`, or `release/*`.

### 6. Delete merged remote branches (optional; ask first if unsure)

```bash
# Preview:
git branch -r --merged main | grep -v 'origin/HEAD' | grep -v 'origin/main'
# Delete each:
git push origin --delete <branch>
```

Only run for branches the user owns or has authority over. On shared repos with protected default branch, prefer the GitHub UI / `gh pr merge --delete-branch` instead.

### 7. Remove worktrees whose branch is merged

```bash
git worktree list
```

For each worktree at path `P` whose branch is now merged (i.e. removed in step 5, or its HEAD is an ancestor of `main`):

```bash
git worktree remove <P>          # refuses if the worktree is dirty
git worktree prune                # tidy stale entries
```

- Never `--force` a dirty worktree away without user confirmation.
- If `EnterWorktree` was used earlier in this session, prefer `ExitWorktree` with `action: "remove"`.

### 8. Verify

```bash
git status
git branch -a
git worktree list
git log --oneline -5
```

Repo should be on `main`, clean, with no leftover merged branches or worktrees, and the latest commit pushed to `origin/main`.

## Failure modes to watch for

- **Push rejected (non-fast-forward)**: another commit landed on `origin/main`. Run `git pull --rebase origin main`, resolve conflicts if any, then push. Never `push --force` to a shared branch.
- **Branch not fully merged**: `git branch -d` will refuse. Investigate why (rebase drift, cherry-picked commits, WIP) — do not escalate to `-D` without the user's explicit go-ahead.
- **Worktree remove refuses**: worktree has uncommitted files. List them for the user; wait for direction before `--force`.
- **Hook signing/GPG failure**: never bypass with `--no-gpg-sign` or `-c commit.gpgsign=false`; fix the key/agent.

## Scope note

This skill assumes a linear "land work → clean up" flow on a personal or small-team repo. For projects with a PR-based workflow, merge via `gh pr merge --squash --delete-branch` inside step 4 instead of a raw `git merge`, and skip step 6.
