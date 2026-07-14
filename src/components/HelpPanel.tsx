import { SLASH_COMMANDS, type SlashCommand } from "../lib/slashCommands";

interface Props {
  onClose: () => void;
  /** Invoked when a row is clicked. Callers decide whether to run the command
   * immediately (no-arg commands) or prefill the composer (argument commands). */
  onPick?: (cmd: SlashCommand) => void;
}

export default function HelpPanel({ onClose, onPick }: Props) {
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
        <ul className="help-panel__list" role="listbox">
          {SLASH_COMMANDS.map((cmd) => (
            <li key={cmd.name}>
              <button
                type="button"
                role="option"
                className="help-panel__row"
                onClick={() => onPick?.(cmd)}
                title={
                  cmd.kind === "argument"
                    ? `Insert /${cmd.name} into the composer`
                    : `Run /${cmd.name}`
                }
              >
                <code className="help-panel__cmd">
                  /{cmd.name}
                  {cmd.argHint ? ` ${cmd.argHint}` : ""}
                </code>
                <span className="help-panel__desc">{cmd.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
