'use client'

import { useRef } from 'react'
import { gsap } from 'gsap'
import { TextPlugin } from 'gsap/TextPlugin'
import { useGSAP } from '@gsap/react'
import { IconSparkles, IconMail, IconCircleCheckFilled, IconBolt } from '@tabler/icons-react'
import { prefersReducedMotion } from '@/lib/motion'

gsap.registerPlugin(TextPlugin, useGSAP)

const USER_MSG = 'Skicka påminnelser till alla med förfallna fakturor'
const AI1 = 'Hittade 3 förfallna fakturor:'
const AI2 = 'Skickar påminnelser...'
const DONE = 'Klar! 3 påminnelser skickade på 2.3 sekunder.'

const RESULTS = [
  { name: 'Anna Lindqvist', amount: '12 200 kr', late: '14d försening' },
  { name: 'Erik Johansson', amount: '8 500 kr', late: '5d försening' },
  { name: 'Maria Svensson', amount: '3 900 kr', late: '3d försening' },
]
const FIRST = ['Anna', 'Erik', 'Maria']

const CPS = 40 // typing speed: ~40 chars / second

/**
 * The live AI chat demo — a self-contained 12s loop that shows Eveno's
 * assistant working in real time (typing → thinking → results →
 * sending → done). Driven entirely by ONE GSAP timeline on refs/CSS;
 * no React re-renders per character, zero coupling to the WebGL scene.
 * Honors reduced-motion with a calm, fully-resolved static snapshot.
 *
 * Positioned beside the building in screen space (right on desktop,
 * below on mobile) — an HTML overlay keeps the text crisp and costs
 * the 3D scene nothing. The `.js-chat` wrapper is faded + parallaxed
 * by the master scroll timeline in Experience.
 */
