import { Prisma } from '@prisma/client'

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `AVI-{år}-{mm}-{NNNN}`. Formatet är oförändrat — bara allokeringen är ny. */
export function formatNoticeNumber(year: number, month: number, seq: number): string {
  return `AVI-${year}-${pad2(month)}-${String(seq).padStart(4, '0')}`
}

/**
 * Allokerar nästa avinummer atomiskt.
 *
 * ── VAD DEN ERSÄTTER ─────────────────────────────────────────────────────────
 *
 * Tidigare: `findMany` på alla avinummer med rätt prefix, parsa suffixen, ta
 * max, lägg på ett (plus en `offset`-parameter). Två överlappande genereringar
 * läste samma committade max och fick SAMMA nummer. Mätt med riktiga
 * överlappande anrop, inte resonerat:
 *
 *     två samtidiga anrop, samma max → båda fick AVI-2026-06-0002
 *
 * Kollisionen slog sedan i `@@unique([organizationId, noticeNumber])`. Fram till
 * #484 maskerades den dessutom som benign idempotens på aktiveringsvägen, så en
 * hyresgäst kunde bli aktiverad utan sin första avi — utan fel, utan logg.
 *
 * `offset`-parametern är borta med samma ändring. Den var en rest från när hela
 * månadsloopen låg i EN transaktion (ocommittade rader osynliga → max stod
 * still). Efter refaktoreringen till transaktion-per-lease dubbelräknade den:
 * en sekventiell körning gav 0001, 0003, 0006, 0010 i stället för 0001–0004.
 *
 * ── VARFÖR UPSERT MED INCREMENT ──────────────────────────────────────────────
 *
 * `update: { lastNumber: { increment: 1 } }` utförs av Postgres som en atomär
 * läs-och-skriv under ett RADLÅS på scope-raden. Två samtidiga allokeringar
 * inom samma (org, år, månad) serialiseras därför av databasen — den andra
 * väntar på den första och ser dess värde. Ingen läser ett inaktuellt max.
 *
 * ⚠️ RADLÅSET ÄR AVSIKTEN, INTE EN BIEFFEKT. Anropet MÅSTE ligga i SAMMA
 * transaktion som avi-inserten. Bryts det isär — "optimeras" allokeringen ut ur
 * transaktionen för att korta låstiden — försvinner serialiseringen mellan
 * allokering och insert, och kollisionen är tillbaka i en ny form. Samma
 * konstruktion som `VerifikationsnummerService.allocate`.
 *
 * ── GAP: MÄTT, INTE ANTAGET ──────────────────────────────────────────────────
 *
 * Den gamla funktionens docblock sa att numreringen tål gaps, och det gäller
 * fortfarande — inget i systemet kräver en sammanhängande serie.
 *
 * Men den närliggande gissningen är FEL, och jag skrev först ner den här:
 * "en rollback efter allokeringen förbrukar numret". Bevisriggen mot riktig
 * Postgres visade motsatsen. Eftersom upserten ligger i SAMMA transaktion som
 * avi-inserten rullas ökningen tillbaka med den:
 *
 *     allokera 0001 → kasta → rulla tillbaka → nästa allokering ger 0001
 *     två samtidiga, en rullas tillbaka        → nästa ger 0002
 *
 * Sekvensen läcker alltså inga nummer. Det är en följd av att allokeringen
 * ligger inne i transaktionen — samma egenskap som ger serialiseringen.
 *
 * PRISET för det: radlåset hålls under HELA avi-transaktionen, inklusive
 * bokföringsskrivningen. Samtidig generering inom (org, år, månad) serialiseras
 * därför på riktigt i stället för att köra parallellt. Det är avsikten här —
 * månadscronen är ändå sekventiell — men det är en genomströmningsegenskap
 * någon bör känna till innan avigenereringen parallelliseras.
 *
 * (Verifikationsnummer har ett HÅRDARE krav — gap-fria enligt BFL — och löser
 * det med samma mekanik. Avinumret är ingen räkenskapsserie, så kravet här är
 * bara unikhet.)
 */
export async function allocateRentNoticeNumber(
  client: Prisma.TransactionClient,
  organizationId: string,
  year: number,
  month: number,
): Promise<string> {
  const row = await client.rentNoticeNumberSequence.upsert({
    where: { organizationId_year_month: { organizationId, year, month } },
    create: { organizationId, year, month, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  })
  return formatNoticeNumber(year, month, row.lastNumber)
}
