export default function Home() {
  return (
    <main>
      {/* ── Hero placeholder ─────────────────────────────────────── */}
      <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 text-center">
        {/* Soft electric glow behind the title */}
        <div
          aria-hidden
          className="bg-eveno-electric/20 pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[140px]"
        />

        <span className="relative z-10 mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 text-[12px] font-medium text-white/70 backdrop-blur-sm">
          <span className="bg-eveno-mint h-1.5 w-1.5 rounded-full" />
          Sveriges smartaste fastighetssystem
        </span>

        <h1
          className="relative z-10 text-balance text-6xl font-semibold tracking-tight text-white sm:text-7xl md:text-8xl"
          style={{ textShadow: '0 0 60px rgba(91, 127, 224, 0.45)' }}
        >
          Hello Eveno
        </h1>

        <p className="relative z-10 mt-6 max-w-md text-balance text-[15px] text-white/60">
          Snart kommer Sveriges coolaste säljsida.
        </p>

        <span className="absolute bottom-10 left-1/2 -translate-x-1/2 text-[11px] uppercase tracking-[0.2em] text-white/30">
          Scrolla
        </span>
      </section>

      {/* ── Scroll demo (proves Lenis smooth-scroll is active) ───── */}
      <section className="bg-cosmic-gradient flex min-h-screen items-center justify-center px-6 text-center">
        <p className="max-w-lg text-balance text-[15px] text-white/40">
          Fundamentet är på plats. Den kinematiska scroll-resan byggs i nästa fas.
        </p>
      </section>
    </main>
  )
}
