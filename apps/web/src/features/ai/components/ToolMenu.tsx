import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Building2,
  CalendarRange,
  ClipboardCheck,
  FileText,
  FolderOpen,
  Gavel,
  Home,
  LayoutDashboard,
  MessageSquare,
  Receipt,
  TrendingUp,
  Upload,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useFocusTrap } from '@eken/ui/react'
import { cn } from '@/lib/cn'
import type { ToolCatalogEntry, ToolGroup } from '../api/ai.api'

/**
 * Ikonerna är LÅNADE, inte uppfunna: varje verktyg får samma linjeikon som
 * motsvarande område redan har i sidomenyn (Fakturor = Receipt, Bokföring =
 * BookOpen, Inkasso = Gavel, Objekt = Home, Underhåll = Wrench …). Menyn ska
 * kännas igen från appen, inte introducera ett eget ikonspråk.
 *
 * Tabellen är skriven ikon → verktyg för att hållas läsbar; den plattas ut till
 * en uppslagning nedan.
 */
const ICON_TOOLS: [LucideIcon, string[]][] = [
  [LayoutDashboard, ['get_dashboard_stats']],
  [
    Receipt,
    [
      'get_overdue_invoices',
      'get_invoices',
      'create_invoice',
      'mark_invoice_paid',
      'get_rent_notices',
      'generate_rent_notices',
    ],
  ],
  [
    BarChart3,
    [
      'get_revenue_report',
      'analyze_payment_behavior',
      'compare_revenue',
      'get_vat_report',
      'get_profit_loss_report',
      'get_balance_sheet',
    ],
  ],
  [
    BookOpen,
    [
      'export_sie4',
      'get_journal_entries',
      'get_account_balance',
      'create_journal_entry',
      'record_expense',
      'close_period',
    ],
  ],
  [TrendingUp, ['predict_cashflow', 'find_optimization_opportunities']],
  [
    Gavel,
    [
      'get_overdue_status',
      'pause_reminders',
      'resume_reminders',
      'export_for_collection',
      'mark_sent_to_collection',
    ],
  ],
  [MessageSquare, ['send_invoice_email', 'send_overdue_reminders', 'compose_and_send_email']],
  [
    ArrowLeftRight,
    [
      'get_bank_transactions',
      'get_unmatched_transactions',
      'get_reconciliation_summary',
      'match_bank_transaction',
      'unmatch_transaction',
    ],
  ],
  [Upload, ['import_bgmax_file']],
  [Users, ['get_tenants', 'update_tenant', 'create_tenant_and_lease']],
  [
    FileText,
    [
      'get_expiring_leases',
      'create_lease',
      'transition_lease_status',
      'generate_lease_contract',
      'prepare_contract_signing',
    ],
  ],
  [TrendingUp, ['calculate_rent_increases', 'apply_rent_increase']],
  [Building2, ['get_properties', 'create_property']],
  [Home, ['get_available_units', 'create_unit']],
  [Wrench, ['get_maintenance_tickets', 'create_maintenance_ticket', 'update_maintenance_status']],
  [CalendarRange, ['get_maintenance_plan']],
  [ClipboardCheck, ['get_inspections', 'create_inspection']],
  [FolderOpen, ['send_document_to_tenant']],
]

const TOOL_ICONS: Record<string, LucideIcon> = Object.fromEntries(
  ICON_TOOLS.flatMap(([icon, names]) => names.map((n) => [n, icon])),
)

/**
 * Gruppens egen ikon — rubriken, och reserv för ett verktyg som saknar egen.
 * En saknad ikon får till skillnad från en saknad etikett falla tillbaka: raden
 * blir generisk, inte trasig. Typen är exhaustiv, så en NY grupp fäller
 * TypeScript här tills den fått en ikon.
 */
const GROUP_ICONS: Record<ToolGroup, LucideIcon> = {
  'Ekonomi & avier': Receipt,
  Bankavstämning: ArrowLeftRight,
  'Avtal & hyresgäster': FileText,
  'Fastigheter & underhåll': Building2,
  'Dokument & juridik': FolderOpen,
}

interface ToolMenuProps {
  /** Katalogen från `GET /v1/ai/tools`. Undefined medan den hämtas. */
  catalog: ToolCatalogEntry[] | undefined
  /** Anropas med det valda verktyget. Får ALDRIG köra något. */
  onSelect: (entry: ToolCatalogEntry) => void
  /** Docked-läget har en snävare kompositör — knappen krymper. */
  compact: boolean
}

