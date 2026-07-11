# Compact Session Toolbar and Window Size Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the persistent session sidebar with a compact accessible toolbar dropdown and add previewable, persisted native-window size presets.

**Architecture:** `useAgent` remains the session-state owner while a focused `SessionToolbar` owns only menu state and delegates actions. A pure `windowSize` module defines preset normalization and dimensions, while a small Tauri adapter applies sizes; Rust settings persist the preset with backward-compatible defaults.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Tauri 2 window APIs, Rust, Serde.

---

## File Structure

- Create `src/components/SessionToolbar.tsx`: compact session selector, New action, overflow menu, confirmation, and transient action errors.
- Create `src/components/SessionToolbar.test.tsx`: interaction, accessibility, failure, and keyboard coverage.
- Delete `src/components/SessionBar.tsx`: replaced by the toolbar.
- Create `src/lib/windowSize.ts`: preset type, dimensions, normalization, and native resize adapter.
- Create `src/lib/windowSize.test.ts`: pure mapping plus Tauri adapter behavior.
- Modify `src/types/app.ts`: add the shared persisted preset field.
- Modify `src-tauri/src/settings.rs`: add the Rust preset enum, Serde fallback, persistence coverage, and default.
- Modify `src/components/SettingsWindow.tsx`: render preset control, preview sizes, maintain rollback baseline, and restore on unsaved close.
- Modify `src/components/SettingsWindow.test.tsx`: test preview, save, rollback, and error behavior.
- Modify `src/App.tsx`: replace the sidebar, apply saved size on load, and connect toolbar errors.
- Modify `src/App.test.tsx`: verify toolbar integration and saved-size application.
- Modify `src/styles/layout/agent.css`: remove sidebar rules and add centered responsive toolbar rules.
- Modify `src/styles/panels/chrome.css`: keep Preferences usable at Compact size.
- Modify `src/test/setup.ts`: extend the global Tauri window mock with sizing/monitor methods.

### Task 1: Persist a Backward-Compatible Window Size Preset

**Files:**
- Modify: `src-tauri/src/settings.rs:150-232`
- Modify: `src-tauri/src/settings.rs:598-629`
- Modify: `src/types/app.ts:55-84`

- [ ] **Step 1: Write failing Rust default and round-trip tests**

Add to the settings test module:

```rust
#[test]
fn window_size_defaults_to_standard() {
    let settings: AppSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(settings.window_size, WindowSizePreset::Standard);
}

#[test]
fn window_size_presets_roundtrip() {
    for preset in [
        WindowSizePreset::Compact,
        WindowSizePreset::Standard,
        WindowSizePreset::Large,
    ] {
        let mut settings = AppSettings::default();
        settings.window_size = preset;
        let json = serde_json::to_string(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.window_size, preset);
    }
}

#[test]
fn unknown_window_size_normalizes_to_standard() {
    let settings: AppSettings = serde_json::from_str(
        r#"{"window_size":"future-size"}"#,
    )
    .unwrap();
    assert_eq!(settings.window_size, WindowSizePreset::Standard);
}
```

- [ ] **Step 2: Run the targeted Rust tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml window_size -- --nocapture
```

Expected: compilation fails because `WindowSizePreset` and `AppSettings.window_size` do not exist.

- [ ] **Step 3: Add the minimal Rust enum and settings field**

Add before `AppSettings`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowSizePreset {
    Compact,
    Standard,
    Large,
}

impl Default for WindowSizePreset {
    fn default() -> Self {
        Self::Standard
    }
}

impl<'de> Deserialize<'de> for WindowSizePreset {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "compact" => Self::Compact,
            "large" => Self::Large,
            _ => Self::Standard,
        })
    }
}
```

Add to `AppSettings`:

```rust
#[serde(default)]
pub window_size: WindowSizePreset,
```

Add to `Default`:

```rust
window_size: WindowSizePreset::default(),
```

- [ ] **Step 4: Add the matching frontend type**

Add to `src/types/app.ts`:

```ts
export type WindowSizePreset = "compact" | "standard" | "large";
```

Add to `AppSettings`:

```ts
window_size: WindowSizePreset;
```

