/**
 * VILKEN VERSION SOM GÄLLER — HÄRLETT, ALDRIG LAGRAT.
 *
 * ── VARFÖR INTE EN FLAGGA ───────────────────────────────────────────────────
 *
 * Det frestande vore ett `isCurrent`-fält på raden. Det hade varit fel av
 * samma skäl som `signedAt` en gång band ingenting: en flagga är ett PÅSTÅENDE
 * som måste hållas i takt med verkligheten av varje skrivväg, och den vägen som
 * glömmer det gör inte fel — den gör ett protokoll gällande som inte är det.
 *
 * Gällande version härleds därför ur kedjans faktiska tillstånd vid varje
 * läsning. Blir härledningen fel syns det i alla vyer samtidigt; en glömd flagga
 * syns i en.
 *
 * ── REGELN ──────────────────────────────────────────────────────────────────
 *
 * Gällande är den HÖGSTA versionen som är SLUTFÖRD. En rättelse under arbete är
 * ett utkast och gäller inte — det gamla publicerade protokollet fortsätter att
 * vara det som gäller tills ersättaren slutförts. Det är hela poängen med att
 * dela upp rättelsen i två steg: ett halvfärdigt protokoll får aldrig ersätta
 * ett färdigt.
 *
 * ── VAD "SLUTFÖRD" BETYDER, OCH VARFÖR DEN ÄR BRED ─────────────────────────
 *
 * `COMPLETED` ELLER `SIGNED` ELLER `signedAt != null`. Tre villkor för ett
 * begrepp ser ut som slarv och är motsatsen: `status` är vad produkten VISAR,
 * `signedAt` är vad som PÅSTÅR att någon skrivit under, och de kan gå isär i
 * rader som skrevs innan F025:s spärr fanns. Samma bredd som
 * `lockAndAssertUnsigned` redan använder åt andra hållet — den som är signerad
 * enligt endera uppgiften är signerad.
 *
 * `COMPLETED` räknas med därför att ett slutfört men osignerat protokoll är
 * publicerat i produktens mening: det är vad förvaltaren ser, vad PDF:en visar
 * och vad ett depositionsavdrag läses av. Att bara räkna `SIGNED` hade gjort
 * varje sådant protokoll evigt icke-gällande, och därmed gjort kedjan stum för
 * just de organisationer som aldrig signerar.
 *
 * ── VAD DEN HÄR FILEN INTE VET ──────────────────────────────────────────────
 *
 * Ingenting om behörighet, ingenting om organisationer och ingenting om
 * databasen. Den får en redan hämtad och redan org-scopad kedja och ordnar den.
 * Hämtningen och spärren ligger i tjänsten, där låset finns.
 */

/** Minsta form `ordnaKedja` läser. Avsiktligt smalare än Prisma-raden. */
export type VersionsRad = {
  id: string
  version: number
  status: string
  signedAt: Date | null
  completedAt: Date | null
  correctionOfId: string | null
  correctionReason: string | null
  correctedById: string | null
  correctedAt: Date | null
  createdAt: Date
}

export type VersionsLank<T extends VersionsRad> = T & {
  /** Sann för exakt en rad i kedjan — eller för ingen, om inget är slutfört. */
  arGallande: boolean
  /** Sann för rader som ännu inte slutförts, alltså rättelser under arbete. */
  arUtkast: boolean
}

/**
 * Slutförd i den mening som gör ett protokoll publicerat. Se filhuvudet för
 * varför tre villkor prövas och inte ett.
 */
export function arSlutford(rad: Pick<VersionsRad, 'status' | 'signedAt'>): boolean {
  return rad.status === 'COMPLETED' || rad.status === 'SIGNED' || rad.signedAt !== null
}

/**
 * Ordnar kedjan i versionsordning och märker ut gällande version och utkast.
 *
 * Sorteringen sker på `version` och inte på `createdAt`: tidsstämplar med
 * millisekundsupplösning kan kollidera, versionsnumret kan inte.
 */
export function ordnaKedja<T extends VersionsRad>(kedja: T[]): VersionsLank<T>[] {
  const sorterad = [...kedja].sort((a, b) => a.version - b.version)

  let gallandeId: string | null = null
  for (const rad of sorterad) {
    if (arSlutford(rad)) gallandeId = rad.id
  }

  return sorterad.map((rad) => ({
    ...rad,
    arGallande: rad.id === gallandeId,
    arUtkast: !arSlutford(rad),
  }))
}

/**
 * Den gällande versionen, eller null om ingen version i kedjan är slutförd.
 *
 * Null är ett verkligt utfall och inte ett fel: en besiktning som är `SCHEDULED`
 * har ingen gällande version, och den som frågar ska få veta det i stället för
 * att få den första raden som tröstpris.
 */
export function gallandeVersion<T extends VersionsRad>(kedja: T[]): VersionsLank<T> | null {
  return ordnaKedja(kedja).find((rad) => rad.arGallande) ?? null
}
