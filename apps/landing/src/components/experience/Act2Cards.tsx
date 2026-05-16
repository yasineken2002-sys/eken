import type { CSSProperties } from 'react'

type FloatingCard = {
  icon: string
  title: string
  /** Absolute placement + a depth scale that fakes 3D distance. */
  style: CSSProperties
  driftDur: string
  driftDelay: string
  /** Farther cards are dimmer + slightly blurred. */
  depthClass: string
}

const CARDS: FloatingCard[] = [
  {
    icon: '💰',
    title: 'Hyra mottagen — 8 500 kr',
    style: { top: '30%', left: '8%', transform: 'scale(1)' },
    driftDur: '6.5s',
    driftDelay: '0s',
    depthClass: 'opacity-100',
  },
  {
    icon: '📧',
    title: 'Faktura skickad till Anna',
    style: { top: '46%', right: '9%', transform: 'scale(0.9)' },
    driftDur: '7.5s',
    driftDelay: '0.8s',
    depthClass: 'opacity-90',
  },
  {
    icon: '🔧',
    title: 'Felanmälan löst',
    style: { top: '67%', left: '14%', transform: 'scale(0.8)' },
    driftDur: '8.5s',
    driftDelay: '1.6s',
    depthClass: 'opacity-80 blur-[0.4px]',
  },
]

/**
 * Act 2 — proof-of-life cards that drift around the building once the
 * hero clears. Outer `.js-card` is GSAP's (opacity/scale/entrance);
 * the inner `.drift` element owns the idle float so the two transforms
 * never fight. `opacity:0` is inline so there's no pre-hydration flash.
 */
export function Act2Cards() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {CARDS.map((card) => (
        <div
          key={card.title}
          className={`js-card absolute ${card.depthClass}`}
          style={{ ...card.style, opacity: 0 }}
        >
          <div
            className="drift"
            style={
              {
                '--drift-dur': card.driftDur,
                '--drift-delay': card.driftDelay,
              } as CSSProperties
            }
          >
            <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.35)] backdrop-blur-md">
              <span className="text-[20px] leading-none">{card.icon}</span>
              <div className="text-left">
                <p className="text-[13.5px] font-medium text-white">{card.title}</p>
                <p className="text-eveno-mint mt-0.5 flex items-center gap-1.5 text-[11px]">
                  <span className="bg-eveno-mint h-1.5 w-1.5 rounded-full" />
                  Klart automatiskt
                </p>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