- [ ] **Step 5: Run targeted and full Rust tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml window_size -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all new tests pass; the full existing Rust suite passes with zero failures.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/settings.rs src/types/app.ts
git commit -m "feat: persist window size presets"
```

### Task 2: Implement and Test the Window Size Adapter

**Files:**
- Create: `src/lib/windowSize.ts`
- Create: `src/lib/windowSize.test.ts`
- Modify: `src/test/setup.ts:38-46`

- [ ] **Step 1: Write failing mapping and adapter tests**

Create `src/lib/windowSize.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  applyWindowSize,
  normalizeWindowSize,
  WINDOW_SIZE_OPTIONS,
} from "./windowSize";

const currentWindow = vi.mocked(getCurrentWebviewWindow);

describe("windowSize", () => {
  beforeEach(() => {
    currentWindow.mockReturnValue({
      setSize: vi.fn(async () => undefined),
      currentMonitor: vi.fn(async () => ({
        size: { width: 1920, height: 1080 },
        scaleFactor: 1,
      })),
    } as never);
  });

  it("maps the three balanced presets", () => {
    expect(WINDOW_SIZE_OPTIONS).toEqual([
      { value: "compact", label: "Compact", width: 720, height: 520 },
      { value: "standard", label: "Standard", width: 960, height: 640 },
      { value: "large", label: "Large", width: 1280, height: 720 },
    ]);
  });

  it("normalizes unknown values to standard", () => {
    expect(normalizeWindowSize("future-size")).toBe("standard");
    expect(normalizeWindowSize(undefined)).toBe("standard");
  });

  it("applies the selected logical size", async () => {
    const win = currentWindow();
    await applyWindowSize("compact");
    expect(win.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 720, height: 520 }),
    );
  });

  it("clamps a preset to the monitor work area", async () => {
    const win = currentWindow();
    vi.mocked(win.currentMonitor).mockResolvedValue({
      size: { width: 800, height: 600 },
      scaleFactor: 1,
    } as never);
    await applyWindowSize("large");
    expect(win.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 800, height: 600 }),
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
npm test -- src/lib/windowSize.test.ts
```

Expected: FAIL because `./windowSize` does not exist.

- [ ] **Step 3: Extend the shared Tauri window mock**

Update the mock window in `src/test/setup.ts`:

```ts
setSize: vi.fn(async () => {}),
currentMonitor: vi.fn(async () => ({
  size: { width: 1920, height: 1080 },
  scaleFactor: 1,
})),
```

- [ ] **Step 4: Implement the focused adapter**

Create `src/lib/windowSize.ts`:

```ts
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WindowSizePreset } from "../types/app";

export const WINDOW_SIZE_OPTIONS = [
  { value: "compact", label: "Compact", width: 720, height: 520 },
  { value: "standard", label: "Standard", width: 960, height: 640 },
  { value: "large", label: "Large", width: 1280, height: 720 },
] as const;

export function normalizeWindowSize(value: unknown): WindowSizePreset {
  return value === "compact" || value === "large" ? value : "standard";
}

