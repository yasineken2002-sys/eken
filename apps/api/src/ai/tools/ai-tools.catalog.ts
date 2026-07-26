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
  /** Pågående form ("Skapar faktura") — statusraden medan verktyget kör. */
  label: string
  /** Imperativ form ("Skapa faktura") — verktygsmenyn i kompositören. */
  menuLabel: string
  group: ToolGroup
  /** true = kräver användarens bekräftelse innan den körs (ACTION_TOOLS). */
  binding: boolean
}

/**
 * Två etiketter per verktyg, i SAMMA post — inte två listor på två ställen.
 *
 *  • `label` är pågående form och renderas som statusrad medan verktyget kör:
 *    `{label}…` → "Skapar faktura…".
 *  • `menuLabel` är imperativ form och är vad verktygsmenyn visar: användaren
 *    läser den som en sak hen kan be om, inte som något som redan händer.
 *
 * Behöver menyn en handskriven startprompt per verktyg någon gång är det ett
 * TREDJE fält i den här posten. Menyn härleder i dag sin startprompt ur
 * `menuLabel` (se ToolMenu.tsx) — den har ingen egen lista.
 */
const TOOL_META: Record<string, { label: string; menuLabel: string; group: ToolGroup }> = {
  // ── Ekonomi & avier ────────────────────────────────────────────────────────
  get_dashboard_stats: {
    label: 'Hämtar översikt',
    menuLabel: 'Hämta översikt',
    group: 'Ekonomi & avier',
  },
  get_overdue_invoices: {
    label: 'Hämtar förfallna fakturor',
    menuLabel: 'Hämta förfallna fakturor',
    group: 'Ekonomi & avier',
  },
  get_invoices: {
    label: 'Hämtar fakturor',
    menuLabel: 'Hämta fakturor',
    group: 'Ekonomi & avier',
  },
  get_revenue_report: {
    label: 'Hämtar intäktsrapport',
    menuLabel: 'Hämta intäktsrapport',
    group: 'Ekonomi & avier',
  },
  create_invoice: {
    label: 'Skapar faktura',
    menuLabel: 'Skapa faktura',
    group: 'Ekonomi & avier',
  },
  send_invoice_email: {
    label: 'Skickar faktura via e-post',
    menuLabel: 'Skicka faktura via e-post',
    group: 'Ekonomi & avier',
  },
  send_overdue_reminders: {
    label: 'Skickar betalningspåminnelser',
    menuLabel: 'Skicka betalningspåminnelser',
    group: 'Ekonomi & avier',
  },
  mark_invoice_paid: {
    label: 'Markerar faktura som betald',
    menuLabel: 'Markera faktura som betald',
    group: 'Ekonomi & avier',
  },
  export_sie4: {
    label: 'Exporterar SIE4-fil',
    menuLabel: 'Exportera SIE4-fil',
    group: 'Ekonomi & avier',
  },
  get_rent_notices: {
    label: 'Hämtar hyresavier',
    menuLabel: 'Hämta hyresavier',
    group: 'Ekonomi & avier',
  },
  generate_rent_notices: {
    label: 'Genererar hyresavier',
    menuLabel: 'Generera hyresavier',
    group: 'Ekonomi & avier',
  },
  analyze_payment_behavior: {
    label: 'Analyserar betalningsbeteende',
    menuLabel: 'Analysera betalningsbeteende',
    group: 'Ekonomi & avier',
  },
  compare_revenue: {
    label: 'Jämför intäkter över tid',
    menuLabel: 'Jämför intäkter över tid',
    group: 'Ekonomi & avier',
  },
  predict_cashflow: {
    label: 'Prognosticerar kassaflöde',
    menuLabel: 'Prognosticera kassaflöde',
    group: 'Ekonomi & avier',
  },
  find_optimization_opportunities: {
    label: 'Letar efter förbättringsmöjligheter',
    menuLabel: 'Leta efter förbättringsmöjligheter',
    group: 'Ekonomi & avier',
  },
  get_journal_entries: {
    label: 'Hämtar verifikat',
    menuLabel: 'Hämta verifikat',
    group: 'Ekonomi & avier',
  },
  get_account_balance: {
    label: 'Hämtar kontosaldo',
    menuLabel: 'Hämta kontosaldo',
    group: 'Ekonomi & avier',
  },
  get_vat_report: {
    label: 'Tar fram momsrapport',
    menuLabel: 'Ta fram momsrapport',
    group: 'Ekonomi & avier',
  },
  get_profit_loss_report: {
    label: 'Tar fram resultaträkning',
    menuLabel: 'Ta fram resultaträkning',
    group: 'Ekonomi & avier',
  },
  get_balance_sheet: {
    label: 'Tar fram balansräkning',
    menuLabel: 'Ta fram balansräkning',
    group: 'Ekonomi & avier',
  },
  create_journal_entry: {
    label: 'Bokför manuellt verifikat',
    menuLabel: 'Bokför manuellt verifikat',
    group: 'Ekonomi & avier',
  },
  record_expense: {
    label: 'Bokför utgift',
    menuLabel: 'Bokför utgift',
    group: 'Ekonomi & avier',
  },
  close_period: {
    label: 'Stänger bokföringsperiod',
    menuLabel: 'Stäng bokföringsperiod',
    group: 'Ekonomi & avier',
  },
  get_overdue_status: {
    label: 'Hämtar status på förfallna avier',
    menuLabel: 'Hämta status på förfallna avier',
    group: 'Ekonomi & avier',
  },
  pause_reminders: {
    label: 'Pausar påminnelser',
    menuLabel: 'Pausa påminnelser',
    group: 'Ekonomi & avier',
  },
  resume_reminders: {
    label: 'Återupptar påminnelser',
    menuLabel: 'Återuppta påminnelser',
    group: 'Ekonomi & avier',
  },
  export_for_collection: {
    label: 'Skapar inkassounderlag',
    menuLabel: 'Skapa inkassounderlag',
    group: 'Ekonomi & avier',
  },
  mark_sent_to_collection: {
    label: 'Markerar skickad till inkasso',
    menuLabel: 'Markera skickad till inkasso',
    group: 'Ekonomi & avier',
  },

  // ── Bankavstämning ─────────────────────────────────────────────────────────
  get_bank_transactions: {
    label: 'Hämtar banktransaktioner',
    menuLabel: 'Hämta banktransaktioner',
    group: 'Bankavstämning',
  },
  get_unmatched_transactions: {
    label: 'Hämtar omatchade transaktioner',
    menuLabel: 'Hämta omatchade transaktioner',
    group: 'Bankavstämning',
  },
  get_reconciliation_summary: {
    label: 'Hämtar avstämningsläget',
    menuLabel: 'Hämta avstämningsläget',
    group: 'Bankavstämning',
  },
  match_bank_transaction: {
    label: 'Matchar banktransaktion',
    menuLabel: 'Matcha banktransaktion',
    group: 'Bankavstämning',
  },
  import_bgmax_file: {
    label: 'Importerar BgMax-fil',
    menuLabel: 'Importera BgMax-fil',
    group: 'Bankavstämning',
  },
  unmatch_transaction: {
    label: 'Häver matchning',
    menuLabel: 'Häv matchning',
    group: 'Bankavstämning',
  },

  // ── Avtal & hyresgäster ────────────────────────────────────────────────────
  get_tenants: {
    label: 'Hämtar hyresgäster',
    menuLabel: 'Hämta hyresgäster',
    group: 'Avtal & hyresgäster',
  },
  get_expiring_leases: {
    label: 'Hämtar avtal som löper ut',
    menuLabel: 'Hämta avtal som löper ut',
    group: 'Avtal & hyresgäster',
  },
  update_tenant: {
    label: 'Uppdaterar hyresgäst',
    menuLabel: 'Uppdatera hyresgäst',
    group: 'Avtal & hyresgäster',
  },
  create_lease: {
    label: 'Skapar hyresavtal',
    menuLabel: 'Skapa hyresavtal',
    group: 'Avtal & hyresgäster',
  },
  transition_lease_status: {
    label: 'Ändrar avtalsstatus',
    menuLabel: 'Ändra avtalsstatus',
    group: 'Avtal & hyresgäster',
  },
  create_tenant_and_lease: {
    label: 'Skapar hyresgäst och avtal',
    menuLabel: 'Skapa hyresgäst och avtal',
    group: 'Avtal & hyresgäster',
  },
  calculate_rent_increases: {
    label: 'Beräknar hyreshöjningar',
    menuLabel: 'Beräkna hyreshöjningar',
    group: 'Avtal & hyresgäster',
  },
  apply_rent_increase: {
    label: 'Verkställer hyreshöjning',
    menuLabel: 'Verkställ hyreshöjning',
    group: 'Avtal & hyresgäster',
  },

  // ── Fastigheter & underhåll ────────────────────────────────────────────────
  get_properties: {
    label: 'Hämtar fastigheter',
    menuLabel: 'Hämta fastigheter',
    group: 'Fastigheter & underhåll',
  },
  get_available_units: {
    label: 'Hämtar lediga objekt',
    menuLabel: 'Hämta lediga objekt',
    group: 'Fastigheter & underhåll',
  },
  create_property: {
    label: 'Skapar fastighet',
    menuLabel: 'Skapa fastighet',
    group: 'Fastigheter & underhåll',
  },
  create_unit: {
    label: 'Skapar objekt',
    menuLabel: 'Skapa objekt',
    group: 'Fastigheter & underhåll',
  },
  get_maintenance_tickets: {
    label: 'Hämtar felanmälningar',
    menuLabel: 'Hämta felanmälningar',
    group: 'Fastigheter & underhåll',
  },
  create_maintenance_ticket: {
    label: 'Skapar felanmälan',
    menuLabel: 'Skapa felanmälan',
    group: 'Fastigheter & underhåll',
  },
  update_maintenance_status: {
    label: 'Uppdaterar felanmälans status',
    menuLabel: 'Uppdatera felanmälans status',
    group: 'Fastigheter & underhåll',
  },
  get_maintenance_plan: {
    label: 'Hämtar underhållsplan',
    menuLabel: 'Hämta underhållsplan',
    group: 'Fastigheter & underhåll',
  },
  get_inspections: {
    label: 'Hämtar besiktningar',
    menuLabel: 'Hämta besiktningar',
    group: 'Fastigheter & underhåll',
  },
  create_inspection: {
    label: 'Skapar besiktning',
    menuLabel: 'Skapa besiktning',
    group: 'Fastigheter & underhåll',
  },

  // ── Dokument & juridik ─────────────────────────────────────────────────────
  compose_and_send_email: {
    label: 'Skriver och skickar e-post',
    menuLabel: 'Skriv och skicka e-post',
    group: 'Dokument & juridik',
  },
  generate_lease_contract: {
    label: 'Genererar hyreskontrakt',
    menuLabel: 'Generera hyreskontrakt',
    group: 'Dokument & juridik',
  },
  prepare_contract_signing: {
    label: 'Förbereder signering',
    menuLabel: 'Förbered signering',
    group: 'Dokument & juridik',
  },
  send_document_to_tenant: {
    label: 'Skickar dokument till hyresgäst',
    menuLabel: 'Skicka dokument till hyresgäst',
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
      menuLabel: meta.menuLabel,
      group: meta.group,
      binding: ACTION_TOOLS.has(tool.name),
    }
  })
}

/** Exponeras för testet som vaktar att katalogen och TOOLS inte glider isär. */
export const TOOL_META_NAMES = Object.keys(TOOL_META)
