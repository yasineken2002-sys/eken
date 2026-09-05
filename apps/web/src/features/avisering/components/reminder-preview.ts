/**
 * FÖRHANDSBESKEDET FÖR "SKICKA PÅMINNELSER NU" — rena funktioner.
 *
 * Vitest renderar ingenting (`environment: 'node'`), så knappens villkor och
 * bekräftelsens texter måste bo utanför komponenten för att gå att pröva.
 *
 * ── EN SPÄRR SKA SÄGA VARFÖR ────────────────────────────────────────────────
 *
 * `spärrskäl` returnerar antingen null eller en mening som säger vad som saknas.
 * En knapp som bara är grå tvingar hyresvärden att gissa: är det inget att
 * skicka, saknas behörighet, eller är något trasigt? De tre kräver olika
 * åtgärder, och det är billigt att skilja dem åt.
 *
 * ── SERVERN ÄR AUKTORITETEN ─────────────────────────────────────────────────
 *
 * Färskhetsgrinden verkställs i `NotificationsController` med 409. Det här är
 * gränssnittets besked, inte spärren: en klient som går runt knappen möts av
 * samma regel med samma skäl.
 */

export interface Farskhet {
  stale: boolean
  /** t.o.m.-datum för känd komplett betalningsdata. null = ingen data alls. */
  through: string | null
  /** Hela dygn sedan `through`. Kan vara Infinity — serialiseras som null. */
  ageDays: number | null
  thresholdDays: number
}

export interface PaminnelseForhandsbesked {
  invoices: Array<{
    id: string
    invoiceNumber: string
    recipient: string
    outstanding: number
    dueDate: string
  }>
  count: number
  totalOutstanding: number
  freshness: Farskhet
}

/**
 * Varför går det inte att skicka just nu? `null` = det går.
 *
 * ORDNINGEN ÄR INTE GODTYCKLIG. Färskheten kommer först därför att den är den
 * enda som säger något om RISK: att skicka krav på inaktuell betalningsdata kan
 * nå någon som redan betalat. "Inget att skicka" är bara en tomhet.
 */
export function spärrskäl(besked: PaminnelseForhandsbesked | undefined): string | null {
  if (!besked) return 'Hämtar underlaget…'

  if (besked.freshness.stale) {
    const sedan =
      besked.freshness.ageDays === null
        ? 'ingen betalningsdata är importerad'
        : `senaste kompletta datum är ${besked.freshness.through} (${besked.freshness.ageDays} dygn sedan)`
    return (
      `Betalningsdatan är inaktuell — ${sedan}, gränsen är ${besked.freshness.thresholdDays} dygn. ` +
      'Importera en färskare bankfil först, annars kan påminnelser gå till hyresgäster som redan betalat.'
    )
  }

  if (besked.count === 0) {
    return 'Ingen förfallen faktura väntar på påminnelse just nu.'
  }

  return null
}

/**
 * Texten i bekräftelsen. Antalet är ett TAK, och det ska stå: dedupen sker per
 * faktura på servern (en påminnelse per faktura och dag), så några av raderna
 * kan hoppas över för att de redan fått sitt brev i dag.
 */
export function bekräftelsetext(besked: PaminnelseForhandsbesked): string {
  const n = besked.count
  return (
    `Upp till ${n} påminnelse${n === 1 ? '' : 'r'} skickas med e-post. ` +
    'Fakturor som redan påmindes i dag hoppas över.'
  )
}
