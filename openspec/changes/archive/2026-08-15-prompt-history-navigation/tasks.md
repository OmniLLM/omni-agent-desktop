## 1. Prompt History State

- [x] 1.1 Add bounded newest-first prompt-history storage and logical-line/selection boundary helpers to `Composer`.
- [x] 1.2 Add traversal reset, recalled-text display, draft capture/restoration, and older/newer navigation helpers.
- [x] 1.3 Reset active traversal from direct textarea edits and programmatic composer mutation paths without changing retained entries.

## 2. Submission and Keyboard Integration

- [x] 2.1 Record accepted ordinary non-blank textual submissions with trimming, consecutive deduplication, and a 50-entry limit while excluding recognized slash commands and image-only sends.
- [x] 2.2 Preserve ordinary drafts and attachments when submission is disabled, without blocking recognized slash actions.
- [x] 2.3 Integrate unmodified, non-IME ArrowUp/ArrowDown traversal after slash-menu handling and before Enter submission, preserving native multiline and selection behavior when navigation is not consumed.

## 3. Automated Coverage

- [x] 3.1 Add focused component tests for older/newer traversal, oldest-entry clamping, empty and non-empty draft restoration, and editing recalled text.
- [x] 3.2 Add focused component tests for logical-line boundaries, selections/modifiers, and slash-menu arrow precedence.
- [x] 3.3 Add focused component tests for deduplication, retention bounds, accepted/excluded prompt sources, and disabled submission preservation.

## 4. Validation

- [x] 4.1 Run the focused Composer Vitest file and resolve failures.
- [x] 4.2 Run the complete frontend Vitest suite and production frontend build.
- [x] 4.3 Run strict OpenSpec validation for the change and all repository specifications.
