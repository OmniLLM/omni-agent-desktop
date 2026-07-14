import type { SlashCommand } from "../lib/slashCommands";

interface Props {
  commands: SlashCommand[];
  activeIndex: number;
  idPrefix: string;
  onHover: (index: number) => void;
  onPick: (cmd: SlashCommand) => void;
}

export default function SlashMenu({
  commands,
  activeIndex,
  idPrefix,
  onHover,
  onPick,
}: Props) {
  if (commands.length === 0) return null;
  return (
    <div
      id="slash-menu"
      className="slash-dropdown"
      role="listbox"
      aria-label="Slash commands"
    >
      {commands.map((cmd, index) => (
        <div
          key={cmd.name}
          id={`${idPrefix}-${index}`}
          role="option"
          aria-selected={index === activeIndex}
          className={`slash-dropdown__item${
            index === activeIndex ? " slash-dropdown__item--active" : ""
          }`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(cmd)}
        >
          <div className="slash-dropdown__header">
            <span className="slash-dropdown__cmd">
              /{cmd.name}
              {cmd.argHint ? ` ${cmd.argHint}` : ""}
            </span>
            <span className="slash-dropdown__shortcut">{cmd.kind}</span>
          </div>
          <div className="slash-dropdown__desc">{cmd.description}</div>
        </div>
      ))}
    </div>
  );
}
