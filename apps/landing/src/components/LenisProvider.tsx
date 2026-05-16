'use client'

import { useEffect, type ReactNode } from 'react'
import Lenis from 'lenis'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

/**
 * Smooth-scroll foundation for the cinematic scroll experience.
 *
 * Drives Lenis off the GSAP ticker so Lenis and ScrollTrigger share a
 * single RAF loop — this is the canonical setup the scroll-driven
 * camera (Phase 2+) will hook into. Falls back to native scrolling
 * when the visitor prefers reduced motion.
 */
export function LenisProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (prefersReducedMotion) {
      // Native scroll only — no smoothing, no RAF loop.
      return
    }

    const lenis = new Lenis({
      duration: 1.2,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      touchMultiplier: 1.5,
    })

    // Keep ScrollTrigger in lock-step with Lenis' virtual scroll.
    lenis.on('scroll', ScrollTrigger.update)

    const raf = (time: number) => {
      // GSAP ticker time is in seconds; Lenis expects milliseconds.
      lenis.raf(time * 1000)
    }

    gsap.ticker.add(raf)
    gsap.ticker.lagSmoothing(0)

    return () => {
      lenis.destroy()
      gsap.ticker.remove(raf)
    }
  }, [])

  return <>{children}</>
}