/**
 * Verktygsmenyn i kompositören.
 *
 * SÄKERHETSREGELN: att välja ett verktyg här fyller bara textarean med en
 * påbörjad prompt och sätter fokus. Den skickar ingenting, kallar inget API och
 * startar ingen åtgärd. Bindande verktyg får aldrig vara ett klick från
 * exekvering — bekräftelseflödet (pendingAction → /ai/confirm) är oförändrat,
 * och menyn ligger utanför det. "bekräftas"-taggen är därför en upplysning om
 * vad som händer LÄNGRE fram i flödet, inte en varning om klicket.
 *
 * A11y följer samma mönster som den delade `Modal`: role="dialog", focus-trap
 * (fokus flyttas in, cyklar med Tab, återställs vid stängning) och Escape som
 * stänger.
 */
export function ToolMenu({ catalog, onSelect, compact }: ToolMenuProps) {
  const [open, setOpen] = useState(false)
  const trapRef = useFocusTrap<HTMLDivElement>(open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /**
   * Grupperna kommer i den ordning de först dyker upp i katalogen — alltså
   * serverns ordning. Ingen hårdkodad grupplista här; skulle backend lägga
   * till en grupp syns den utan att den här filen ändras.
   */
  const groups = useMemo(() => {
    const byGroup = new Map<ToolGroup, ToolCatalogEntry[]>()
    for (const entry of catalog ?? []) {
      const list = byGroup.get(entry.group)
      if (list) list.push(entry)
      else byGroup.set(entry.group, [entry])
    }
    return [...byGroup.entries()]
  }, [catalog])

  const total = catalog?.length ?? 0

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={total === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Visa vad jag kan göra"
        className={cn(
          'border-line flex items-center gap-1.5 rounded-lg border text-gray-700 transition-colors',
          'hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40',
          open && 'border-blue-300 bg-blue-50',
          compact ? 'h-8 px-2.5 text-[12.5px]' : 'h-9 px-3 text-[13px]',
        )}
      >
        <Wrench size={compact ? 13 : 14} strokeWidth={1.8} className="text-blue-600" />
        <span className="font-medium">Verktyg</span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* Klick utanför stänger. Ligger under panelen men över sidan. */}
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
            <motion.div
              ref={trapRef}
              role="dialog"
              aria-modal="true"
              aria-label={`Verktyg — ${total} stycken`}
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.97, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 8 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className="border-line bg-surface absolute bottom-full right-0 z-50 mb-2 flex max-h-[min(28rem,calc(50vh-6rem))] w-[min(26rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border shadow-xl outline-none"
            >
              <div className="border-line flex flex-shrink-0 items-baseline justify-between border-b px-4 py-3">
                <h3 className="text-ink text-[13.5px] font-semibold">Vad jag kan göra</h3>
                <span className="text-[11.5px] text-gray-500">{total} verktyg</span>
              </div>

              <div className="flex-1 overflow-y-auto py-1.5">
                {groups.map(([group, entries]) => {
                  const Icon = GROUP_ICONS[group]
                  return (
                    <div key={group} className="mb-1 last:mb-0">
                      <div className="flex items-center gap-1.5 px-4 pb-1 pt-2">
                        {Icon && (
                          <Icon size={12} strokeWidth={1.8} className="text-blue-600" aria-hidden />
                        )}
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                          {group}
                        </span>
                      </div>
                      {entries.map((entry) => {
                        const ToolIcon = TOOL_ICONS[entry.name] ?? Icon
                        return (
                          <button
                            key={entry.name}
                            type="button"
                            onClick={() => {
                              onSelect(entry)
                              setOpen(false)
                            }}
                            className="flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none"
                          >
                            {ToolIcon && (
                              <ToolIcon
                                size={14}
                                strokeWidth={1.8}
                                className="flex-shrink-0 text-blue-600"
                                aria-hidden
                              />
                            )}
                            <span className="min-w-0 flex-1 truncate text-[13px] text-gray-700">
                              {entry.menuLabel}
                            </span>
                            {entry.binding && (
                              <span className="flex-shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                                bekräftas
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
              </div>

              <p className="border-line flex-shrink-0 border-t px-4 py-2.5 text-[11.5px] text-gray-500">
                Ett val fyller bara rutan — inget körs förrän du skickar.
              </p>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
