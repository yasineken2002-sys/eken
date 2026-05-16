import { IconChevronDown } from '@tabler/icons-react'

/**
 * Act 1 — the cosmic intro overlay. Pure presentation; the scroll
 * timeline in Experience drives `.js-hero` / `.js-scroll-ind` opacity.
 * Container is click-through; only the CTAs capture pointer events.
 */
export function Act1Hero() {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center px-6 pt-[16vh] text-center">
      <div className="js-hero flex flex-col items-center">
        <span className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-1.5 text-[12px] font-medium text-white/70 backdrop-blur-sm">
          🇸🇪 Sveriges smartaste fastighetssystem
        </span>

        <h1
          className="max-w-[16ch] font-medium leading-[1.05] text-white"
          style={{
            fontSize: 'clamp(48px, 8vw, 96px)',
            letterSpacing: '-0.04em',
          }}
        >
          Förvalta dina fastigheter{' '}
          <span className="from-eveno-electric to-eveno-mint bg-gradient-to-r bg-clip-text text-transparent">
            smartare.
          </span>
        </h1>

        <p className="mt-6 max-w-[560px] text-balance text-[clamp(15px,1.4vw,18px)] text-white/85">
          Allt på ett ställe. AI som tar smarta beslut åt dig.
        </p>

        <div className="pointer-events-auto mt-9 flex flex-col items-center gap-3 sm:flex-row">
          <button
            type="button"
            className="from-eveno-electric group relative inline-flex h-12 items-center justify-center rounded-xl bg-gradient-to-r to-[#6E8FE8] px-6 text-[14px] font-medium text-white shadow-[0_8px_30px_rgba(91,127,224,0.4)] transition-transform duration-200 hover:scale-[1.03] hover:shadow-[0_10px_40px_rgba(91,127,224,0.6)] active:scale-[0.98]"
          >
            Starta gratis i 30 dagar
            <span className="ml-2 transition-transform duration-200 group-hover:translate-x-0.5">
              →
            </span>
          </button>
          <button
            type="button"
            className="inline-flex h-12 items-center justify-center rounded-xl border border-white/25 bg-transparent px-6 text-[14px] font-medium text-white/90 transition-colors duration-200 hover:border-white/45 hover:bg-white/[0.04]"
          >
            Se hur det funkar
          </button>
        </div>

        <p className="mt-6 text-[12.5px] text-white/40">
          Inga kortuppgifter krävs · 30 dagar gratis · Avbryt när som helst
        </p>
      </div>

      <div className="js-scroll-ind absolute bottom-9 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 text-white/40">
        <span className="text-[11px] uppercase tracking-[0.22em]">
          Scrolla för att se Eveno i action
        </span>
        <IconChevronDown size={20} stroke={1.8} className="animate-bounce" aria-hidden />
      </div>
    </div>
  )
}