export function LiveAIChat() {
  const root = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const reduced = prefersReducedMotion()

      if (reduced) {
        // Fully-resolved, motionless snapshot.
        gsap.set('.chat-content', { autoAlpha: 1 })
        gsap.set('.msg-user', { autoAlpha: 1, y: 0, scale: 1 })
        gsap.set('.user-text', { text: USER_MSG })
        gsap.set('.type-cursor', { autoAlpha: 0 })
        gsap.set('.user-time', { autoAlpha: 1 })
        gsap.set('.ai-think', { autoAlpha: 0 })
        gsap.set('.ai-line1', { autoAlpha: 1, text: AI1 })
        gsap.set('.res-card', { autoAlpha: 1, x: 0 })
        gsap.set('.ai-line2', { autoAlpha: 1, text: AI2 })
        gsap.set('.env', { autoAlpha: 0 })
        gsap.set('.check', { autoAlpha: 1, x: 0 })
        gsap.set('.ai-done', { autoAlpha: 1, y: 0 })
        gsap.set('.celebrate', { autoAlpha: 0 })
        return
      }

      const dUser = USER_MSG.length / CPS
      const dAi1 = AI1.length / CPS
      const dAi2 = AI2.length / CPS

      const tl = gsap.timeline({ repeat: -1, defaults: { ease: 'none' } })

      // ── t=0  reset (re-runs every loop) ───────────────────────────
      tl.set('.chat-content', { autoAlpha: 1 }, 0)
        .set('.user-text', { text: '' }, 0)
        .set('.msg-user', { autoAlpha: 0, y: 8, scale: 0.96 }, 0)
        .set('.type-cursor', { autoAlpha: 0 }, 0)
        .set('.user-time', { autoAlpha: 0 }, 0)
        .set('.ai-think', { autoAlpha: 0 }, 0)
        .set('.ai-progress-fill', { scaleX: 0, transformOrigin: 'left center' }, 0)
        .set('.ai-line1', { autoAlpha: 0, text: '' }, 0)
        .set('.res-card', { autoAlpha: 0, x: -16 }, 0)
        .set('.ai-line2', { autoAlpha: 0, text: '' }, 0)
        .set('.env', { autoAlpha: 0, x: 0 }, 0)
        .set('.check', { autoAlpha: 0, x: -10 }, 0)
        .set('.ai-done', { autoAlpha: 0, y: 8 }, 0)
        .set('.celebrate', { autoAlpha: 0, scale: 0 }, 0)

      // ── t=1  user types ──────────────────────────────────────────
      tl.set('.msg-user', { autoAlpha: 1 }, 1.0)
        .set('.type-cursor', { autoAlpha: 1 }, 1.0)
        .to('.user-text', { duration: dUser, text: { value: USER_MSG, delimiter: '' } }, 1.0)

      // ── t=3  message "sent" ──────────────────────────────────────
      tl.to('.msg-user', { y: 0, scale: 1, duration: 0.3, ease: 'back.out(2)' }, 3.0)
        .to('.type-cursor', { autoAlpha: 0, duration: 0.15 }, 3.0)
        .to('.user-time', { autoAlpha: 1, duration: 0.3 }, 3.15)

      // ── t=3.5  AI thinking + progress ────────────────────────────
      tl.to('.ai-think', { autoAlpha: 1, duration: 0.3 }, 3.5).to(
        '.ai-progress-fill',
        { scaleX: 1, duration: 1.5, ease: 'power1.inOut' },
        3.5,
      )

      // ── t=5  AI response line 1 ──────────────────────────────────
      tl.to('.ai-think', { autoAlpha: 0, duration: 0.3 }, 5.0)
        .set('.ai-line1', { autoAlpha: 1 }, 5.0)
        .to('.ai-line1', { duration: dAi1, text: { value: AI1, delimiter: '' } }, 5.0)

      // ── t=6  result cards, one by one ────────────────────────────
      tl.to(
        '.res-card',
        {
          autoAlpha: 1,
          x: 0,
          duration: 0.35,
          stagger: 0.4,
          ease: 'power3.out',
        },
        6.0,
      )

      // ── t=8.5  "Skickar..." + envelopes fly ──────────────────────
      tl.set('.ai-line2', { autoAlpha: 1 }, 8.5)
        .to('.ai-line2', { duration: dAi2, text: { value: AI2, delimiter: '' } }, 8.5)
        .to('.env', { autoAlpha: 1, duration: 0.2, stagger: 0.22 }, 8.6)
        .to('.env', { x: 150, duration: 0.7, stagger: 0.22, ease: 'power1.in' }, 8.8)

      // ── t=9.5  envelope → checkmark ──────────────────────────────
      tl.to('.env', { autoAlpha: 0, duration: 0.2, stagger: 0.3 }, 9.5).to(
        '.check',
        {
          autoAlpha: 1,
          x: 0,
          duration: 0.3,
          stagger: 0.3,
          ease: 'power3.out',
        },
        9.6,
      )

      // ── t=10.5  completion + celebration ─────────────────────────
      tl.to('.ai-done', { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power3.out' }, 10.5).fromTo(
        '.celebrate',
        { scale: 0, autoAlpha: 0.55 },
        { scale: 1.7, autoAlpha: 0, duration: 0.9, ease: 'power2.out' },
        10.6,
      )

      // ── t=11.5  fade out, loop at t=12 ───────────────────────────
      tl.to('.chat-content', { autoAlpha: 0, duration: 0.5, ease: 'power1.in' }, 11.5).to(
        {},
        { duration: 0.001 },
        11.999,
      )
    },
    { scope: root },
  )

  return (
    <div
      ref={root}
      className="js-chat pointer-events-none absolute bottom-6 left-4 right-4 max-w-[380px] md:bottom-auto md:left-auto md:right-[5%] md:top-[15%] md:w-[360px]"
      style={{ opacity: 0 }}
      aria-hidden
    >
      <div
        className="overflow-hidden rounded-xl"
        style={{
          background: 'rgba(15, 31, 71, 0.6)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(91, 127, 224, 0.3)',
          boxShadow: '0 0 44px rgba(91, 127, 224, 0.22)',
        }}
      >
        {/* Persistent header */}
        <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-4 py-3">
          <span className="bg-eveno-electric/20 text-eveno-electric flex h-6 w-6 items-center justify-center rounded-md">
            <IconBolt size={14} stroke={2.2} />
          </span>
          <span className="text-[13px] font-medium text-white">Eveno AI</span>
          <span className="text-eveno-mint ml-auto flex items-center gap-1.5 text-[11px]">
            <span className="bg-eveno-mint h-1.5 w-1.5 animate-pulse rounded-full" />
            Live
          </span>
        </div>

        {/* Looping content */}
        <div className="chat-content space-y-3 px-4 py-4 text-[13px] leading-relaxed">
          {/* User message */}
          <div className="flex justify-end">
            <div className="msg-user bg-eveno-electric max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2 text-white">
              <span>
                <span className="user-text" />
                <span className="type-cursor ml-px inline-block">|</span>
              </span>
              <span className="user-time mt-1 block text-right text-[10px] text-white/70">
                Skickat nu
              </span>
            </div>
          </div>

          {/* AI thinking */}
          <div className="ai-think flex items-center gap-2 text-white/70">
            <IconSparkles
              size={15}
              className="text-eveno-electric [animation:spin_3s_linear_infinite]"
            />
            <span className="text-[12.5px]">AI analyserar…</span>
            <span className="ml-1 h-1 flex-1 overflow-hidden rounded-full bg-white/10">
              <span className="ai-progress-fill from-eveno-electric to-eveno-mint block h-full w-full rounded-full bg-gradient-to-r" />
            </span>
          </div>

          {/* AI response */}
          <p className="ai-line1 text-white/85" />

          {/* Result cards */}
          <div className="space-y-1.5">
            {RESULTS.map((r) => (
              <div
                key={r.name}
                className="res-card border-eveno-mint/20 flex items-center gap-2 rounded-lg border bg-white/[0.05] px-3 py-2"
              >
                <span className="text-[14px]">📧</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-white">{r.name}</p>
                  <p className="text-eveno-mint text-[11px]">
                    {r.amount} · {r.late}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Sending → sent */}
          <p className="ai-line2 text-white/85" />
          <div className="space-y-1.5">
            {FIRST.map((name) => (
              <div key={name} className="relative flex h-6 items-center text-[12.5px]">
                <span className="env text-eveno-electric absolute left-0">
                  <IconMail size={15} stroke={1.9} />
                </span>
                <span className="check flex items-center gap-1.5 text-white/85">
                  <IconCircleCheckFilled size={15} className="text-eveno-mint" />
                  {name} — Skickad
                </span>
              </div>
            ))}
          </div>

          {/* Completion */}
          <div className="relative">
            <p className="ai-done text-eveno-mint flex items-center gap-2 font-medium">
              <IconSparkles size={15} />
              {DONE}
            </p>
            <span
              className="celebrate pointer-events-none absolute -inset-3 rounded-2xl"
              style={{
                border: '1px solid rgba(173, 224, 197, 0.5)',
                boxShadow: '0 0 30px rgba(173, 224, 197, 0.4)',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
