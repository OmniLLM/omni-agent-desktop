import { SLASH_COMMANDS } from "../lib/slashCommands";

interface Props {
  onClose: () => void;
}

export default function HelpPanel({ onClose }: Props) {
  return (
    <div
      className="help-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Slash command help"
      >
        <div className="help-panel__header">
          <h2 className="help-panel__title">Slash commands</h2>
          <button
            type="button"
            className="help-panel__close"
            aria-label="Close help"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <ul className="help-panel__list">
          {SLASH_COMMANDS.map((cmd) => (
            <li key={cmd.name} className="help-panel__row">
              <code className="help-panel__cmd">
                /{cmd.name}
                {cmd.argHint ? ` ${cmd.argHint}` : ""}
              </code>
              <span className="help-panel__desc">{cmd.description}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