export async function applyWindowSize(preset: WindowSizePreset): Promise<void> {
  const option = WINDOW_SIZE_OPTIONS.find((item) => item.value === preset)!;
  const win = getCurrentWebviewWindow();
  const monitor = await win.currentMonitor().catch(() => null);
  const scale = monitor?.scaleFactor || 1;
  const maxWidth = monitor ? Math.floor(monitor.size.width / scale) : option.width;
  const maxHeight = monitor ? Math.floor(monitor.size.height / scale) : option.height;
  await win.setSize(
    new LogicalSize(
      Math.min(option.width, maxWidth),
      Math.min(option.height, maxHeight),
    ),
  );
}
```

- [ ] **Step 5: Run the adapter tests and confirm GREEN**

Run:

```bash
npm test -- src/lib/windowSize.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/windowSize.ts src/lib/windowSize.test.ts src/test/setup.ts
git commit -m "feat: add native window size adapter"
```

### Task 3: Replace the Session Sidebar with a Tested Toolbar

**Files:**
- Create: `src/components/SessionToolbar.tsx`
- Create: `src/components/SessionToolbar.test.tsx`
- Delete: `src/components/SessionBar.tsx`

- [ ] **Step 1: Write failing toolbar interaction tests**

Create `src/components/SessionToolbar.test.tsx` with representative session data and these tests:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SessionToolbar from "./SessionToolbar";

const sessions = [
  { id: "s1", title: "First conversation", updated_at: 2, message_count: 4 },
  { id: "s2", title: "Second conversation", updated_at: 1, message_count: 9 },
];

function renderToolbar(overrides = {}) {
  const props = {
    sessions,
    currentSessionId: "s1",
    onNew: vi.fn(),
    onSwitch: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  };
  render(<SessionToolbar {...props} />);
  return props;
}

it("shows the current title and switches from the dropdown", async () => {
  const user = userEvent.setup();
  const props = renderToolbar();
  await user.click(screen.getByRole("button", { name: /first conversation/i }));
  expect(screen.getByText("9 messages")).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: /second conversation/i }));
  expect(props.onSwitch).toHaveBeenCalledWith("s2");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("creates a new chat and closes menus", async () => {
  const user = userEvent.setup();
  const props = renderToolbar();
  await user.click(screen.getByRole("button", { name: /new chat/i }));
  expect(props.onNew).toHaveBeenCalledOnce();
});

it("confirms before deleting the current session", async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const props = renderToolbar();
  await user.click(screen.getByRole("button", { name: /conversation actions/i }));
  await user.click(screen.getByRole("menuitem", { name: /delete current/i }));
  expect(confirm).toHaveBeenCalled();
  expect(props.onDelete).toHaveBeenCalledWith("s1");
});

it("disables deletion for an unsaved conversation", async () => {
  const user = userEvent.setup();
  renderToolbar({ currentSessionId: null });
  expect(screen.getByText("New conversation")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /conversation actions/i }));
  expect(screen.getByRole("menuitem", { name: /delete current/i })).toBeDisabled();
});

it("reports switch failures and keeps the active title", async () => {
  const user = userEvent.setup();
  renderToolbar({ onSwitch: vi.fn(async () => { throw new Error("load failed"); }) });
  await user.click(screen.getByRole("button", { name: /first conversation/i }));
  await user.click(screen.getByRole("option", { name: /second conversation/i }));
  expect(await screen.findByRole("status")).toHaveTextContent("load failed");
  expect(screen.getByRole("button", { name: /first conversation/i })).toBeInTheDocument();
});
```

Add two more tests in the same file:

