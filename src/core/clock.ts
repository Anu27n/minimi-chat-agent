/**
 * Every component that needs "now" takes a Clock instead of calling Date.now().
 * That single seam is what makes the time-aware memory testable ("last Tuesday"
 * means something different every day) and lets the seed script write
 * conversations into the past.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock frozen at one instant. Used in tests. */
export function fixedClock(at: Date): Clock {
  return { now: () => new Date(at.getTime()) };
}

/** A clock that starts at `start` and keeps ticking in real time (AGENT_NOW). */
export function offsetClock(start: Date, base: Clock = systemClock): Clock {
  const offset = start.getTime() - base.now().getTime();
  return { now: () => new Date(base.now().getTime() + offset) };
}

/** A clock whose time can be set explicitly. Used by the seed script. */
export class ManualClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(at: Date): void {
    this.current = new Date(at.getTime());
  }
}
