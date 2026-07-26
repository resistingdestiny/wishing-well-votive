"use client";

/**
 * The scroll-reveal motion layer, currently retired.
 *
 * It used to hide every `[data-reveal]` / `[data-stagger]` element and fade it
 * in as it crossed the viewport. On short marketing sections that read as
 * polish; on long tables and data-dense pages it read as the page *flickering*
 * while you pan — each row popping in just after you have already scrolled past
 * it — and on a screen recording the pops look like rendering glitches. The
 * content was never the thing that needed animating, so the layer now renders
 * everything exactly where the server put it, immediately.
 *
 * Kept mounted (and the `data-*` attributes kept in the pages) so a future,
 * gentler treatment — first-paint-only, no scroll coupling — has somewhere to
 * live without re-plumbing the layout.
 */
export function AppFx() {
  return null;
}
