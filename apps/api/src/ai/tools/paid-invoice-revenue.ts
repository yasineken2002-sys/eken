import { SWEDISH_TIME_ZONE, startOfSwedishDay, swedishDateKey } from '@eken/shared'

/**
 * BETALDA FAKTUROR TOTAL — det mått `get_revenue_report`, `compare_revenue` och
 * `get_dashboard_stats.totalPaidRevenue` faktiskt räknar.
 *
 * Verktygen heter "revenue" av historiska skäl och namnen behålls för
 * kompatibilitet. Men måttet är INTE bokförd intäkt (Σ 3xxx i huvudboken) och
 * inte företagets fulla intäkt: hyra som debiteras med hyresavi finns i
 * `RentNotice`, inte i `Invoice`, och syns därför inte här alls. För en
 * hyresvärd vars hyra går via avi kan måttet vara nära noll medan hyran flyter
 * in. Metadata och svarstext säger därför ut vad som räknas — modellen ska inte
 * behöva gissa det ur ett verktygsnamn.
 *
 * Innehållet är inventerat ur koden, inte önskat:
 *  - `Invoice.total` (inkl. moms) för `status = PAID`, alla fakturatyper —
 *    även DEPOSIT, som bokföringsmässigt är en skuld (2890), inte en intäkt.
 *  - Hela beloppet räknas på `paidAt`, dagen fakturan fick status Betald. På
 *    betalningsvägarna är det dagen betalningen fullbordade fakturan
 *    (invoices.service, reconciliation.service), även om delbetalningar skett
 *    tidigare; vid manuell statusändring är det tidpunkten för ändringen
 *    (invoices.service transitionStatus sätter paidAt = nu).
 *  - Status Betald kan sättas manuellt utan bankunderlag, så måttet bevisar
 *    INTE att pengarna kommit in på banken.
 *  - Kreditnotor är egna Invoice-rader; måttet gör inget avdrag för dem.
 */
export const PAID_INVOICE_TOTAL_MEASURE = {
  id: 'PAID_INVOICE_TOTAL',
  name: 'Betalda fakturors total',
  definition:
    'Summan av fakturabeloppet (inkl. moms) för fakturor med status Betald, räknad på den dag fakturan fick status Betald (svensk kalenderdag). Status Betald kan sättas manuellt, så summan är inte verifierad bankinbetalning.',
  includes: [
    'Fakturor (Invoice) med status Betald, alla typer — även depositionsfakturor',
    'Hela fakturabeloppet inkl. moms, på dagen fakturan fick status Betald',
  ],
  excludes: [
    'Hyresavier och delbetalningar på hyresavier',
    'Bokförd intäkt i huvudboken (Σ konto 3xxx)',
    'Obetalda, delbetalda, förfallna och inkassoöverlämnade fakturor',
    'Avdrag för kreditnotor',
    'Verifierad bankinbetalning — status Betald kan sättas manuellt utan bankunderlag',
  ],
} as const

/** En mening för `message` — samma begränsning som i `excludes`, i klartext. */
export const PAID_INVOICE_TOTAL_CAVEAT =
  'Omfattar inte hyresavier eller deras delbetalningar, är inte bokförd intäkt eller företagets fulla intäkt, och bevisar inte att pengarna kommit in på banken (status Betald kan sättas manuellt).'

export interface SwedishDatePeriod {
  from: string
  to: string
  timeZone: typeof SWEDISH_TIME_ZONE
  inclusive: true
  /** Svensk midnatt som inleder `from`. */
  fromInstant: string
  /** Svensk midnatt som inleder dagen EFTER `to` — exklusiv gräns. */
  toExclusiveInstant: string
}

export type PeriodTolkning =
  | { ok: true; period: SwedishDatePeriod; where: { gte: Date; lt: Date } }
  | { ok: false; message: string }

const DATUM = /^(\d{4})-(\d{2})-(\d{2})$/

/** Kalenderdagens UTC-middag — ligger alltid inne i samma svenska dag (UTC+1/+2). */
function middag(text: string): Date | null {
  const m = DATUM.exec(text)
  if (!m) return null
  const [år, mån, dag] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const d = new Date(Date.UTC(år, mån - 1, dag, 12))
  // Rundtur: 2026-02-30 blir 2026-03-02 och ska avvisas, inte tolkas om.
  if (d.getUTCFullYear() !== år || d.getUTCMonth() !== mån - 1 || d.getUTCDate() !== dag) {
    return null
  }
  return d
}

/**
 * `from`–`to` som HELA svenska kalenderdagar, båda inkluderade, uttryckt som
 * ett halvöppet ögonblicksfönster `[svensk midnatt from, svensk midnatt dagen
 * efter to)`. Midnatten räknas av den befintliga `startOfSwedishDay`, så
 * sommar- och vintertidsdygn (23 resp. 25 timmar) blir hela dagar utan egen
 * zonlogik här. Allt som inte är ett verkligt YYYY-MM-DD, eller en omvänd
 * period, avvisas med en förklaring — utan databasfråga.
 */
export function tolkaSvenskPeriod(
  fromIn: unknown,
  toIn: unknown,
  etikett: { from: string; to: string } = { from: 'from', to: 'to' },
): PeriodTolkning {
  const from = typeof fromIn === 'string' ? fromIn.trim() : ''
  const to = typeof toIn === 'string' ? toIn.trim() : ''
  const fromDag = middag(from)
  const toDag = middag(to)
  if (!fromDag || !toDag) {
    const fel = [!fromDag && `${etikett.from}="${from}"`, !toDag && `${etikett.to}="${to}"`]
      .filter(Boolean)
      .join(', ')
    return {
      ok: false,
      message: `Ogiltigt datum (${fel}). Ange hela kalenderdagar som YYYY-MM-DD, t.ex. 2026-08-01 och 2026-08-31 — båda dagarna räknas med.`,
    }
  }
  if (fromDag.getTime() > toDag.getTime()) {
    return {
      ok: false,
      message: `Ogiltig period: ${etikett.from} (${from}) ligger efter ${etikett.to} (${to}). Ange första dagen före eller lika med sista dagen.`,
    }
  }
  const gte = startOfSwedishDay(fromDag)
  const lt = startOfSwedishDay(new Date(toDag.getTime() + 86_400_000))
  return {
    ok: true,
    period: {
      from,
      to,
      timeZone: SWEDISH_TIME_ZONE,
      inclusive: true,
      fromInstant: gte.toISOString(),
      toExclusiveInstant: lt.toISOString(),
    },
    where: { gte, lt },
  }
}

/** Månadsnyckel YYYY-MM efter SVENSKT datum — samma kalender som fönstret. */
export function svenskMånad(instant: Date): string {
  return swedishDateKey(instant).slice(0, 7)
}
