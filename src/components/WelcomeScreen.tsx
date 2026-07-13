const SUGGESTIONS = [
  {
    icon: "✐",
    title: "Create a file or build a site",
    prompt: "Help me create a file or build a website. Ask me what I need.",
  },
  {
    icon: "▤",
    title: "Research and plan next steps",
    prompt: "Research a topic for me and propose a plan with next steps.",
  },
  {
    icon: "≡",
    title: "Get a briefing on recent work",
    prompt: "Give me a briefing summarizing my recent work and open items.",
  },
  {
    icon: "◔",
    title: "Automate routine and recurring task",
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
        ✦
      </div>
      <h1 className="welcome__title">What should we get done?</h1>
      <div className="welcome__cards">
        {SUGGESTIONS.map((card) => (
          <button
            key={card.title}
            type="button"
            className="welcome__card"
            onClick={() => onPick(card.prompt)}
          >
            <span className="welcome__card-icon" aria-hidden="true">
              {card.icon}
            </span>
            <span className="welcome__card-title">{card.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
