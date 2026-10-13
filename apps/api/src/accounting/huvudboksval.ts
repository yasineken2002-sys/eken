/**
 * HUVUDBOK-STEG1 (154): ORGANISATIONENS HUVUDBOK STYR VILKA FRIA BOKFÖRINGSHANDLINGAR SOM FÅR SKE I EVENO.
 *
 * `Organization.ledgerOwner` är ett beständigt val, skilt från Fortnox-anslutningens status och
 * från kundaktiveringens status. EVENO (standard, alla befintliga organisationer) = allt som förut.
 * FORTNOX = Fortnox är huvudbok; Eveno nekar de FRIA, konkurrerande huvudbokshandlingarna nedan.
 *
 * ── VAD SOM NEKAS, OCH VAD SOM INTE GÖR DET ─────────────────────────────────
 *
 * Nekas: fritt verifikat, fristående utgift, leverantörsbokföring, generell rättelse
 * (`reverseJournalEntry`) och årsbokslut. Inte nekat: verifikatmotorn som sådan
 * (`createNumberedEntry`) — avier, betalningar, depositioner och deras KÄLLBUNDNA rättelser går
 * genom den och ska fortsätta fungera. Inte heller månadsstängningen: den skapar inget verifikat
 * och är Evenos operativa periodspärr för de egna händelserna (KONTRAKT-154 BP-1).
 *
 * ── VARFÖR I TRANSAKTIONEN, MED LÅS ─────────────────────────────────────────
 *
 * Valet skrivs under `FOR UPDATE` på organisationsraden (samma lås som kundaktiveringen tar).
 * Kontrollen här läser värdet med `FOR SHARE` som FÖRSTA sats i skrivningens egen transaktion.
 * Ordningen blir då deterministisk: kom skrivningen först väntar valet tills den committat;
 * kom valet först väntar skrivningen och läser det committade FORTNOX. En kontroll FÖRE
 * transaktionen (middleware, controller) hade lämnat ett fönster mellan beslut och skrivning.
 * Två samtidiga skrivningar tar båda FOR SHARE och blockerar inte varandra.
 */
import { ConflictException, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

export type LokalHuvudbokshandling =
  | 'FRITT_VERIFIKAT'
  | 'UTGIFT'
  | 'LEVERANTORSFAKTURA'
  | 'RATTELSE_GENERELL'
  | 'ARSBOKSLUT'

export const EXTERN_HUVUDBOK = 'EXTERN_HUVUDBOK'

const HANDLINGSTEXT: Record<LokalHuvudbokshandling, string> = {
  FRITT_VERIFIKAT: 'Fria verifikat',
  UTGIFT: 'Utgifter',
  LEVERANTORSFAKTURA: 'Leverantörsfakturor',
  RATTELSE_GENERELL: 'Rättelser av verifikat',
  ARSBOKSLUT: 'Årsbokslut',
}

/** Samma text i HTTP, AI och webb — den enda källan. */
export function externHuvudbokSkal(handling: LokalHuvudbokshandling): string {
  return (
    `Organisationen har Fortnox som huvudbok. ${HANDLINGSTEXT[handling]} bokförs i Fortnox, ` +
    'inte i Eveno. Avier, betalningar och depositioner hanteras som vanligt i Eveno. Ingenting ändrades.'
  )
}

/** Läsvy för webben: samma regel och samma text som skrivvägarna. */
export async function lasHuvudboksval(db: Prisma.TransactionClient, organizationId: string) {
  const o = await db.organization.findUnique({
    where: { id: organizationId },
    select: { ledgerOwner: true, ledgerOwnerSetAt: true, ledgerOwnerFortnoxDatabaseNumber: true },
  })
  if (!o) throw new NotFoundException('Organisationen hittades inte')
  const fortnox = o.ledgerOwner === 'FORTNOX'
  return {
    agare: o.ledgerOwner,
    valdAt: o.ledgerOwnerSetAt,
    fortnoxDatabasnummer: o.ledgerOwnerFortnoxDatabaseNumber,
    skal: fortnox
      ? 'Organisationen har Fortnox som huvudbok. Fria verifikat, utgifter, leverantörsfakturor, ' +
        'rättelser av verifikat och årsbokslut görs i Fortnox, inte i Eveno. Avier, betalningar och ' +
        'depositioner hanteras som vanligt i Eveno.'
      : null,
  }
}

/**
 * Kastar 409 EXTERN_HUVUDBOK om organisationens huvudbok är Fortnox. MÅSTE anropas med
 * skrivningens egen transaktionsklient, före första skrivande sats.
 */
export async function assertLokalHuvudbokTillaten(
  tx: Prisma.TransactionClient,
  organizationId: string,
  handling: LokalHuvudbokshandling,
): Promise<void> {
  const rader = await tx.$queryRaw<Array<{ ledgerOwner: string }>>`
    SELECT "ledgerOwner"::text AS "ledgerOwner" FROM "Organization" WHERE id = ${organizationId} FOR SHARE`
  if (rader.length === 0) throw new NotFoundException('Organisationen hittades inte')
  if (rader[0]!.ledgerOwner !== 'EVENO') {
    throw new ConflictException({ code: EXTERN_HUVUDBOK, message: externHuvudbokSkal(handling) })
  }
}
