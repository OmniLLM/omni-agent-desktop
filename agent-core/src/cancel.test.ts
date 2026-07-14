import { beforeEach, describe, expect, it } from "bun:test";
import { cancelRegistry } from "./cancel.js";

describe("cancelRegistry", () => {
  beforeEach(() => {
    cancelRegistry.cancel("s1");
    cancelRegistry.cancel("s2");
    cancelRegistry.cancel(undefined);
  });

  it("registers and cancels a session run", () => {
    const { signal } = cancelRegistry.register("s1");
    expect(cancelRegistry.has("s1")).toBe(true);
    expect(cancelRegistry.cancel("s1")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(cancelRegistry.has("s1")).toBe(false);
  });

  it("returns false when no run exists", () => {
    expect(cancelRegistry.cancel("missing")).toBe(false);
  });

  it("replaces only a run in the same session", () => {
    const first = cancelRegistry.register("s1");
    const other = cancelRegistry.register("s2");
    const second = cancelRegistry.register("s1");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(false);
  });

  it("uses a shared key for missing session ids", () => {
    const { signal } = cancelRegistry.register(undefined);
    expect(cancelRegistry.cancel("")).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("does not clear a replacement controller", () => {
    const first = cancelRegistry.register("s1");
    const second = cancelRegistry.register("s1");
    cancelRegistry.clear("s1", first.controller);
    expect(cancelRegistry.has("s1")).toBe(true);
    cancelRegistry.clear("s1", second.controller);
    expect(cancelRegistry.has("s1")).toBe(false);
  });
});
