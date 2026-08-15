## Context

The React `Composer` currently owns unsent text and attachments, handles recognized slash commands, and submits ordinary prompts through a void `onSend` callback. ArrowUp and ArrowDown are reserved only while slash autocomplete has matches; otherwise the browser applies native multiline textarea behavior. Saved conversation messages are owned and persisted by `useAgent`, but they are model transcript state rather than editable-input history.

A previous launcher implementation used transient newest-first input history capped at 50 entries, but it only entered history from an empty input and restored an empty string. The chat composer needs the same lightweight behavior adapted for multiline text, current-draft preservation, and existing slash-menu precedence.

## Goals / Non-Goals

**Goals:**

- Recall ordinary prompts submitted through the composer with Up/Down keyboard navigation.
- Preserve the exact unsent draft while the user temporarily browses history.
- Preserve native multiline caret and selection behavior outside defined logical-line boundaries.
- Keep slash autocomplete navigation unchanged and higher priority.
- Bound memory use and avoid redundant consecutive entries.
- Cover the interaction with deterministic component tests.

**Non-Goals:**

- Persisting prompt history across composer unmounts or application restarts.
- Hydrating input history from saved conversation transcripts.
- Restoring image attachments or other composer controls with a recalled prompt.
- Recording welcome suggestions, direct slash-generated agent prompts, or other calls that bypass ordinary composer submission.
- Changing frontend-sidecar RPC contracts, native behavior, provider integrations, credentials, or permissions.
- Detecting visual soft-wrapped rows; navigation boundaries are based on explicit newline-delimited logical lines.

## Decisions

### Keep history inside the mounted React composer

`Composer` will own a transient newest-first entry list plus traversal bookkeeping. This matches ownership of the controlled textarea and keeps an input-only interaction out of persisted conversation state.

The entries are retained across conversation changes while the same composer remains mounted, but naturally reset when the user switches to a workspace view that unmounts it or reloads the application.

**Alternative considered:** derive history from `useAgent.messages`. Rejected because transcripts include persisted sessions and prompt sources that bypass the composer, can expose a different conversation's history after session switching, and conflate model context with editable-input recall.

### Store entries and navigation bookkeeping in a ref

Use one ref containing:

- `entries: string[]`, newest first and capped at 50;
- `index: number | null`, where `null` means the user is not browsing;
- `draft: string`, the exact textarea value captured on the first Up press.

Only recalled text must render, so React state remains limited to the existing `text`. Ref updates are synchronous across rapid key events and do not cause unrelated rerenders.

**Alternative considered:** separate React state for entries, index, and draft. Rejected because no history list is rendered and asynchronous state updates would complicate consecutive keyboard events.

### Record accepted ordinary textual submissions

After local validation and recognized-slash interception, an ordinary submission will first check `disabled`. If enabled, it calls the existing `onSend`; after that callback returns normally, non-blank trimmed text is prepended unless it equals the current newest entry, and the list is truncated to 50.

This includes unknown slash text that falls through to ordinary submission and text sent alongside an image. It excludes image-only submissions and all recognized slash commands. Provider completion is not required: a prompt accepted into the current send path remains useful even if the later run reports an error.

Recognized slash commands remain eligible while ordinary submission is disabled so actions such as `/stop` retain their existing behavior. Ordinary disabled submissions preserve text and attachments rather than being silently cleared while `useAgent.send` rejects a concurrent run.

**Alternative considered:** change `onSend` to return an acknowledgement or promise. Rejected because the known active-run rejection is already represented by `disabled`; expanding component, app, and agent contracts is unnecessary for this local interaction.

### Preserve current drafts and stored history during traversal

The first consumed Up captures the exact current value, including whitespace, before replacing it with the newest history entry. Further Up presses move older and clamp at the oldest retained entry. Down moves newer; moving past the newest entry exits browsing and restores the captured draft exactly.

Text replacement focuses the textarea and places a collapsed caret at the end on the next animation frame, reusing the composer's existing imperative caret-placement pattern. Direct typing and programmatic text mutation exit traversal without editing stored entries. An edited recalled prompt is recorded only if it is later submitted normally.

**Alternative considered:** restore an empty input after the newest entry, as the former launcher did. Rejected because it would destroy partially written chat prompts.

### Give existing keyboard interactions strict precedence

The textarea handler evaluates interactions in this order:

1. Actionable slash autocomplete consumes its existing ArrowUp, ArrowDown, Escape, Tab, and unshifted Enter controls.
2. Prompt-history handling considers only unmodified, non-IME ArrowUp/ArrowDown with a collapsed selection.
3. Existing unshifted Enter submission remains unchanged; Shift+Enter remains native newline insertion.

Up may begin history traversal only when the caret is on the first logical line. Down only navigates while browsing and when the caret is on the last logical line. Once browsing has begun, Up still respects the first-line boundary and Down respects the last-line boundary, allowing native movement within a recalled multiline prompt before leaving that edge. Events are prevented only when a history transition is consumed.

Logical-line checks use explicit newline content before or after the collapsed caret. Native textareas do not expose reliable soft-wrap row geometry; mirror-DOM measurement would add font/layout-dependent complexity disproportionate to this feature.

**Alternative considered:** consume arrows whenever input is empty or browsing, regardless of caret. Rejected because multiline recalled prompts would lose ordinary vertical movement.

## Risks / Trade-offs

- **[History resets when the composer unmounts]** → This is intentional transient behavior; durable history can be proposed separately with privacy and storage controls.
- **[Logical lines differ from visually wrapped rows]** → Document and test explicit-newline boundaries; preserve native behavior inside a logical line rather than adding fragile geometry measurement.
- **[The void `onSend` callback cannot report every downstream rejection]** → Record after normal callback return and guard the known active-run path with `disabled`; do not broaden the public contract for hypothetical synchronous rejection modes.
- **[Programmatic textarea changes can leave stale traversal state]** → Explicitly reset traversal in `onChange`, imperative text APIs, slash completion, recognized command execution, and successful submission.
- **[In-memory history contains user prompt text]** → Keep it frontend-only, bounded to 50 strings, never persist or transmit it separately, and release it on unmount.

## Migration Plan

No data migration is required. Implement the behavior behind existing composer APIs, run focused and full frontend tests plus the production build, then strictly validate the OpenSpec change. Rollback consists of reverting the composer logic and specification delta; no stored data or wire compatibility must be restored.

## Open Questions

None. Durable history, transcript-derived history, attachment recall, and visual soft-wrap detection remain explicit future-scope decisions.
