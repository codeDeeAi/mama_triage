/**
 * Minimal concurrency-limited async queue.
 *
 * The webhook must ACK Meta within a couple of seconds, but a triage turn takes several
 * seconds of retrieval and LLM work. Work is therefore enqueued here and the response
 * returns immediately.
 *
 * Written rather than taken from a dependency because the popular options are ESM-only
 * and this is twenty lines. If durability across instance restarts is ever needed, the
 * same interface can be backed by Cloud Tasks without touching the handler.
 */

export interface QueueOptions {
  concurrency?: number;
  onError?: (err: unknown) => void;
}

export class TaskQueue {
  private readonly concurrency: number;
  private readonly onError: (err: unknown) => void;
  private readonly pending: Array<() => Promise<void>> = [];
  private active = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(opts: QueueOptions = {}) {
    this.concurrency = opts.concurrency ?? 4;
    this.onError = opts.onError ?? (() => undefined);
  }

  /** Enqueue work. Returns immediately; errors go to `onError`, never unhandled. */
  push(task: () => Promise<void>): void {
    this.pending.push(task);
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      /* istanbul ignore next -- length was just checked; guards the type only */
      if (!task) break;

      this.active += 1;
      void task()
        .catch((err: unknown) => this.onError(err))
        .finally(() => {
          this.active -= 1;
          if (this.pending.length > 0) {
            this.drain();
          } else if (this.active === 0) {
            const resolvers = this.idleResolvers;
            this.idleResolvers = [];
            for (const resolve of resolvers) resolve();
          }
        });
    }
  }

  /** Resolves when all queued work has settled. Used by tests and graceful shutdown. */
  async onIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return;
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  get size(): number {
    return this.pending.length + this.active;
  }
}
