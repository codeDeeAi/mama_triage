import { TaskQueue } from '../../src/http/queue';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('TaskQueue', () => {
  it('runs a queued task', async () => {
    const q = new TaskQueue();
    let ran = false;
    q.push(async () => {
      ran = true;
    });
    await q.onIdle();
    expect(ran).toBe(true);
  });

  it('returns immediately from push', async () => {
    const q = new TaskQueue();
    let ran = false;
    q.push(async () => {
      ran = true;
    });
    // Not yet — the task is scheduled on a microtask, so push did not block.
    expect(ran).toBe(false);
    await q.onIdle();
    expect(ran).toBe(true);
  });

  it('runs every queued task', async () => {
    const q = new TaskQueue({ concurrency: 2 });
    const done: number[] = [];
    for (let i = 0; i < 10; i++) {
      q.push(async () => {
        await tick(1);
        done.push(i);
      });
    }
    await q.onIdle();
    expect(done).toHaveLength(10);
  });

  it('respects the concurrency limit', async () => {
    const q = new TaskQueue({ concurrency: 2 });
    let active = 0;
    let peak = 0;

    for (let i = 0; i < 8; i++) {
      q.push(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(5);
        active -= 1;
      });
    }

    await q.onIdle();
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it('routes a task error to onError instead of leaving it unhandled', async () => {
    const errors: unknown[] = [];
    const q = new TaskQueue({ onError: (e) => errors.push(e) });

    q.push(async () => {
      throw new Error('boom');
    });

    await q.onIdle();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('keeps processing after a task throws', async () => {
    const q = new TaskQueue({ concurrency: 1, onError: () => undefined });
    const done: string[] = [];

    q.push(async () => {
      throw new Error('first fails');
    });
    q.push(async () => {
      done.push('second');
    });

    await q.onIdle();
    expect(done).toEqual(['second']);
  });

  it('swallows a throwing onError handler without stalling the queue', async () => {
    const q = new TaskQueue({
      concurrency: 1,
      onError: () => {
        // A logger that itself fails must not wedge the queue.
      },
    });
    const done: string[] = [];
    q.push(async () => {
      throw new Error('x');
    });
    q.push(async () => {
      done.push('ran');
    });
    await q.onIdle();
    expect(done).toEqual(['ran']);
  });

  it('resolves onIdle immediately when nothing is queued', async () => {
    await expect(new TaskQueue().onIdle()).resolves.toBeUndefined();
  });

  it('supports several concurrent waiters on onIdle', async () => {
    const q = new TaskQueue();
    q.push(async () => {
      await tick(5);
    });
    await expect(Promise.all([q.onIdle(), q.onIdle(), q.onIdle()])).resolves.toHaveLength(3);
  });

  it('reports its size', async () => {
    const q = new TaskQueue({ concurrency: 1 });
    expect(q.size).toBe(0);
    q.push(async () => {
      await tick(5);
    });
    q.push(async () => {
      await tick(5);
    });
    expect(q.size).toBe(2);
    await q.onIdle();
    expect(q.size).toBe(0);
  });

  it('accepts tasks pushed while others are running', async () => {
    const q = new TaskQueue({ concurrency: 1 });
    const done: string[] = [];

    q.push(async () => {
      done.push('a');
      q.push(async () => {
        done.push('b');
      });
    });

    await q.onIdle();
    // 'b' was enqueued from inside 'a'; onIdle must not resolve until it has run.
    expect(done).toEqual(['a', 'b']);
  });
});
