import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * REGELN: en förhoppning får aldrig vinna över en identitet.
 *
 * ── VAD SOM SKILJER FÄLTEN ÅT ────────────────────────────────────────────────
 *
 * Bankavstämningens OCR-gren slår upp samma `rawOcr` i flera fält, och de fälten
 * är INTE av samma slag:
 *
 *   • Ett SYSTEMTILLDELAT OCR är en IDENTITET. Det delas ut en gång, av en
 *     atomär sekvens, och är unikt inom organisationen (H1, #553). Står numret
 *     där betyder det att just det dokumentet — eller just den hyresgästen — är
 *     mottagaren. Ingen människa väljer värdet.
 *
 *   • `Invoice.reference` är en FÖRHOPPNING. Det är fritext från klienten
 *     (`create-invoice.dto.ts`: `@IsString() @IsOptional()`, ingen formkontroll),
 *     det kan ändras i efterhand via PATCH, det defaultar till fakturans eget OCR
 *     och det renderas som en dekorativ badge på fakturan — betalaren uppmanas
 *     ALDRIG att betala med det (`invoice-pdf.template.ts`: betalningsrutan bär
 *     `ocrNumber`). Att det över huvud taget deltar i OCR-uppslaget är en
 *     bekvämlighet som följde med filens första commit, utan motivering och utan
 *     ett enda test.
 *
 * ── VAD DEN GAMLA ORDNINGEN KOSTADE ──────────────────────────────────────────
 *
 * Uppslagen låg som `Invoice.ocrNumber ?? Invoice.reference` FÖRE avin. Skrevs en
 * hyresavis OCR in som fakturareferens vann alltså fakturan, och hyresbetalningen
 * bokfördes mot fel dokument.
 *
 * Skadan är TYST, och det är det som gör den allvarlig: avins `ocrOutstanding`
 * rörs inte, så `RentDebtService` och `RentReminderService` fortsätter räkna avin
 * som obetald. Kravtrappan går vidare — påminnelse, ränta, inkasso-redo — mot en
 * hyresgäst som faktiskt har betalat. Ingen kontroll fäller, för varje enskilt
 * steg är korrekt givet vad det ser.
 *
 * ── REGELN ───────────────────────────────────────────────────────────────────
 *
 * Matchar `rawOcr` ett systemtilldelat OCR någonstans i organisationen får
 * fritextgrenen INTE konsulteras alls. Fritext får bara komma till tals när
 * ingen identitet gör anspråk på numret.
 *
 * Funktionen är därmed kvar: en hyresvärd som migrerar från Vitec/Momentum kan
 * fortfarande lägga det GAMLA systemets OCR i `reference` så att befintliga
 * autogiromedgivanden matchar — det numret är per definition inget som Evenos
 * sekvenser har delat ut, så identitetsgrinden släpper igenom det.
 *
 * ── VARFÖR ÄVEN Tenant.ocrNumber ─────────────────────────────────────────────
 *
 * `RentNotice.ocrNumber` är en KOPIA av `Tenant.ocrNumber`, satt när avin skapas.
 * Att bara fråga avierna vore att lita på att kopian alltid finns — en hyresgäst
 * kan ha fått sitt OCR utan att ännu ha en enda avi, och då hade numret sett
 * ofördelat ut. Identiteten sitter på hyresgästen; avin bär den bara vidare.
 * (Samma sorts härledning-som-invariant som H1 byggde bort. Fråga källan.)
 *
 * ── STATUS FILTRERAS INTE BORT ───────────────────────────────────────────────
 *
 * Grinden frågar utan statusvillkor, med flit. Ett OCR som en gång tilldelats en
 * faktura eller en hyresgäst tillhör dem för alltid — en betald avi gör inte
 * numret ledigt för någon annans fritextfält. Utfallet när grinden stänger och
 * inget identitetsuppslag träffar är att transaktionen lämnas UNMATCHED, vilket
 * redan betyder "väntar på manuell matchning" (se M2-grenen i matchTransaction).
 * Det är fail-closed: hellre en transaktion en människa får titta på än en
 * betalning som tyst hamnar på fel motpart.
 */

/**
 * Fälten som bär en IDENTITET. Får slås upp mot `rawOcr` utan grind.
 *
 * Listan läses av `check-ocr-lookup-fields.mjs`, som fäller om ett NYTT fält
 * börjar slås upp mot `rawOcr` i reconciliation.service.ts utan att stå här
 * eller i `FREE_TEXT_OCR_FIELDS`. Ett oklassat fält är precis hur `reference`
 * kunde ligga i uppslaget i månader utan att någon tog ställning till det.
 */
export const SYSTEM_ASSIGNED_OCR_FIELDS = [
  'Invoice.ocrNumber',
  'RentNotice.ocrNumber',
  'Tenant.ocrNumber',
] as const

/**
 * Fälten som bär en FÖRHOPPNING. Får bara slås upp mot `rawOcr` bakom
 * identitetsgrinden — aldrig fritt.
 */
export const FREE_TEXT_OCR_FIELDS = ['Invoice.reference'] as const

type OcrReader = PrismaClient | Prisma.TransactionClient

/**
 * Gör `rawOcr` anspråk på att vara en identitet i den här organisationen?
 *
 * `true` ⇒ fritextgrenen är stängd för det här numret.
 *
 * Tre uppslag, kortslutna. Två av dem går på unika index
 * (`Invoice(organizationId, ocrNumber)` sedan #553, `Tenant(organizationId,
 * ocrNumber)` sedan #487). Avi-uppslaget saknar eget index, men det är samma
 * uppslagsmönster som matchTransaction redan gör en rad längre ned — grinden
 * lägger alltså inte till en ny frågeform, bara en till av en befintlig.
 */
export async function harSystemtilldelatOcr(
  db: OcrReader,
  organizationId: string,
  rawOcr: string,
): Promise<boolean> {
  const faktura = await db.invoice.findFirst({
    where: { organizationId, ocrNumber: rawOcr },
    select: { id: true },
  })
  if (faktura) return true

  const avi = await db.rentNotice.findFirst({
    where: { organizationId, ocrNumber: rawOcr },
    select: { id: true },
  })
  if (avi) return true

  const hyresgast = await db.tenant.findFirst({
    where: { organizationId, ocrNumber: rawOcr },
    select: { id: true },
  })
  return hyresgast !== null
}
