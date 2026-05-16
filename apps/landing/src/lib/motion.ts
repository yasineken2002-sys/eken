/**
 * True when the visitor has asked the OS to minimize motion.
 * Every scroll-driven / looping animation checks this and degrades to
 * a calm, static presentation instead.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
