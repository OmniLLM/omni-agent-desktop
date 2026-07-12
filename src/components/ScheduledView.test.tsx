import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ScheduledView from "./ScheduledView";
import type { ScheduledTask, SchedulerStatusEvent } from "../types/app";
import { invoke, listen } from "../lib/runtime";

vi.mock("../lib/runtime", () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

// Captured scheduler://status handlers so tests can drive events.
let statusHandlers: Array<(e: { payload: SchedulerStatusEvent }) => void>;
let unlistenSpy: ReturnType<typeof vi.fn>;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    prompt: "Daily standup summary",
    cadence: "Daily",
    enabled: true,
    created_at: 1_000,
    updated_at: 1_000,
    next_run_at: 1_700_000_000,
    last_run_at: 1_600_000_000,
    last_status: "Succeeded",
    last_error: null,
    ...overrides,
  };
}

function mockList(tasks: ScheduledTask[]) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "list_scheduled") return tasks as unknown;
    return undefined as unknown;
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  statusHandlers = [];
  unlistenSpy = vi.fn();
  listenMock.mockImplementation(async (name: string, handler: any) => {
    if (name === "scheduler://status") statusHandlers.push(handler);
    return unlistenSpy as unknown as () => void;
  });
  invokeMock.mockResolvedValue(undefined as unknown);
});

