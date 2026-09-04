import { ACTION_TOOLS } from './ai-tools.definition'

/**
 * DELMÄNGDSREGELN — det mekaniska beviset för planens Regel 2.
 *
 * ── VAD REGELN SÄGER ────────────────────────────────────────────────────────
 *
 * "Varje förmåga agenten får måste ha en motsvarande mänsklig väg. Kan agenten
 * göra något människan inte kan göra i gränssnittet har implementationen brutit
 * mot arkitekturen." (`docs/eveno-agentplan.md`, Del 2.)
 *
 * En regel som bara står i prosa slutar gälla långsamt och osynligt: verktyg
 * nummer 31 läggs till en tisdag, ingen ställer frågan, och agenten kan sedan
 * en sak hyresvärden inte kan. Den här filen gör frågan TVINGANDE — ett verktyg
 * utan post här stoppar bygget, och `check-tool-human-path.mjs` fäller CI.
 *
 * ── VARFÖR INTE ETT FÄLT PÅ `EFFECT_DECLARATIONS` ───────────────────────────
 *
 * Det hade varit en rad kod, och det hade varit fel. De två deklarationerna
 * svarar på olika frågor:
 *
 *     EFFECT_DECLARATIONS   vad tål effekten om den körs en gång till?
 *     HUMAN_PATHS           finns samma sak att göra för hand i gränssnittet?
 *
 * Den första handlar om databasen, den andra om apps/web. De ändras av olika
 * skäl, av olika händer, och en post kan vara rätt i den ena och fel i den
 * andra samma dag. Att slå ihop dem hade gjort skillnaden osynlig — se
 * CLAUDE.md, "Återanvänd inte ett fält som svarar på en ANNAN fråga", där
 * exakt det lånet en gång hade stängt ute elva verktyg utan att något blev
 * rött.
 *
 * ── `saknas` ÄR ETT FYND, INTE EN URSÄKT ────────────────────────────────────
 *
 * Sju av de trettio verktygen har ingen mänsklig väg i dag. Det är mätt, inte
 * antaget, och det är precis vad regeln finns för att göra synligt. Att hitta
 * på en rutt hade gjort vakten grön och regeln osann — den sortens lagning är
 * värre än hålet, eftersom nästa person då tror att frågan är ställd.
 *
 * ── VEM LÄSER DEN HÄR FILEN I DAG ───────────────────────────────────────────
 *
 * `check-tool-human-path.mjs` och `human-path.spec.ts`, och ingen annan. Det är
 * avsiktligt och ska inte läsas som en död deklaration: filen är den TVINGANDE
 * FRÅGAN, precis som `EFFECT_PRODUCING_TOOLS` är det trots att mekanismen den
 * beskriver är automatisk. Inkorgens godkännandekort (etapp 6) blir den första
 * visningsytan som läser `rutt`/`atgard` — den byggs inte här, eftersom en
 * frågeväg utan anropare är en vakt med tom mängd.
 *
 * Mängden `saknas` är därför en RATCHET: `apps/api/scripts/tool-human-path.baseline.json`
 * räknar upp de sju med skäl och ärendeplats, och vakten fäller åt ALLA TRE
 * hållen — ett åttonde verktyg utan väg är `NY` och rött, en post som fått en
 * väg är `STALE` och rött, och ett namn som inte är ett verktyg är rött.
 * Baslinjen får bara krympa.
 */

/** En mänsklig väg: en rutt i `apps/web/src/app/router.tsx` plus en åtgärd. */
export interface MansligVag {
  /** Exakt path-literal ur `router.tsx`. Vakten fäller på en rutt som inte finns. */
  rutt: string
  /**
   * Den SYNLIGA åtgärden på sidan — knapptext, fliktext, menypost. Måste
   * förekomma ordagrant i den feature-katalog rutten pekar på; vakten slår upp
   * den. Det är en driftdetektering, inte ett bevis att knappen är klickbar.
   */
  atgard: string
}

/**
 * Ingen mänsklig väg finns. Ett FYND enligt Regel 2 — se docblocket ovan.
 *
 * Markören bär INGEN prosa, och det är avsiktligt. Skälet och ärendet står i
 * `apps/api/scripts/tool-human-path.baseline.json`, på ett enda ställe. Två
 * beskrivningar av samma sak glider isär, och den som läser den ena vet inte att
 * den andra finns — samma defekt som `docs/legal` och de renderade sidorna.
 *
 * Det enda som står på båda ställena är NAMNET, och `check-tool-human-path.mjs`
 * kräver exakt likhet åt båda hållen. Ett namn kan inte glida; en mening kan.
 */
export interface SaknadMansligVag {
  saknas: true
}

export type HumanPathDeklaration = MansligVag | SaknadMansligVag

export function arSaknad(d: HumanPathDeklaration): d is SaknadMansligVag {
  return 'saknas' in d
}

/**
 * En post per verktyg i `ACTION_TOOLS`. Både riktningarna vaktas: ett verktyg
 * utan post fäller, och en post utan verktyg fäller.
 *
 * Rutterna är verifierade mot `apps/web/src/app/router.tsx` och åtgärderna mot
 * respektive feature-katalog, 2026-09-04.
 */
