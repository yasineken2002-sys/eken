'use client'

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { Act1Hero } from './Act1Hero'
import { LiveAIChat } from './LiveAIChat'
import { scrollState } from '@/lib/scrollStore'
import { prefersReducedMotion } from '@/lib/motion'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// Three must never run on the server.
const Scene = dynamic(() => import('./Scene').then((m) => m.Scene), {
  ssr: false,
  loading: () => <div className="bg-eveno-deep-space fixed inset-0" />,
})

/**
 * Orchestrates the cinematic stage: a fixed WebGL canvas + a fixed HUD,
 * with a tall scroll spacer that provides the scroll distance. One
 * scrubbed GSAP timeline (synced to Lenis via LenisProvider) animates
 * the HUD directly — no React re-renders on scroll — and mirrors raw
 * progress into `scrollState` for the Phase 3 camera path.
 *
 * For Phase 2 the spacer === the full journey: page-progress 0→1 maps
 * to Act 1 (cosmic intro) → Act 2 (live AI chat). Later phases extend
 * this timeline; the act windows stay stable.
 */
export function Experience() {
  const root = useRef<HTMLDivElement>(null)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    setReduced(prefersReducedMotion())
  }, [])

  useGSAP(
    () => {
      if (reduced) {
        // Calm, static presentation — everything visible, no scrub.
        gsap.set('.js-chat', { opacity: 1, y: 0, scale: 1 })
        return
      }

      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: root.current!,
          start: 'top top',
          end: 'bottom bottom',
          scrub: 0.6,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            scrollState.progress = self.progress
          },
        },
      })

      // ── Act 1: cosmic intro clears ────────────────────────────────
      tl.to('.js-scroll-ind', { opacity: 0, duration: 0.1 }, 0.04)
      tl.to(
        '.js-hero',
        {
          opacity: 0,
          y: -60,
          filter: 'blur(8px)',
          ease: 'power2.in',
          duration: 0.22,
        },
        0.12,
      )

      // ── Act 2: live AI chat fades in + gentle parallax ────────────
      // Parallax spans the whole scroll and moves slower than the page.
      tl.fromTo('.js-chat', { y: 46 }, { y: -46, ease: 'none', duration: 1 }, 0)
      tl.fromTo(
        '.js-chat',
        { opacity: 0, scale: 0.96 },
        { opacity: 1, scale: 1, ease: 'power3.out', duration: 0.2 },
        0.4,
      )

      // Pad the timeline so positions ≈ scroll fraction.
      tl.to({}, { duration: 0.01 }, 0.99)

      // Layout settles after the canvas + fonts mount.
      const id = window.setTimeout(() => ScrollTrigger.refresh(), 200)
      return () => window.clearTimeout(id)
    },
    { scope: root, dependencies: [reduced] },
  )

  return (
    <div ref={root} className="relative" style={{ height: reduced ? '100vh' : '300vh' }}>
      <div className="fixed inset-0 z-0">
        <Scene />
      </div>
      <div className="pointer-events-none fixed inset-0 z-10">
        <Act1Hero />
        <LiveAIChat />
      </div>
    </div>
  )
}
