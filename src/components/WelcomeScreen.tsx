import Icon, { type IconName } from "./Icon";

const SUGGESTIONS: { icon: IconName; title: string; description: string; prompt: string }[] = [
  {
    icon: "compose",
    title: "Create a file or build a site",
    description: "Bring an idea to life.",
    prompt: "Help me create a file or build a website. Ask me what I need.",
  },
  {
    icon: "search",
    title: "Research and plan next steps",
    description: "Find clarity. Move forward.",
    prompt: "Research a topic for me and propose a plan with next steps.",
  },
  {
    icon: "document",
    title: "Get a briefing on recent work",
    description: "Catch up on what matters.",
    prompt: "Give me a briefing summarizing my recent work and open items.",
  },
  {
    icon: "clock",
    title: "Automate a recurring task",
    description: "Make more time for your work.",
    prompt: "Help me automate a routine or recurring task.",
  },
];

export default function WelcomeScreen({
  onPick,
}: {
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="welcome">
      <div className="welcome__logo" aria-hidden="true">
        <Icon name="sparkles" size={32} />
      </div>
      <h1 className="welcome__title">What should we get done?</h1>
      <p className="welcome__subtitle">A little help for your next big idea.</p>
      <div className="welcome__cards">
        {SUGGESTIONS.map((card) => (
          <button
            key={card.title}
            type="button"
            className="welcome__card"
            onClick={() => onPick(card.prompt)}
          >
            <span className="welcome__card-icon" aria-hidden="true">
              <Icon name={card.icon} />
            </span>
            <span className="welcome__card-copy">
              <span className="welcome__card-title">{card.title}</span>
              <span className="welcome__card-description">{card.description}</span>
            </span>
            <Icon name="arrow" size={16} className="welcome__card-arrow" />
          </button>
        ))}
      </div>
    </div>
  );
}
