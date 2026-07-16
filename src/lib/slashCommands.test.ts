import { describe, expect, it, vi } from "vitest";
import {
  SLASH_COMMANDS,
  filterCommands,
  matchCommand,
  type SlashContext,
} from "./slashCommands";

function makeContext(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    newSession: vi.fn(),
    clearSession: vi.fn(),
    renameSession: vi.fn(),
    openModelMenu: vi.fn(),
    setRunMode: vi.fn(),
    stopRun: vi.fn(),
    compact: vi.fn(),
    openSettings: vi.fn(),
    openHelp: vi.fn(),
    openSkills: vi.fn(),
    notify: vi.fn(),
    toast: vi.fn(),
    loading: false,
    ...overrides,
  };
}

describe("filterCommands", () => {
  it("returns the full list for an empty query in declared order", () => {
    expect(filterCommands("")).toEqual(SLASH_COMMANDS);
  });

  it("prefix-matches command names", () => {
    expect(filterCommands("re").map((command) => command.name)).toEqual([
      "rename",
    ]);
  });

  it("returns empty for no match", () => {
    expect(filterCommands("zzzz")).toEqual([]);
  });
});

describe("matchCommand", () => {
  it("returns null for non-slash and unknown input", () => {
    expect(matchCommand("hello world")).toBeNull();
    expect(matchCommand("/nope")).toBeNull();
  });

  it("resolves a command and its argument", () => {
    expect(matchCommand("/new")?.arg).toBe("");
    const match = matchCommand("/rename My New Title");
    expect(match?.cmd.name).toBe("rename");
    expect(match?.arg).toBe("My New Title");
  });
});

describe("command dispatch", () => {
  it("dispatches rename and valid agent modes", () => {
    const context = makeContext();
    const rename = matchCommand("/rename Fresh")!;
    rename.cmd.run(context, rename.arg);
    expect(context.renameSession).toHaveBeenCalledWith("Fresh");

    const agent = SLASH_COMMANDS.find((command) => command.name === "agent")!;
    agent.run(context, "autopilot");
    agent.run(context, "bogus");
    expect(context.setRunMode).toHaveBeenCalledTimes(1);
    expect(context.setRunMode).toHaveBeenCalledWith("autopilot");
  });

  it("only enables stop while loading", () => {
    const stop = SLASH_COMMANDS.find((command) => command.name === "stop")!;
    expect(stop.enabled?.(makeContext())).toBe(false);
    expect(stop.enabled?.(makeContext({ loading: true }))).toBe(true);
  });
});
