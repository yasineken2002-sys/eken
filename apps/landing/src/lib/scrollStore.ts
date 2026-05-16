/**
 * Single source of truth for global scroll progress (0 → 1 across the
 * whole cinematic journey).
 *
 * Deliberately a plain mutable object — NOT React state. The scroll
 * driver (GSAP ScrollTrigger) writes `progress` on every scroll tick,
 * and the WebGL scene reads it inside `useFrame`. Keeping it out of
 * React's render cycle is what lets the experience hold 60fps:
 * scrolling never triggers a component re-render.
 *
 * Phase 2 only consumes this for HUD coupling; Phase 3 will drive the
 * camera path from the same value.
 */
export const scrollState = {
  /** Normalized progress across the entire scroll page, 0 → 1. */
  progress: 0,
}

/**
 * Maps a global progress value to a local 0→1 value within an act's
 * [start, end] window (clamped). Used by act-scoped animations so each
 * act can reason in its own 0→1 space regardless of its slice of the
 * overall timeline.
 */
export function actProgress(progress: number, start: number, end: number): number {
  if (progress <= start) return 0
  if (progress >= end) return 1
  return (progress - start) / (end - start)
}