describe("ScheduledView", () => {
  it("loads and renders typed tasks with readable status and timestamps", async () => {
    mockList([task({ prompt: "Status report", cadence: "Weekly" })]);
    render(<ScheduledView onRun={vi.fn()} />);

    expect(await screen.findByText("Status report")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("list_scheduled");
    // Cadence + status surfaced in the task row.
    const row = screen.getByText("Status report").closest("li")!;
    expect(within(row).getByText(/Weekly/i)).toBeInTheDocument();
    expect(within(row).getByText(/Succeeded/i)).toBeInTheDocument();
  });

  it("shows the empty state when there are no tasks", async () => {
    mockList([]);
    render(<ScheduledView onRun={vi.fn()} />);
    expect(await screen.findByText(/no scheduled tasks/i)).toBeInTheDocument();
  });

  it("creates a task via typed create_scheduled and reconciles the returned task", async () => {
    const created = task({ id: "new1", prompt: "Backup logs", cadence: "Hourly" });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [] as unknown;
      if (cmd === "create_scheduled") return created as unknown;
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText(/no scheduled tasks/i);

    await userEvent.type(
      screen.getByPlaceholderText(/what should run/i),
      "Backup logs",
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/cadence/i),
      "Hourly",
    );
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("create_scheduled", {
        prompt: "Backup logs",
        cadence: "Hourly",
        enabled: true,
      }),
    );
    expect(await screen.findByText("Backup logs")).toBeInTheDocument();
    // No whole-array save should ever be issued.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "save_scheduled",
      expect.anything(),
    );
  });

  it("edits a task via update_scheduled and reconciles", async () => {
    const t = task({ id: "e1", prompt: "Old prompt", cadence: "Daily" });
    const updated = task({ id: "e1", prompt: "New prompt", cadence: "Weekly" });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "update_scheduled") return updated as unknown;
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Old prompt");

    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    const input = screen.getByPlaceholderText(/what should run/i);
    await userEvent.clear(input);
    await userEvent.type(input, "New prompt");
    await userEvent.selectOptions(screen.getByLabelText(/cadence/i), "Weekly");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_scheduled", {
        id: "e1",
        prompt: "New prompt",
        cadence: "Weekly",
        enabled: true,
      }),
    );
    expect(await screen.findByText("New prompt")).toBeInTheDocument();
    expect(screen.queryByText("Old prompt")).toBeNull();
  });

  it("deletes a task via delete_scheduled", async () => {
    const t = task({ id: "d1", prompt: "Remove me" });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "delete_scheduled") return undefined as unknown;
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Remove me");

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("delete_scheduled", { id: "d1" }),
    );
    await waitFor(() => expect(screen.queryByText("Remove me")).toBeNull());
  });

  it("toggles enabled via update_scheduled and reconciles", async () => {
    const t = task({ id: "g1", prompt: "Toggle me", enabled: true });
    const off = task({ id: "g1", prompt: "Toggle me", enabled: false });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "update_scheduled") return off as unknown;
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Toggle me");

    const toggle = screen.getByRole("checkbox", { name: /enabled/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_scheduled", {
        id: "g1",
        prompt: "Toggle me",
        cadence: "Daily",
        enabled: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /enabled/i }),
      ).not.toBeChecked(),
    );
  });

  it("runs a task now via run_scheduled_now and reconciles the returned task", async () => {
    const t = task({ id: "r1", prompt: "Run me", last_status: "Idle" });
    const succeeded = task({ id: "r1", prompt: "Run me", last_status: "Succeeded" });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "run_scheduled_now") return succeeded as unknown;
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Run me");

    await userEvent.click(screen.getByRole("button", { name: /run now/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("run_scheduled_now", {
        id: "r1",
      }),
    );
    expect(await screen.findByText(/Succeeded/i)).toBeInTheDocument();
  });

  it("disables the Run now button while a run is in flight", async () => {
    const t = task({ id: "r2", prompt: "Slow run", last_status: "Idle" });
    let resolveRun: (v: ScheduledTask) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "run_scheduled_now")
        return new Promise((res) => {
          resolveRun = res as (v: ScheduledTask) => void;
        }) as unknown;
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Slow run");

    const runBtn = screen.getByRole("button", { name: /run now/i });
    await userEvent.click(runBtn);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run now/i })).toBeDisabled(),
    );

    resolveRun(task({ id: "r2", prompt: "Slow run", last_status: "Succeeded" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /run now/i }),
      ).not.toBeDisabled(),
    );
  });

  it("surfaces a bounded/redacted error when run_scheduled_now fails", async () => {
    const t = task({ id: "r3", prompt: "Failing run", last_status: "Idle" });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "run_scheduled_now")
        throw new Error("provider HTTP 401: unauthorized");
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Failing run");

    await userEvent.click(screen.getByRole("button", { name: /run now/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/401/i);
    // Button recovers (no longer disabled) after the failure.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /run now/i }),
      ).not.toBeDisabled(),
    );
  });

  it("surfaces an error when create_scheduled fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [] as unknown;
      if (cmd === "create_scheduled") throw new Error("prompt is required");
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText(/no scheduled tasks/i);

    await userEvent.type(
      screen.getByPlaceholderText(/what should run/i),
      "x",
    );
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/required/i);
  });

  it("updates only the matching task on a scheduler://status event", async () => {
    const a = task({ id: "a", prompt: "Task A", last_status: "Idle" });
    const b = task({ id: "b", prompt: "Task B", last_status: "Idle" });
    mockList([a, b]);
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Task A");

    await waitFor(() => expect(statusHandlers.length).toBeGreaterThan(0));

    statusHandlers.forEach((h) =>
      h({
        payload: {
          id: "b",
          status: "Running",
          last_run_at: null,
          next_run_at: 1_800_000_000,
          last_error: null,
        },
      }),
    );

    const rowB = screen.getByText("Task B").closest("li")!;
    await waitFor(() =>
      expect(within(rowB).getByText(/Running/i)).toBeInTheDocument(),
    );
    // Task A remains untouched.
    const rowA = screen.getByText("Task A").closest("li")!;
    expect(within(rowA).queryByText(/Running/i)).toBeNull();
  });

  it("shows a Cancel button on a running row and cancels via cancel_scheduled", async () => {
    const t = task({ id: "c1", prompt: "Long job", last_status: "Running" });
    const cancelled = task({
      id: "c1",
      prompt: "Long job",
      last_status: "Cancelled",
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "cancel_scheduled") return cancelled as unknown;
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Long job");

    await userEvent.click(screen.getByRole("button", { name: /cancel run/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("cancel_scheduled", { id: "c1" }),
    );
    expect(await screen.findByText(/Cancelled/i)).toBeInTheDocument();
  });

  it("treats the run rejection after a successful cancel as expected", async () => {
    const t = task({ id: "c2", prompt: "Run then cancel", last_status: "Idle" });
    let rejectRun: (reason: Error) => void = () => {};
    const cancelled = task({
      id: "c2",
      prompt: "Run then cancel",
      last_status: "Cancelled",
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "run_scheduled_now")
        return new Promise((_resolve, reject) => {
          rejectRun = reject as (reason: Error) => void;
        }) as unknown;
      if (cmd === "cancel_scheduled") return cancelled as unknown;
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Run then cancel");

    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /cancel run/i }),
    );

    rejectRun(new Error("run cancelled"));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/Cancelled/i)).toBeInTheDocument();
  });

  it("avoids a duplicate cancel while one is already in flight", async () => {
    const t = task({ id: "c3", prompt: "Double cancel", last_status: "Running" });
    let resolveCancel: (v: ScheduledTask) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "cancel_scheduled")
        return new Promise((res) => {
          resolveCancel = res as (v: ScheduledTask) => void;
        }) as unknown;
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Double cancel");

    const cancelBtn = screen.getByRole("button", { name: /cancel run/i });
    await userEvent.click(cancelBtn);
    // Button is disabled while the cancel is in flight; a second click is a no-op.
    await waitFor(() => expect(cancelBtn).toBeDisabled());
    await userEvent.click(cancelBtn);

    const cancelCalls = invokeMock.mock.calls.filter(
      (c) => c[0] === "cancel_scheduled",
    ).length;
    expect(cancelCalls).toBe(1);

    resolveCancel(
      task({ id: "c3", prompt: "Double cancel", last_status: "Cancelled" }),
    );
  });

  it("reconciles a Cancelled status delivered via scheduler://status", async () => {
    const t = task({ id: "c4", prompt: "Event cancel", last_status: "Running" });
    mockList([t]);
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Event cancel");
    await waitFor(() => expect(statusHandlers.length).toBeGreaterThan(0));

    statusHandlers.forEach((h) =>
      h({
        payload: {
          id: "c4",
          status: "Cancelled",
          last_run_at: 1_650_000_000,
          next_run_at: 1_800_000_000,
          last_error: null,
        },
      }),
    );

    const row = screen.getByText("Event cancel").closest("li")!;
    await waitFor(() =>
      expect(within(row).getByText(/Cancelled/i)).toBeInTheDocument(),
    );
    // The Cancel button disappears once the run reaches a terminal state.
    expect(
      within(row).queryByRole("button", { name: /cancel run/i }),
    ).toBeNull();
  });

  it("surfaces an error and recovers when cancel_scheduled fails", async () => {
    const t = task({ id: "c5", prompt: "Cancel fails", last_status: "Running" });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "cancel_scheduled") throw new Error("could not persist cancellation");
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Cancel fails");

    await userEvent.click(screen.getByRole("button", { name: /cancel run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/persist/i);
    // Button recovers (no longer disabled) after the failure.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /cancel run/i }),
      ).not.toBeDisabled(),
    );
  });

  it("ignores cancellation when the run already completed", async () => {
    const t = task({ id: "c6", prompt: "Already done", last_status: "Running" });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_scheduled") return [t] as unknown;
      if (cmd === "cancel_scheduled") throw new Error("task is not running");
      return undefined as unknown;
    });
    render(<ScheduledView onRun={vi.fn()} />);
    await screen.findByText("Already done");

    await userEvent.click(screen.getByRole("button", { name: /cancel run/i }));

    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  it("subscribes to scheduler://status once and unlistens on unmount", async () => {
    mockList([task()]);
    const { unmount } = render(<ScheduledView onRun={vi.fn()} />);
    await waitFor(() =>
      expect(listenMock).toHaveBeenCalledWith(
        "scheduler://status",
        expect.any(Function),
      ),
    );
    const listenCalls = listenMock.mock.calls.filter(
      (c) => c[0] === "scheduler://status",
    ).length;
    expect(listenCalls).toBe(1);

    unmount();
    await waitFor(() => expect(unlistenSpy).toHaveBeenCalled());
  });
});
