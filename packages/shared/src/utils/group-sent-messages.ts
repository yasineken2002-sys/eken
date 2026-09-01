/**
 * GRUPPERAR PER-MOTTAGARRADER TILL UTSKICK.
 *
 * ── TVÅ ENHETER, OCH BÅDA ÄR RÄTT ──────────────────────────────────────────
 *
 * Enheten i DATAN är mottagaren. Det är enda sättet att kunna svara på "fick
 * DEN HÄR hyresgästen sitt brev?" efter en krasch mitt i en loop, och det är
 * därför `SentMessage` numera skrivs en rad per mottagare.
 *
 * Enheten i OPERATÖRENS VY är utskicket. Fyrtio rader där det stod en är en
 * försämring av en vy som fungerade, och en spårbarhetsvinst får inte betalas
 * med en sämre vy.
 *
 * `batchId` gör att man slipper välja. Den här funktionen är hela översättningen
 * mellan de två, och den är REN — inget UI, inga sidoeffekter — just för att den
 * ska gå att pröva.
 *
 * ── VAD DEN INTE GÖR ────────────────────────────────────────────────────────
 *
 * Den DÖLJER ingenting. Varje grupp bär sina rader i `messages`, och en grupp
 * med en enda rad är strukturellt identisk med en ogrupperad rad. Vyn fäller ut
 * detaljerna; funktionen kastar aldrig bort dem.
 *
 * Rader utan `batchId` — allt som skrevs före fältet fanns — får varsin egen
 * grupp. Det är det ärliga läget: de VET inte vilket utskick de tillhörde, och
 * en gissad gruppering vore sämre än ingen.
 */

/** Det minsta en rad behöver bära för att kunna grupperas. Avsiktligt smalt. */
export interface GroupableMessage {
  id: string
  batchId?: string | null
  subject: string
  status: 'SENT' | 'FAILED' | 'PARTIAL' | 'PENDING'
  createdAt: string | Date
  recipientCount: number
  successCount: number
  failedCount: number
}

export interface SentMessageGroup<T extends GroupableMessage> {
  /** `batchId` när gruppen är ett utskick, annars radens eget id. */
  key: string
  /** Sant bara när gruppen faktiskt är flera rader från samma utskick. */
  isBatch: boolean
  subject: string
  /** Nyaste raden i gruppen — gruppens tidsstämpel i listan. */
  createdAt: string | Date
  recipientCount: number
  successCount: number
  failedCount: number
  /** Sammanvägt tillstånd. Se `aggregateStatus`. */
  status: GroupableMessage['status']
  /** Raderna, nyast först. ALLTID med — gruppen är en vy, inte en ersättning. */
  messages: T[]
}

/**
 * Gruppens tillstånd, härlett ur radernas.
 *
 * ORDNINGEN ÄR INTE GODTYCKLIG. `PENDING` vinner över allt annat: en grupp där
 * någon rad är påbörjad-men-obekräftad är inte avslutad, och att visa den som
 * "Skickat" hade dolt exakt det fall en människa behöver titta på. Därefter
 * gäller det vanliga: allt lyckat → SENT, allt misslyckat → FAILED, blandat →
 * PARTIAL.
 */
export function aggregateStatus(
  statuses: ReadonlyArray<GroupableMessage['status']>,
): GroupableMessage['status'] {
  if (statuses.length === 0) return 'PENDING'
  if (statuses.some((s) => s === 'PENDING')) return 'PENDING'
  if (statuses.every((s) => s === 'SENT')) return 'SENT'
  if (statuses.every((s) => s === 'FAILED')) return 'FAILED'
  return 'PARTIAL'
}

/**
 * Grupperar en lista (nyast först) utan att ändra dess ordning.
 *
 * Grupperna kommer i samma ordning som sin FÖRSTA rad, så en lista sorterad
 * fallande på tid ger grupper sorterade fallande på sin nyaste rad — utan att
 * funktionen behöver sortera om något, och därmed utan att den kan råka ändra
 * en ordning anroparen valt.
 */
export function groupSentMessages<T extends GroupableMessage>(
  messages: readonly T[],
): SentMessageGroup<T>[] {
  const grupper: SentMessageGroup<T>[] = []
  const index = new Map<string, SentMessageGroup<T>>()

  for (const m of messages) {
    // Tom sträng räknas som saknad — ett falsy batchId ska aldrig kunna slå
    // ihop obesläktade rader till en jättegrupp.
    const batch = m.batchId ? m.batchId : null
    const key = batch ?? `single:${m.id}`

    const befintlig = batch ? index.get(key) : undefined
    if (befintlig) {
      befintlig.messages.push(m)
      continue
    }

    const grupp: SentMessageGroup<T> = {
      key,
      isBatch: false,
      subject: m.subject,
      createdAt: m.createdAt,
      recipientCount: 0,
      successCount: 0,
      failedCount: 0,
      status: 'PENDING',
      messages: [m],
    }
    grupper.push(grupp)
    if (batch) index.set(key, grupp)
  }

  for (const g of grupper) {
    g.isBatch = g.messages.length > 1
    g.recipientCount = g.messages.reduce((n, m) => n + m.recipientCount, 0)
    g.successCount = g.messages.reduce((n, m) => n + m.successCount, 0)
    g.failedCount = g.messages.reduce((n, m) => n + m.failedCount, 0)
    g.status = aggregateStatus(g.messages.map((m) => m.status))
  }

  return grupper
}
