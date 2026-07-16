import type { RunMode } from "../types/app";

export type SettingsTabId = string;
export type SlashKind = "action" | "argument" | "ui";

export interface SlashContext {
  newSession: () => void;
  clearSession: () => void;
  renameSession: (title: string) => void | Promise<void>;
  openModelMenu?: () => void;
  setRunMode?: (mode: RunMode) => void;
  stopRun: () => void;
  compact: () => void | Promise<void>;
  openSettings: (tab?: SettingsTabId) => void;
  openHelp: () => void;
  openSkills: () => void;
  /** Append an inline system notice to the transcript (durable, in-context UI). */
  notify: (message: string) => void;
  /** Show a transient, auto-dismissing toast (ephemeral confirmation). */
  toast: (message: string) => void;
  loading: boolean;
}

export interface SlashCommand {
  name: string;
  kind: SlashKind;
  title: string;
  description: string;
  aliases?: string[];
  argHint?: string;
  argOptions?: (ctx: SlashContext) => { value: string; label: string }[];
  enabled?: (ctx: SlashContext) => boolean;
  run: (ctx: SlashContext, arg: string) => void | Promise<void>;
}

const RUN_MODE_OPTIONS: { value: RunMode; label: string }[] = [
  { value: "plan", label: "Plan — draft steps before acting" },
  { value: "ask", label: "Ask — confirm mutating tools" },
  { value: "autopilot", label: "Autopilot — auto-approve tools" },
];

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "new",
    kind: "action",
    title: "New task",
    description: "Start a fresh conversation",
    run: (ctx) => ctx.newSession(),
  },
  {
    name: "clear",
    kind: "action",
    title: "Clear conversation",
    description: "Start a fresh conversation",
    run: (ctx) => ctx.clearSession(),
  },
  {
    name: "rename",
    kind: "argument",
    title: "Rename session",
    description: "Rename the current session",
    argHint: "<new title>",
    run: (ctx, arg) => {
      const title = arg.trim();
      if (!title) return;
      ctx.toast(`Renamed to “${title}”`);
      return ctx.renameSession(title);
    },
  },
  {
    name: "model",
    kind: "ui",
    title: "Change model",
    description: "Open the provider and model picker",
    run: (ctx) => ctx.openModelMenu?.(),
  },
  {
    name: "agent",
    kind: "argument",
    title: "Set run mode",
    description: "Choose how the agent runs tools",
    argHint: "<plan|ask|autopilot>",
    argOptions: () => RUN_MODE_OPTIONS,
    run: (ctx, arg) => {
      const mode = arg.trim().toLowerCase();
      if (
        (mode === "plan" || mode === "ask" || mode === "autopilot") &&
        ctx.setRunMode
      ) {
        ctx.setRunMode(mode);
        ctx.notify(`Run mode set to ${mode}.`);
      }
    },
  },
  {
    name: "stop",
    kind: "action",
    title: "Stop",
    description: "Stop the active run",
    enabled: (ctx) => ctx.loading,
    run: (ctx) => {
      ctx.stopRun();
      ctx.toast("Run stopped");
    },
  },
  {
    name: "compact",
    kind: "action",
    title: "Compact history",
    description: "Summarize older turns to save context",
    run: (ctx) => ctx.compact(),
  },
  {
    name: "settings",
    kind: "ui",
    title: "Settings",
    description: "Open preferences",
    run: (ctx) => ctx.openSettings(),
  },
  {
    name: "help",
    kind: "ui",
    title: "Help",
    description: "List available slash commands",
    run: (ctx) => ctx.openHelp(),
  },
  {
    name: "skills",
    kind: "ui",
    title: "Show skills",
    description: "List local skills and A2A skills available to this app",
    run: (ctx) => ctx.openSkills(),
  },
];

function commandNames(cmd: SlashCommand): string[] {
  return [cmd.name, ...(cmd.aliases ?? [])];
}

export function filterCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SLASH_COMMANDS];
  const prefix: SlashCommand[] = [];
  const substring: SlashCommand[] = [];
  for (const cmd of SLASH_COMMANDS) {
    const names = commandNames(cmd).map((name) => name.toLowerCase());
    if (names.some((name) => name.startsWith(q))) {
      prefix.push(cmd);
    } else if (
      names.some((name) => name.includes(q)) ||
      cmd.title.toLowerCase().includes(q)
    ) {
      substring.push(cmd);
    }
  }
  return [...prefix, ...substring];
}

export interface ParsedSlashInput {
  token: string;
  arg: string;
  hasArgument: boolean;
}

export function parseSlashInput(input: string): ParsedSlashInput | null {
  if (!input.startsWith("/")) return null;
  const body = input.slice(1);
  const spaceIndex = body.search(/\s/);
  return {
    token: (spaceIndex === -1 ? body : body.slice(0, spaceIndex)).toLowerCase(),
    arg: spaceIndex === -1 ? "" : body.slice(spaceIndex + 1),
    hasArgument: spaceIndex !== -1,
  };
}

export function matchCommand(
  input: string,
): { cmd: SlashCommand; arg: string } | null {
  const parsed = parseSlashInput(input);
  if (!parsed?.token) return null;
  const cmd = SLASH_COMMANDS.find((candidate) =>
    commandNames(candidate).some(
      (name) => name.toLowerCase() === parsed.token,
    ),
  );
  return cmd ? { cmd, arg: parsed.arg } : null;
}
