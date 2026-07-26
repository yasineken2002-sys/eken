import { TOOLS, ACTION_TOOLS } from './ai-tools.definition'

/**
 * VERKTYGSKATALOGEN — enda sanningskällan för hur assistentens verktyg
 * presenteras för användaren.
 *
 * Bakgrund: frontend hade en egen `TOOL_LABELS`-lista som drev isär från
 * `TOOLS` utan att någon märkte det — 10 verktyg saknade etikett och föll
 * tillbaka på "Kör find optimization opportunities", och 2 etiketter pekade på
 * verktyg som inte längre fanns. En handhållen kopia av en lista som ändras på
 * ett annat ställe glider alltid isär till slut.
 *
 * Därför:
 *  • `binding` HÄRLEDS ur `ACTION_TOOLS` — det finns ingen andra lista att
 *    hålla i synk. Ett verktyg som läggs till i ACTION_TOOLS blir bindande i
 *    menyn samma sekund.
 *  • Saknas etikett/grupp för ett verktyg KASTAR `buildToolCatalog()`, och
 *    `ai-tools-catalog.spec.ts` fäller bygget. Ingen tyst fallback — det var
 *    precis så luckorna uppstod.
 */

export const TOOL_GROUPS = [
  'Ekonomi & avier',
  'Bankavstämning',
  'Avtal & hyresgäster',
  'Fastigheter & underhåll',
  'Dokument & juridik',
] as const

export type ToolGroup = (typeof TOOL_GROUPS)[number]

export interface ToolCatalogEntry {
  name: string
  label: string
  group: ToolGroup
  /** true = kräver användarens bekräftelse innan den körs (ACTION_TOOLS). */
  binding: boolean
}

/**
 * Etiketterna är skrivna i pågående form ("Hämtar fakturor", "Skapar faktura")
 * eftersom de i dag renderas som statusrad medan verktyget kör:
 * `{label}…`. Vill A4-menyn ha imperativ form ("Skapa faktura") är det ett
 * ANDRA fält i den här posten — inte en andra lista någon annanstans.
 */
