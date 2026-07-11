import { getCurrentWebviewWindow } from "../lib/runtime";

/**
 * Custom window controls (minimize / maximize / close) for the frameless
 * Tauri window. The strip is `data-tauri-drag-region` so the empty area acts
 * as a draggable titlebar; the buttons opt out of dragging via `no-drag`.
 */
export default function Titlebar() {
  const win = () => getCurrentWebviewWindow();

  return (
    <div className="titlebar">
      <div className="titlebar__drag" data-tauri-drag-region />
      <div className="titlebar__controls">
        <button
          type="button"
          className="titlebar__btn"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => void win().minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar__btn"
          aria-label="Maximize"
          title="Maximize"
          onClick={() => void win().toggleMaximize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              fill="none"
              stroke="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar__btn titlebar__btn--close"
          aria-label="Close"
          title="Close"
          onClick={() => void win().close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M0 0 L10 10 M10 0 L0 10"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