```tsx
it("closes an open dropdown with Escape", async () => {
  const user = userEvent.setup();
  renderToolbar();
  await user.click(screen.getByRole("button", { name: /first conversation/i }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("reports deletion failures without changing the active session", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderToolbar({ onDelete: vi.fn(async () => { throw new Error("delete failed"); }) });
  await user.click(screen.getByRole("button", { name: /conversation actions/i }));
  await user.click(screen.getByRole("menuitem", { name: /delete current/i }));
  expect(await screen.findByRole("status")).toHaveTextContent("delete failed");
  expect(screen.getByRole("button", { name: /first conversation/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the toolbar tests and confirm RED**

Run:

```bash
npm test -- src/components/SessionToolbar.test.tsx
```

Expected: FAIL because `SessionToolbar` does not exist.

- [ ] **Step 3: Implement the minimal accessible toolbar**

Create `SessionToolbar.tsx` with this public interface:

```ts
interface Props {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  onNew: () => void;
  onSwitch: (id: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
}
```

Implementation requirements:

```tsx
const activeSession = sessions.find((session) => session.id === currentSessionId);
const activeTitle = activeSession?.title ?? "New conversation";
```

Use a `role="listbox"` dropdown with `role="option"` session buttons, render message text as `${count} ${count === 1 ? "message" : "messages"}`, close on document pointer-down outside and Escape, and wrap `await onSwitch(id)` / `await onDelete(id)` in `try/catch` that renders `role="status"` with the thrown message. Use `window.confirm("Delete this conversation? This cannot be undone.")` before deletion.

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
npm test -- src/components/SessionToolbar.test.tsx
```

Expected: all toolbar tests pass.

- [ ] **Step 5: Delete the obsolete sidebar component**

```bash
git rm src/components/SessionBar.tsx
```

- [ ] **Step 6: Commit**

```bash
git add src/components/SessionToolbar.tsx src/components/SessionToolbar.test.tsx
git commit -m "feat: replace session sidebar with toolbar"
```

### Task 4: Integrate the Toolbar and Simplify Chat Layout

**Files:**
- Modify: `src/App.test.tsx:1-40`
- Modify: `src/App.tsx:1-108`
- Modify: `src/styles/layout/agent.css:24-143`

- [ ] **Step 1: Write a failing App integration test**

Extend `src/App.test.tsx`:

```tsx
it("renders compact session controls instead of a session sidebar", async () => {
  render(<App />);
  expect(await screen.findByRole("button", { name: /new chat/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /new conversation/i })).toBeInTheDocument();
  expect(document.querySelector(".session-bar")).toBeNull();
  expect(document.querySelector(".session-toolbar")).not.toBeNull();
});
```

- [ ] **Step 2: Run the App test and confirm RED**

Run:

```bash
npm test -- src/App.test.tsx
```

Expected: FAIL because App still renders `SessionBar` and `.session-bar`.

- [ ] **Step 3: Replace `SessionBar` in App**

Change the import to:

```ts
import SessionToolbar from "./components/SessionToolbar";
```

Change the layout to:

```tsx
<div className="agent-main">
  <SessionToolbar
    sessions={sessions}
    currentSessionId={currentSessionId}
    onNew={newSession}
    onSwitch={switchSession}
    onDelete={deleteSession}
  />
  <div className="chat-scroll" ref={scrollRef}>
    <ChatPane messages={messages} loading={loading} />
  </div>
  {pendingApproval ? (
    <ToolApprovalPrompt call={pendingApproval} onDecide={decide} />
  ) : null}
  <Composer onSend={send} disabled={loading} />
</div>
```

Remove the `.agent-body` wrapper.

- [ ] **Step 4: Replace sidebar CSS with centered toolbar CSS**

Remove `.agent-body`, `.session-bar`, `.session-new`, `.session-list`, `.session-item`, `.session-open`, `.session-title`, `.session-count`, and `.session-delete` rules. Add:

```css
.session-toolbar {
  position: relative;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% - 36px);
  max-width: 760px;
  margin: 0 auto;
  padding: 10px 0 8px;
  border-bottom: 1px solid var(--border);
}

.session-picker {
  position: relative;
  flex: 1;
  min-width: 0;
}

.session-picker__trigger,
.session-toolbar__new,
.session-toolbar__more {
  min-height: 34px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

.session-picker__trigger {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  text-align: left;
}

.session-picker__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-picker__menu,
.session-actions__menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
}

.session-actions__menu {
  right: 0;
  left: auto;
  min-width: 210px;
}

.session-toolbar__status {
  position: absolute;
  top: 100%;
  left: 0;
  color: var(--danger);
  font-size: 11px;
}
```

Add compact responsive rules:

```css
@media (max-width: 620px) {
  .session-toolbar {
    width: calc(100% - 24px);
  }

  .session-toolbar__new span {
    display: none;
  }
}
```

- [ ] **Step 5: Run component and App tests**

Run:

```bash
npm test -- src/components/SessionToolbar.test.tsx src/App.test.tsx
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/styles/layout/agent.css
git commit -m "refactor: simplify chat session layout"
```

### Task 5: Add Previewable Window Presets to Preferences

**Files:**
- Modify: `src/components/SettingsWindow.tsx:74-306`
- Modify: `src/components/SettingsWindow.tsx:700-767`
- Modify: `src/components/SettingsWindow.test.tsx`
- Modify: `src/styles/panels/chrome.css`

- [ ] **Step 1: Add a test settings fixture field**

Update every `AppSettings` fixture returned by `get_settings` in `SettingsWindow.test.tsx` with:

```ts
window_size: "standard",
```

- [ ] **Step 2: Write failing preview, save, rollback, and error tests**

Mock `applyWindowSize` at the top of `SettingsWindow.test.tsx`:

```ts
const applyWindowSize = vi.fn(async () => undefined);
vi.mock("../lib/windowSize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/windowSize")>();
  return { ...actual, applyWindowSize };
});
```

Add tests:

```tsx
it("previews and saves a window size preset", async () => {
  const user = userEvent.setup();
  const SettingsWindow = await importSettingsWindow();
  render(<SettingsWindow />);
  await user.click(await screen.findByRole("button", { name: /appearance/i }));
  await user.click(screen.getByRole("radio", { name: /compact.*720.*520/i }));
  expect(applyWindowSize).toHaveBeenCalledWith("compact");
  await user.click(screen.getByRole("button", { name: /^save$/i }));
  expect(invoke).toHaveBeenCalledWith(
    "save_settings_cmd",
    expect.objectContaining({
      settings: expect.objectContaining({ window_size: "compact" }),
    }),
  );
});

it("restores the original size when closed without saving", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const SettingsWindow = await importSettingsWindow();
  render(<SettingsWindow onClose={onClose} />);
  await user.click(await screen.findByRole("button", { name: /appearance/i }));
  await user.click(screen.getByRole("radio", { name: /large.*1280.*720/i }));
  await user.click(screen.getByRole("button", { name: /close/i }));
  expect(applyWindowSize).toHaveBeenLastCalledWith("standard");
  expect(onClose).toHaveBeenCalled();
});

it("keeps the previous selection when preview fails", async () => {
  applyWindowSize.mockRejectedValueOnce(new Error("resize failed"));
  const user = userEvent.setup();
  const SettingsWindow = await importSettingsWindow();
  render(<SettingsWindow />);
  await user.click(await screen.findByRole("button", { name: /appearance/i }));
  await user.click(screen.getByRole("radio", { name: /compact.*720.*520/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent("resize failed");
  expect(screen.getByRole("radio", { name: /standard.*960.*640/i })).toBeChecked();
});
```

- [ ] **Step 3: Run tests and confirm RED**

Run:

```bash
npm test -- src/components/SettingsWindow.test.tsx
```

Expected: FAIL because the window-size controls and rollback behavior do not exist.

- [ ] **Step 4: Add preview state and close semantics**

Import:

```ts
import {
  applyWindowSize,
  normalizeWindowSize,
  WINDOW_SIZE_OPTIONS,
} from "../lib/windowSize";
```

Add state:

```ts
const [savedWindowSize, setSavedWindowSize] = useState<WindowSizePreset>("standard");
const [windowSizeError, setWindowSizeError] = useState("");
const savedWindowSizeRef = useRef<WindowSizePreset>("standard");
```

After settings load:

```ts
const preset = normalizeWindowSize(s.window_size);
s.window_size = preset;
savedWindowSizeRef.current = preset;
setSavedWindowSize(preset);
```

Add helpers:

```ts
const previewWindowSize = async (preset: WindowSizePreset) => {
  setWindowSizeError("");
  try {
    await applyWindowSize(preset);
    setSettings((current) => current && { ...current, window_size: preset });
  } catch (error) {
    setWindowSizeError(error instanceof Error ? error.message : String(error));
  }
};

const closeSettings = async () => {
  if (settings?.window_size !== savedWindowSizeRef.current) {
    await applyWindowSize(savedWindowSizeRef.current).catch((error) => {
      console.error("Failed to restore window size:", error);
    });
  }
  onClose?.();
};
```

Use `closeSettings` for the titlebar Close action. After successful save:

```ts
const persistedPreset = normalizeWindowSize(settings.window_size);
savedWindowSizeRef.current = persistedPreset;
setSavedWindowSize(persistedPreset);
```

Use the existing Escape behavior in `App` only to request Settings closure through a callback that invokes the same rollback path; do not bypass `closeSettings`.

- [ ] **Step 5: Render the preset radio group**

In Appearance, immediately after Theme:

```tsx
<div style={rowStyle()}>
  <span style={rowLabelStyle}>Window size</span>
  <div className="window-size-options" role="radiogroup" aria-label="Window size">
    {WINDOW_SIZE_OPTIONS.map((option) => (
      <label key={option.value} className="window-size-option">
        <input
          type="radio"
          name="window-size"
          value={option.value}
          checked={settings.window_size === option.value}
          onChange={() => previewWindowSize(option.value)}
        />
        <span>
          <strong>{option.label}</strong>
          <small>{option.width} × {option.height}</small>
        </span>
      </label>
    ))}
  </div>
  {windowSizeError ? <span role="alert">{windowSizeError}</span> : null}
</div>
```

Remove the unused `savedWindowSize` state if only the ref is needed after implementation; retain one source of truth.

- [ ] **Step 6: Make Preferences fit Compact size**

In `src/styles/panels/chrome.css`, add:

```css
.window-size-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.window-size-option {
  display: flex;
  gap: 7px;
  align-items: center;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}

.window-size-option span {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.window-size-option small {
  color: var(--sub);
  font-size: 10px;
}

@media (max-width: 760px), (max-height: 580px) {
  .settings-overlay {
    padding: 8px;
  }

  .settings-sheet {
    max-height: calc(100vh - 16px);
  }
}
```

- [ ] **Step 7: Run Settings tests and confirm GREEN**

Run:

```bash
npm test -- src/components/SettingsWindow.test.tsx
```

Expected: all Settings tests pass, including preview, save, rollback, and error tests.

- [ ] **Step 8: Commit**

```bash
git add src/components/SettingsWindow.tsx src/components/SettingsWindow.test.tsx src/styles/panels/chrome.css
git commit -m "feat: configure window size in preferences"
```

### Task 6: Apply the Saved Preset at Startup and Unify Settings Closure

**Files:**
- Modify: `src/App.tsx:14-104`
- Modify: `src/App.test.tsx`
- Modify: `src/components/SettingsWindow.tsx`

- [ ] **Step 1: Write a failing startup application test**

At the top of `App.test.tsx`, mock the adapter:

```ts
const applyWindowSize = vi.fn(async () => undefined);
vi.mock("./lib/windowSize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/windowSize")>();
  return { ...actual, applyWindowSize };
});
```

Add `window_size: "compact"` to the settings fixture and add:

```tsx
it("applies the saved window size after settings load", async () => {
  render(<App />);
  await waitFor(() => expect(applyWindowSize).toHaveBeenCalledWith("compact"));
});
```

- [ ] **Step 2: Run the App test and confirm RED**

Run:

```bash
npm test -- src/App.test.tsx
```

Expected: FAIL because App does not call `applyWindowSize`.

- [ ] **Step 3: Apply normalized size after settings load**

Import:

```ts
import { applyWindowSize, normalizeWindowSize } from "./lib/windowSize";
```

Inside the successful `get_settings` handler:

```ts
const preset = normalizeWindowSize(s.window_size);
setSettings({ ...s, window_size: preset });
void applyWindowSize(preset).catch((error) => {
  console.error("Failed to apply saved window size:", error);
});
```

- [ ] **Step 4: Route overlay and Escape closure through SettingsWindow**

Expose a close-request mechanism from `SettingsWindow`, such as an imperative `requestClose` ref with a single `closeSettings` implementation. `App` must invoke that request for titlebar Close, backdrop click, and Escape. The public behavior must remain:

```ts
await restoreUnsavedPreview();
setShowSettings(false);
```

Add an App test that selects a preview size, presses Escape, and expects the adapter's final call to restore the original preset before the dialog disappears.

- [ ] **Step 5: Run App and Settings tests**

Run:

```bash
npm test -- src/App.test.tsx src/components/SettingsWindow.test.tsx
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/SettingsWindow.tsx
git commit -m "feat: apply saved window size on startup"
```

### Task 7: Full Verification and Native UI Exercise

**Files:**
- Modify only if verification reveals a defect.

- [ ] **Step 1: Run formatting and whitespace checks**

Run:

```bash
npx prettier --check "src/**/*.{ts,tsx,css}" "docs/**/*.md"
git diff --check
```

Expected: both commands exit 0. If Prettier reports changed files, run the repository's formatter on only those files, review the diff, and repeat the check.

- [ ] **Step 2: Run all frontend and launcher tests**

Run:

```bash
npm test
npm run test:launcher
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run all Rust tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all Rust tests pass with zero failures; existing warnings may remain but no new warnings should originate from changed code.

- [ ] **Step 4: Build the frontend**

Run:

```bash
npm run build
```

Expected: TypeScript and Vite finish successfully.

- [ ] **Step 5: Exercise the native UI end to end**

Invoke the project `verify` skill, launch the Tauri app, and observe these behaviors:

1. The chat has no permanent session sidebar.
2. The toolbar dropdown opens, lists sessions, switches sessions, and closes via Escape.
3. New chat produces the `New conversation` label.
4. Delete requires confirmation.
5. Preferences → Appearance shows all three presets.
6. Compact resizes to 720×520 when the monitor permits it.
7. Closing Preferences without Save restores the prior size.
8. Saving Compact, closing, and relaunching applies Compact.
9. Settings and primary chat controls remain usable at Compact size.

Expected: every behavior is directly observed; capture any failure before claiming completion.

- [ ] **Step 6: Review the final diff**

Run:

```bash
git status --short
git diff --stat HEAD~6..HEAD
git diff --check
```

Expected: only intended source, tests, styles, and plan/spec changes are present; no generated build artifacts are tracked.

- [ ] **Step 7: Commit verification fixes if needed**

If Step 1-6 required fixes:

```bash
git add <only-the-fixed-files>
git commit -m "fix: address compact UI verification findings"
```

If no fixes were needed, do not create an empty commit.