export const HUMAN_PATHS: Record<string, HumanPathDeklaration> = {
  // ── Felanmälan ────────────────────────────────────────────────────────────
  create_maintenance_ticket: { rutt: '/maintenance', atgard: 'Ny felanmälan' },
  update_maintenance_status: { rutt: '/maintenance', atgard: 'Påbörja' },

  // ── Fakturor ──────────────────────────────────────────────────────────────
  create_invoice: { rutt: '/invoices', atgard: 'Ny faktura' },
  send_invoice_email: { rutt: '/invoices', atgard: 'Skicka via e-post' },
  mark_invoice_paid: { rutt: '/invoices', atgard: 'Registrera betalning' },

  // ── Avtal och hyresgäster ─────────────────────────────────────────────────
  create_lease: { rutt: '/leases', atgard: 'Nytt hyresavtal' },
  transition_lease_status: { rutt: '/leases', atgard: 'Aktivera' },
  // Samma formulär bär BÅDA verktygen: `create_lease` mot en befintlig hyresgäst
  // och `create_tenant_and_lease` som skapar hyresgästen i samma steg. Ingången
  // är en, och det är ingången regeln handlar om.
  create_tenant_and_lease: { rutt: '/leases', atgard: 'Nytt hyresavtal' },
  generate_lease_contract: { rutt: '/leases', atgard: 'Generera hyreskontrakt' },

  // ── Fastigheter och objekt ────────────────────────────────────────────────
  create_property: { rutt: '/properties', atgard: 'Ny fastighet' },
  create_unit: { rutt: '/units', atgard: 'Nytt objekt' },

  // ── Rapporter och utskick ─────────────────────────────────────────────────
  export_sie4: { rutt: '/reports', atgard: 'SIE4-export' },
  compose_and_send_email: { rutt: '/messages', atgard: 'Nytt meddelande' },
  apply_rent_increase: { rutt: '/rent-increases', atgard: 'Ny hyreshöjning' },
  generate_rent_notices: { rutt: '/avisering', atgard: 'Generera hyresavier' },
  create_inspection: { rutt: '/inspections', atgard: 'Ny besiktning' },

  // ── Bankavstämning ────────────────────────────────────────────────────────
  match_bank_transaction: { rutt: '/reconciliation', atgard: 'Matcha transaktion' },
  import_bgmax_file: { rutt: '/reconciliation', atgard: 'Importera' },
  unmatch_transaction: { rutt: '/reconciliation', atgard: 'Häv matchning' },

  // ── Bokföring ─────────────────────────────────────────────────────────────
  close_period: { rutt: '/accounting', atgard: 'Stäng period' },

  // ── Påminnelser och inkasso ───────────────────────────────────────────────
  pause_reminders: { rutt: '/collections', atgard: 'Pausa' },
  resume_reminders: { rutt: '/collections', atgard: 'Återuppta' },
  export_for_collection: { rutt: '/collections', atgard: 'Exportera' },

  // ══ SAKNAR MÄNSKLIG VÄG — sju FYND, mätta 2026-09-04 ═════════════════════
  //
  // Ordningen är efter hur långt bort vägen är: först de som saknar BÅDE
  // endpoint och yta, sedan de som har en endpoint men ingen yta. Skälet per
  // verktyg står i `apps/api/scripts/tool-human-path.baseline.json` — här bara
  // markören, så att katalogen kan fälla stängt utan att bära en andra kopia av
  // prosan.

  create_journal_entry: { saknas: true },
  record_expense: { saknas: true },
  send_document_to_tenant: { saknas: true },
  update_tenant: { saknas: true },
  send_overdue_reminders: { saknas: true },
  mark_sent_to_collection: { saknas: true },
  prepare_contract_signing: { saknas: true },
}

export interface HumanPathPost {
  name: string
  deklaration: HumanPathDeklaration
}

/**
 * Bygger katalogen ur `ACTION_TOOLS`. KASTAR vid ett verktyg utan post — samma
 * fail-closed-hållning som `buildToolCatalog()` och `buildEffectCatalog()`, och
 * av samma skäl: ett nytt verktyg utan ställningstagande ska stoppa bygget, inte
 * tyst räknas som "har nog en väg".
 */
export function buildHumanPathCatalog(): HumanPathPost[] {
  return [...ACTION_TOOLS].map((name) => {
    const deklaration = HUMAN_PATHS[name]
    if (!deklaration) {
      throw new Error(
        `Verktyget "${name}" saknar humanPath i HUMAN_PATHS ` +
          `(apps/api/src/ai/tools/human-path.ts). Deklarera vägen en människa går ` +
          `för samma sak — eller, om ingen finns, { saknas: true } här OCH en post ` +
          `med skäl i apps/api/scripts/tool-human-path.baseline.json. ` +
          `Hitta INTE på en rutt: ett verktyg utan mänsklig väg är ett fynd enligt ` +
          `Regel 2, och en påhittad väg gör vakten grön och regeln osann.`,
      )
    }
    return { name, deklaration }
  })
}

/** De verktyg som i dag saknar mänsklig väg. Ratchetens mängd — får bara krympa. */
export function verktygUtanMansligVag(): string[] {
  return buildHumanPathCatalog()
    .filter((p) => arSaknad(p.deklaration))
    .map((p) => p.name)
    .sort()
}
