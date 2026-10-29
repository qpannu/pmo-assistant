// In-process interval scheduler. A task never overlaps itself: a manual or
// timed trigger while it is running joins the run already in progress.

import { logger } from './logger.js';

const log = logger.child({ component: 'scheduler' });

export function createScheduler() {
  const tasks = new Map();

  function every(name, minutes, fn, { initialDelayMs = 5_000 } = {}) {
    if (tasks.has(name)) throw new Error(`Task "${name}" already scheduled`);
    const task = { fn, running: null, timers: [] };
    tasks.set(name, task);
    task.timers.push(setTimeout(() => runNow(name).catch(() => {}), initialDelayMs));
    task.timers.push(setInterval(() => runNow(name).catch(() => {}), minutes * 60_000));
    log.info('task scheduled', { name, everyMinutes: minutes });
  }

  function runNow(name) {
    const task = tasks.get(name);
    if (!task) return Promise.reject(new Error(`Unknown task "${name}"`));
    if (task.running) return task.running;
    task.running = (async () => {
      try {
        return await task.fn();
      } catch (err) {
        log.error('task failed', { name, error: err.message });
        throw err;
      } finally {
        task.running = null;
      }
    })();
    return task.running;
  }

  function stop() {
    for (const task of tasks.values()) task.timers.forEach((t) => clearTimeout(t));
    tasks.clear();
  }

  return { every, runNow, has: (name) => tasks.has(name), stop };
}
