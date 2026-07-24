import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { motion } from 'framer-motion'

// Liten lokal className-hjälpare — undviker beroende på appens cn()/clsx.
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface DataTableColumn<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  width?: string
  align?: 'left' | 'right' | 'center'
  /** Extra klasser på cellen (t.ex. `font-mono`, `tabular-nums`, avvikande textstorlek). */
  cellClassName?: string
  /** Extra klasser på kolumnrubriken. */
  headerClassName?: string
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  data: T[]
  keyExtractor: (row: T) => string
  /**
   * Gör raden klickbar. Sätts den blir raden också tangentbordsåtkomlig
   * (Tab → Enter/Blanksteg) — se a11y-noten nedan.
   */
  onRowClick?: (row: T) => void
  /** Tillgänglig etikett för en klickbar rad. Utan den läses radens celler upp. */
  rowLabel?: (row: T) => string
  /** Text när `data` är tom. */
  emptyMessage?: string
  /** Visar en laddrad istället för tomt-tillståndet. */
  loading?: boolean
  loadingMessage?: string
  /**
   * Rendera komponentens egen kort-wrapper (rounded-2xl border bg-white).
   * Sätt `false` när tabellen redan ligger i ett <Card>/<CardBody> (admin).
   */
  wrapper?: boolean
  /**
   * `default` = webs täthet (px-5 py-3.5). `compact` = admins täthet på breda
   * tabeller (px-3, px-5 på ytterkolumnerna, py-3).
   */
  density?: 'default' | 'compact'
  className?: string
}

const container = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const item = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.15 } } }

function alignClass(align: DataTableColumn<unknown>['align']): string {
  return align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : ''
}

/**
 * Delad DataTable (web + admin). Konsoliderar webs komponent och admins
 * handrullade <table>-block till EN källa.
 *
 * TILLGÄNGLIGHET (WCAG 2.1.1 Keyboard, 2.4.7 Focus Visible):
 * En klickbar rad får `tabIndex=0`, aktiveras med Enter OCH Blanksteg och har en
 * synlig `:focus-visible`-ring. Rader utan `onRowClick` är inte fokuserbara.
 *
 * OBS — medvetet INGEN `role="button"` på <tr>: ARIA tillåter bara rollen `row`
 * för ett <tr> inuti en tabell. Skriver man över den blir <td>-barnen (roll
 * `cell`) föräldralösa och axe-regeln `aria-required-parent` FALLERAR — dvs det
 * hade bytt ett tangentbordsfel mot ett strukturfel. Vi behåller därför
 * radsemantiken och lägger bara till tangentbordsaktivering, vilket är det
 * mönster WAI-ARIA APG anvisar för klickbara rader.
 *
 * Färg: radens hover/avdelare kommer från komponent-variablerna `--ev-row-hover`
 * / `--ev-row-border` (se tokens.ts). Klasserna genereras av web/admins Tailwind
 * — deras config scannar packages/ui/src (content-glob).
 */
export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  rowLabel,
  emptyMessage = 'Inga poster att visa',
  loading = false,
  loadingMessage = 'Laddar…',
  wrapper = true,
  density = 'default',
  className,
}: DataTableProps<T>) {
  const clickable = Boolean(onRowClick)
  const lastIndex = columns.length - 1

  const padX = (index: number): string =>
    density === 'compact' && index !== 0 && index !== lastIndex ? 'px-3' : 'px-5'

  const handleKeyDown = (row: T) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    // Låt kontroller inuti raden (knappar, länkar) hantera sin egen tangent.
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    onRowClick?.(row)
  }

  const table = (
    <>
      <div className="overflow-x-auto">
        {/* Textstorleken sitter på <table> och ÄRVS av cellerna — då kan en
            kolumns `cellClassName` sätta en egen storlek utan klasskrock. */}
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/60">
              {columns.map((col, index) => (
                <th
                  key={col.key}
                  scope="col"
                  style={col.width ? ({ width: col.width } as CSSProperties) : undefined}
                  className={cx(
                    'whitespace-nowrap py-3 text-[11.5px] font-semibold uppercase tracking-wider text-gray-400',
                    padX(index),
                    alignClass(col.align) || 'text-left',
                    col.headerClassName,
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <motion.tbody variants={container} initial="hidden" animate="show">
            {loading && (
              <tr>
                <td colSpan={columns.length} className="px-5 py-10 text-center text-gray-500">
                  {loadingMessage}
                </td>
              </tr>
            )}
            {!loading &&
              data.map((row) => (
                <motion.tr
                  key={keyExtractor(row)}
                  variants={item}
                  onClick={clickable ? () => onRowClick?.(row) : undefined}
                  onKeyDown={clickable ? handleKeyDown(row) : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={clickable && rowLabel ? rowLabel(row) : undefined}
                  className={cx(
                    'border-b border-[var(--ev-row-border)] transition-colors duration-100 last:border-0 hover:bg-[var(--ev-row-hover)]',
                    clickable &&
                      'focus-visible:outline-brand cursor-pointer outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2',
                  )}
                >
                  {columns.map((col, index) => (
                    <td
                      key={col.key}
                      className={cx(
                        density === 'compact' ? 'py-3' : 'py-3.5',
                        padX(index),
                        alignClass(col.align),
                        col.cellClassName,
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </motion.tr>
              ))}
          </motion.tbody>
        </table>
      </div>
      {!loading && data.length === 0 && (
        <div className="py-14 text-center text-[13.5px] text-gray-400">{emptyMessage}</div>
      )}
    </>
  )

  if (!wrapper) return <div className={className}>{table}</div>

  return (
    <div
      className={cx(
        'overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.04)]',
        className,
      )}
    >
      {table}
    </div>
  )
}
