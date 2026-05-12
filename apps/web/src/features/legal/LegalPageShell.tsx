import { ArrowLeft, Printer } from 'lucide-react'
import { motion } from 'framer-motion'
import { PLATFORM_COMPANY } from '@eken/shared'

export interface TocItem {
  id: string
  label: string
}

interface Props {
  title: string
  description: string
  version: string
  updatedAt: string
  toc: TocItem[]
  onBack: () => void
  children: React.ReactNode
}

/**
 * Visuell ram för alla publika juridiska sidor. Innehåller header med
 * tillbakaknapp + skriv-ut, sticky innehållsförteckning på desktop och
 * själva textinnehållet renderat med Tailwinds prose-stil.
 *
 * Print-stylingen tar bort header, TOC och bakgrund så att en juridiskt
 * användbar PDF kan tas fram direkt via webbläsarens "Skriv ut".
 */
export function LegalPageShell({
  title,
  description,
  version,
  updatedAt,
  toc,
  onBack,
  children,
}: Props) {
  return (
    <>
      <style>{`
        @media print {
          .legal-no-print { display: none !important; }
          .legal-content { max-width: none !important; }
          body { background: white !important; }
        }
      `}</style>
      <div className="min-h-screen bg-[#F7F8FA]">
        <header className="legal-no-print sticky top-0 z-10 border-b border-[#EAEDF0] bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <button
              onClick={onBack}
              className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              <ArrowLeft className="h-4 w-4" /> Tillbaka
            </button>
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 rounded-lg border border-[#DDDFE4] bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              <Printer className="h-3.5 w-3.5" /> Skriv ut
            </button>
          </div>
        </header>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="mx-auto grid max-w-6xl gap-10 px-6 py-12 lg:grid-cols-[220px_1fr]"
        >
          {/* Sticky TOC */}
          <aside className="legal-no-print hidden lg:block">
            <nav className="sticky top-24 space-y-1">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                Innehåll
              </p>
              {toc.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="block rounded-md px-2 py-1 text-[12.5px] text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </aside>

          <main className="legal-content min-w-0">
            <div className="mb-8">
              <h1 className="text-[28px] font-semibold tracking-tight text-gray-900">{title}</h1>
              <p className="mt-2 text-[14px] text-gray-500">{description}</p>
              <div className="mt-3 flex items-center gap-3 text-[12px] text-gray-400">
                <span>Version {version}</span>
                <span aria-hidden>·</span>
                <span>Senast uppdaterad {updatedAt}</span>
                <span aria-hidden>·</span>
                <span>{PLATFORM_COMPANY.legalName}</span>
              </div>
            </div>

            <article className="prose prose-sm prose-headings:scroll-mt-24 prose-headings:font-semibold prose-headings:text-gray-900 prose-h2:mt-10 prose-h2:text-[18px] prose-h3:mt-6 prose-h3:text-[15px] prose-p:my-3 prose-ul:my-3 prose-li:my-1 prose-table:text-[13px] prose-th:bg-gray-50 prose-th:text-left max-w-none text-[14px] leading-relaxed text-gray-700">
              {children}
            </article>

            <footer className="legal-no-print mt-16 flex flex-col gap-1 border-t border-[#EAEDF0] pt-6 text-[12px] text-gray-500">
              <p>
                © {new Date().getFullYear()} {PLATFORM_COMPANY.legalName} · org.nr{' '}
                {PLATFORM_COMPANY.orgNumber} · {PLATFORM_COMPANY.street},{' '}
                {PLATFORM_COMPANY.postalCode} {PLATFORM_COMPANY.city}
              </p>
              <p>
                Kontakt:{' '}
                <a
                  href={`mailto:${PLATFORM_COMPANY.email}`}
                  className="text-blue-600 hover:underline"
                >
                  {PLATFORM_COMPANY.email}
                </a>{' '}
                · Dataskydd:{' '}
                <a
                  href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}
                  className="text-blue-600 hover:underline"
                >
                  {PLATFORM_COMPANY.privacyEmail}
                </a>
              </p>
            </footer>
          </main>
        </motion.div>
      </div>
    </>
  )
}
