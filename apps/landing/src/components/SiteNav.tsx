/**
 * Navigation skeleton. Structure only for Phase 1 — links are
 * placeholders; the scroll-driven nav behaviour lands in later phases.
 */
export function SiteNav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <a href="/" className="text-[15px] font-semibold tracking-tight text-white">
          Eveno
        </a>

        <div className="hidden items-center gap-8 text-[13px] text-white/60 md:flex">
          <span className="cursor-default transition-colors hover:text-white/85">Funktioner</span>
          <span className="cursor-default transition-colors hover:text-white/85">Priser</span>
          <span className="cursor-default transition-colors hover:text-white/85">Kommer snart</span>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden text-[13px] text-white/60 transition-colors hover:text-white/85 sm:inline">
            Logga in
          </span>
          <span className="bg-eveno-electric shadow-eveno-electric/30 rounded-lg px-4 py-2 text-[13px] font-medium text-white shadow-sm">
            Starta gratis
          </span>
        </div>
      </nav>
    </header>
  )
}
