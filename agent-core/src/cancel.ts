/** Per-session AbortController registry for foreground agent runs. */
const NO_SESSION = "\0default";

class CancelRegistry {
  private readonly controllers = new Map<string, AbortController>();

  private key(session?: string | null): string {
    return session && session.length > 0 ? session : NO_SESSION;
  }

  register(session?: string | null): {
    controller: AbortController;
    signal: AbortSignal;
  } {
    const key = this.key(session);
    this.controllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    return { controller, signal: controller.signal };
  }

  cancel(session?: string | null): boolean {
    const key = this.key(session);
    const controller = this.controllers.get(key);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(key);
    return true;
  }

  clear(
    session: string | null | undefined,
    controller: AbortController,
  ): void {
    const key = this.key(session);
    if (this.controllers.get(key) === controller) {
      this.controllers.delete(key);
    }
  }

  has(session?: string | null): boolean {
    return this.controllers.has(this.key(session));
  }
}

export const cancelRegistry = new CancelRegistry();
