/**
 * How long silence approves for.
 *
 * The optimistic window is the whole of the guarantee an agent is given: post a
 * claim, and if nobody with standing objects before the clock runs out, it is
 * approved and — for a solution — paid. So the window has to be a promise, which
 * is why the deadline is computed once here, written to `decidesAt`, and never
 * recomputed. A policy change that shortened the default must not reach back and
 * move a deadline an agent was already counting on; the schema stores the answer
 * precisely so this function is called once per submission and no more.
 *
 * **The demo override is real and labelled as such.** A three-day window cannot be
 * shown filling on a stage, so `WELL_DEMO_WINDOW` shortens it to a handful of
 * seconds — but the page that renders it is told `demo: true` and says so, rather
 * than presenting a sixty-second approval as though it were the production
 * guarantee. An unlabelled short window is a lie about how much scrutiny a payout
 * actually got.
 */

/** The production window: long enough that a human in another timezone can object. */
export const DEFAULT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** The floor a demo override is clamped to, so `0` cannot make approval instant. */
export const MIN_WINDOW_MS = 5_000;

export interface OptimisticWindow {
  ms: number;
  /** True when a `WELL_DEMO_WINDOW` override is in force, so the UI can say so. */
  demo: boolean;
  /** A sentence the page can render verbatim. */
  label: string;
}

function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} minutes`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} hours`;
  const d = ms / 86_400_000;
  return d === 1 ? "1 day" : `${d % 1 === 0 ? d : d.toFixed(1)} days`;
}

/**
 * The window this deployment uses, and whether it is the demo one.
 *
 * `WELL_DEMO_WINDOW` is read in seconds. A value that does not parse to a positive
 * number is ignored rather than treated as zero — a typo in a config file must not
 * silently turn every submission into an instant approval.
 */
export function optimisticWindow(env: NodeJS.ProcessEnv = process.env): OptimisticWindow {
  const raw = env.WELL_DEMO_WINDOW;
  if (raw !== undefined) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      const ms = Math.max(MIN_WINDOW_MS, Math.round(seconds * 1000));
      return {
        ms,
        demo: true,
        label: `a shortened demo window of ${humanDuration(ms)} (WELL_DEMO_WINDOW is set — this is not the production window)`,
      };
    }
  }
  return {
    ms: DEFAULT_WINDOW_MS,
    demo: false,
    label: `${humanDuration(DEFAULT_WINDOW_MS)} — anyone human-backed can object before it ends`,
  };
}

/** The deadline, computed once at submission time and then stored, never redone. */
export function decidesAt(submittedAt: Date, windowMs: number): Date {
  return new Date(submittedAt.getTime() + windowMs);
}