const TOOL_META: Record<string, { label: string; group: ToolGroup }> = {
  // ── Ekonomi & avier ────────────────────────────────────────────────────────
  get_dashboard_stats: { label: 'Hämtar översikt', group: 'Ekonomi & avier' },
  get_overdue_invoices: { label: 'Hämtar förfallna fakturor', group: 'Ekonomi & avier' },
  get_invoices: { label: 'Hämtar fakturor', group: 'Ekonomi & avier' },
  get_revenue_report: { label: 'Hämtar intäktsrapport', group: 'Ekonomi & avier' },
  create_invoice: { label: 'Skapar faktura', group: 'Ekonomi & avier' },
  send_invoice_email: { label: 'Skickar faktura via e-post', group: 'Ekonomi & avier' },
  send_overdue_reminders: { label: 'Skickar betalningspåminnelser', group: 'Ekonomi & avier' },
  mark_invoice_paid: { label: 'Markerar faktura som betald', group: 'Ekonomi & avier' },
  export_sie4: { label: 'Exporterar SIE4-fil', group: 'Ekonomi & avier' },
  get_rent_notices: { label: 'Hämtar hyresavier', group: 'Ekonomi & avier' },
  generate_rent_notices: { label: 'Genererar hyresavier', group: 'Ekonomi & avier' },
  analyze_payment_behavior: { label: 'Analyserar betalningsbeteende', group: 'Ekonomi & avier' },
  compare_revenue: { label: 'Jämför intäkter över tid', group: 'Ekonomi & avier' },
  predict_cashflow: { label: 'Prognosticerar kassaflöde', group: 'Ekonomi & avier' },
  find_optimization_opportunities: {
    label: 'Letar efter förbättringsmöjligheter',
    group: 'Ekonomi & avier',
  },
  get_journal_entries: { label: 'Hämtar verifikat', group: 'Ekonomi & avier' },
  get_account_balance: { label: 'Hämtar kontosaldo', group: 'Ekonomi & avier' },
  get_vat_report: { label: 'Tar fram momsrapport', group: 'Ekonomi & avier' },
  get_profit_loss_report: { label: 'Tar fram resultaträkning', group: 'Ekonomi & avier' },
  get_balance_sheet: { label: 'Tar fram balansräkning', group: 'Ekonomi & avier' },
  create_journal_entry: { label: 'Bokför manuellt verifikat', group: 'Ekonomi & avier' },
  record_expense: { label: 'Bokför utgift', group: 'Ekonomi & avier' },
  close_period: { label: 'Stänger bokföringsperiod', group: 'Ekonomi & avier' },
  get_overdue_status: { label: 'Hämtar status på förfallna avier', group: 'Ekonomi & avier' },
  pause_reminders: { label: 'Pausar påminnelser', group: 'Ekonomi & avier' },
  resume_reminders: { label: 'Återupptar påminnelser', group: 'Ekonomi & avier' },
  export_for_collection: { label: 'Skapar inkassounderlag', group: 'Ekonomi & avier' },
  mark_sent_to_collection: { label: 'Markerar skickad till inkasso', group: 'Ekonomi & avier' },

  // ── Bankavstämning ─────────────────────────────────────────────────────────
  get_bank_transactions: { label: 'Hämtar banktransaktioner', group: 'Bankavstämning' },
  get_unmatched_transactions: { label: 'Hämtar omatchade transaktioner', group: 'Bankavstämning' },
  get_reconciliation_summary: { label: 'Hämtar avstämningsläget', group: 'Bankavstämning' },
  match_bank_transaction: { label: 'Matchar banktransaktion', group: 'Bankavstämning' },
  import_bgmax_file: { label: 'Importerar BgMax-fil', group: 'Bankavstämning' },
  unmatch_transaction: { label: 'Häver matchning', group: 'Bankavstämning' },

  // ── Avtal & hyresgäster ────────────────────────────────────────────────────
  get_tenants: { label: 'Hämtar hyresgäster', group: 'Avtal & hyresgäster' },
  get_expiring_leases: { label: 'Hämtar avtal som löper ut', group: 'Avtal & hyresgäster' },
  update_tenant: { label: 'Uppdaterar hyresgäst', group: 'Avtal & hyresgäster' },
  create_lease: { label: 'Skapar hyresavtal', group: 'Avtal & hyresgäster' },
  transition_lease_status: { label: 'Ändrar avtalsstatus', group: 'Avtal & hyresgäster' },
  create_tenant_and_lease: { label: 'Skapar hyresgäst och avtal', group: 'Avtal & hyresgäster' },
  calculate_rent_increases: { label: 'Beräknar hyreshöjningar', group: 'Avtal & hyresgäster' },
  apply_rent_increase: { label: 'Verkställer hyreshöjning', group: 'Avtal & hyresgäster' },

  // ── Fastigheter & underhåll ────────────────────────────────────────────────
  get_properties: { label: 'Hämtar fastigheter', group: 'Fastigheter & underhåll' },
  get_available_units: { label: 'Hämtar lediga objekt', group: 'Fastigheter & underhåll' },
  create_property: { label: 'Skapar fastighet', group: 'Fastigheter & underhåll' },
  create_unit: { label: 'Skapar objekt', group: 'Fastigheter & underhåll' },
  get_maintenance_tickets: { label: 'Hämtar felanmälningar', group: 'Fastigheter & underhåll' },
  create_maintenance_ticket: { label: 'Skapar felanmälan', group: 'Fastigheter & underhåll' },
  update_maintenance_status: {
    label: 'Uppdaterar felanmälans status',
    group: 'Fastigheter & underhåll',
  },
  get_maintenance_plan: { label: 'Hämtar underhållsplan', group: 'Fastigheter & underhåll' },
  get_inspections: { label: 'Hämtar besiktningar', group: 'Fastigheter & underhåll' },
  create_inspection: { label: 'Skapar besiktning', group: 'Fastigheter & underhåll' },

  // ── Dokument & juridik ─────────────────────────────────────────────────────
  compose_and_send_email: { label: 'Skriver och skickar e-post', group: 'Dokument & juridik' },
  generate_lease_contract: { label: 'Genererar hyreskontrakt', group: 'Dokument & juridik' },
  prepare_contract_signing: { label: 'Förbereder signering', group: 'Dokument & juridik' },
  send_document_to_tenant: {
    label: 'Skickar dokument till hyresgäst',
    group: 'Dokument & juridik',
  },
}

/**
 * Bygger katalogen ur `TOOLS`. Kastar hellre än att gissa: ett nytt verktyg
 * utan post ska stoppa bygget, inte tyst dyka upp i menyn utan namn.
 */
export function buildToolCatalog(): ToolCatalogEntry[] {
  return TOOLS.map((tool) => {
    const meta = TOOL_META[tool.name]
    if (!meta) {
      throw new Error(
        `Verktyget "${tool.name}" saknar etikett och grupp i TOOL_META ` +
          `(apps/api/src/ai/tools/ai-tools.catalog.ts). Lägg till en post — ` +
          `frontend har ingen egen lista att falla tillbaka på.`,
      )
    }
    return {
      name: tool.name,
      label: meta.label,
      group: meta.group,
      binding: ACTION_TOOLS.has(tool.name),
    }
  })
}

/** Exponeras för testet som vaktar att katalogen och TOOLS inte glider isär. */
export const TOOL_META_NAMES = Object.keys(TOOL_META)
