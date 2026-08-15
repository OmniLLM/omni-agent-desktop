## Why

The keyboard-first chat composer makes users retype or manually copy a prior prompt whenever they want to repeat or revise it. Shell-style Up/Down recall makes iterative prompting faster while preserving the user's current unsent draft.

## What Changes

- Retain up to 50 ordinary textual composer submissions in transient frontend memory.
- Let ArrowUp recall older prompts and ArrowDown move toward newer prompts, restoring the exact pre-navigation draft after the newest history entry.
- Preserve native multiline caret/selection behavior until the caret reaches a logical boundary, and keep slash-menu arrow navigation higher priority than prompt recall.
- Exit prompt-history traversal when recalled text is edited, without mutating stored entries.
- Exclude recognized slash actions, welcome-card prompts, direct programmatic agent prompts, and image-only submissions from composer history.
- Do not clear or record an ordinary prompt when submission is disabled by an active run.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-shell`: Extend the keyboard-first workspace with transient composer prompt-history navigation and draft restoration.

## Impact

- **Affected code:** React `Composer` keyboard handling, submission bookkeeping, and focused Vitest/React Testing Library coverage.
- **Persisted data:** No change; prompt history exists only for the lifetime of the mounted composer and is not hydrated from saved conversations.
- **Credentials:** No change.
- **RPC contracts:** No change.
- **Native permissions or shell behavior:** No change.
- **Provider compatibility:** No change; recalled prompts follow the existing composer submission path.
- **Non-goals:** Attachment recall, durable prompt-history persistence, deriving history from saved transcripts, and including prompt sources that bypass the composer.
