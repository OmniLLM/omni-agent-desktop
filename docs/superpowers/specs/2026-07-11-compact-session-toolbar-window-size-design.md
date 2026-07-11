# Compact Session Toolbar and Window Size Presets

**Date:** 2026-07-11
**Status:** Approved

## Purpose

Simplify the chat interface by replacing the persistent session sidebar with a compact session-history dropdown, and let users choose a preferred native window size from Preferences.

## Scope

This change includes:

- A compact session toolbar above the transcript.
- A custom dropdown for selecting previous chat sessions.
- New-chat and current-session deletion controls.
- Three persisted native-window size presets.
- Immediate size preview with rollback when Preferences closes without saving.
- Component, settings, Rust, and app-level regression coverage.

This change does not include session search, session rename, alternate sorting, bulk deletion, or persistence of arbitrary manual window resizing.

## UI Structure

### Session toolbar

Replace the 210px `SessionBar` sidebar and the two-column `.agent-body` layout with a `SessionToolbar` above the transcript inside `.agent-main`.

The toolbar aligns with the existing 760px transcript and composer column. It contains:

1. A custom dropdown trigger showing the active session title or `New conversation` for an unsaved session.
2. A dropdown list whose rows show a truncated title, message count, and active state.
3. A visible `New chat` button.
4. An overflow menu containing `Delete current conversation`.

The delete action is disabled when the current session has not been persisted. Deleting requires confirmation. Clicking outside, pressing Escape, or selecting a session closes an open menu. Controls support keyboard navigation and suitable ARIA semantics.

### Window size presets

Add a `Window size` segmented control to **Preferences → Appearance**:

| Preset | Dimensions |
| --- | --- |
| Compact | 720 × 520 |
| Standard | 960 × 640 |
| Large | 1280 × 720 |

Standard is the default for new installations and for settings files without the field. The settings overlay must remain usable at Compact size by reducing outer padding as needed and keeping its content pane scrollable.

## Architecture

### Session state

`useAgent` remains the single owner of session data and behavior:

- `sessions`
- `currentSessionId`
- `newSession()`
- `switchSession(id)`
- `deleteSession(id)`

`SessionToolbar` receives these through props and owns only temporary presentation state, such as which menu is open. It must not duplicate session persistence or selection state. A separate dropdown component may be extracted only if needed to keep the toolbar focused and independently testable.

A new session displays `New conversation` until its first message creates a persisted session.

### Window size settings

Add the shared frontend type:

```ts
type WindowSizePreset = "compact" | "standard" | "large";
```

Add `window_size` to both the Rust `AppSettings` structure and the frontend `AppSettings` interface. Rust Serde defaults it to `standard` for backward compatibility.

Create a focused frontend window-size utility that maps presets to dimensions and applies a `LogicalSize` through the current Tauri window API.

The application flow is:

1. `App` loads settings.
2. The saved window-size preset is applied to the native window.
3. Opening Preferences records the originally saved preset.
4. Choosing another preset previews it immediately.
5. Clicking Save persists the selected preset.
6. Closing Preferences without a successful save restores the original preset.
7. Manual native-window resizing remains allowed but does not rewrite the preset.

The utility should constrain requested dimensions to the active monitor's usable area where the Tauri API provides the required information, preventing the window from becoming inaccessible on a smaller display.

## Data and Interaction Rules

### Session dropdown

- The active session is visually identified.
- Session titles are truncated visually but remain available via an accessible label or title.
- Message counts use the existing `message_count` value.
- Selecting a session invokes `switchSession(id)` and closes the dropdown only after initiating the selection.
- New chat invokes `newSession()` and closes all menus.
- Delete confirms intent, invokes `deleteSession(currentSessionId)`, and closes the overflow menu.

### Window preview and persistence

- The form selection changes only after the preview succeeds.
- A failed preview keeps the last successfully applied preset selected and shows an inline error.
- Save uses the existing `save_settings_cmd` flow.
- A successful Save updates the rollback baseline to the newly persisted preset.
- Closing without a successful Save restores the original preset.
- An unknown persisted value is normalized to `standard` before application.

## Error Handling

- A session-switch failure must not clear the current transcript or leave the toolbar showing the requested session as active.
- A session-deletion failure leaves the session present and surfaces a compact error associated with the toolbar action.
- A resize failure leaves the form open, preserves the last successful preset, and displays an inline error.
- A settings-save failure preserves existing error behavior and does not mark the previewed size as persisted.
- Failure to restore a size on close is reported without blocking Preferences from closing.
- Settings load failures continue to render the existing guarded error state and never substitute hardcoded settings in the form.

## Responsive Behavior

- Removing the sidebar restores the full viewport width to the chat area.
- The toolbar, transcript, approval prompt, and composer share the same centered content width.
- At narrow widths, the session trigger shrinks and truncates before the New and overflow buttons.
- The settings sheet remains within the viewport at Compact size and scrolls internally.
- Existing native minimum dimensions remain valid; presets do not change resizability.

## Testing

### Session toolbar tests

- Renders the active title and `New conversation` fallback.
- Opens and closes the session dropdown.
- Lists sessions with message counts and active state.
- Switches sessions and closes the dropdown.
- Creates a new session.
- Requires confirmation before deletion.
- Disables deletion for an unsaved session.
- Handles Escape, click-outside, and keyboard navigation.
- Retains the current selection when switching fails.
- Surfaces deletion failures without removing the session.

### Settings UI tests

- Renders Compact, Standard, and Large with their dimensions.
- Previews a selected preset through the window-size utility.
- Updates selection only after a successful preview.
- Persists the selected preset through Save.
- Restores the original preset when closed without saving.
- Uses the saved preset as the new rollback baseline after successful Save.
- Displays preview and restore failures without corrupting settings state.

### Rust settings tests

- Missing `window_size` deserializes as `standard`.
- Each valid preset round-trips through settings persistence.
- Invalid values normalize to `standard` or fail validation consistently; normalization is preferred for backward compatibility.
- Existing settings migration and validation tests continue to pass.

### App-level tests

- The session sidebar is replaced by the toolbar.
- The toolbar receives session state and actions from `useAgent`.
- The saved window size is applied after settings load.
- Compact sizing leaves the settings sheet and primary chat controls usable.

## Acceptance Criteria

1. Session history no longer consumes a permanent 210px sidebar.
2. Users can switch, create, and delete sessions from the compact toolbar.
3. The transcript and composer gain the recovered horizontal space.
4. Preferences offers Compact, Standard, and Large window-size presets.
5. Selecting a preset previews the native size immediately.
6. Save persists the selected preset for future launches.
7. Closing without saving restores the previously saved size.
8. Existing settings files load as Standard without manual migration.
9. Frontend tests, launcher tests, Rust tests, production build, and an end-to-end native UI verification pass.
