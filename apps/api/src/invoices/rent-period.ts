import { Prisma } from '@prisma/client'

import { stockholmCivilDate } from '../common/time/stockholm-period'

/**
 * DEN HYRESPERIOD EN FAKTURA GÖR ANSPRÅK PÅ — en definition, ett ställe.
 *
 * Värdet lagras på `Invoice.rentPeriodYear/Month` och bär det partiella unika
 * indexet `invoice_rent_period_unique`. Samma derivering som
 * `assertNoDuplicateInvoice` använder mot `RentNotice`, och det är hela poängen:
 * de två halvorna av dubbelfaktureringsspärren måste vara ense om vilken månad
 * en faktura tillhör.
 *
 * ⚠️ DÄRFÖR ÄR DET INTE EN GENERERAD KOLUMN. `GENERATED ALWAYS AS (EXTRACT(...
 * FROM "issueDate")) STORED` fungerar i Postgres — prövat — och hade tagit bort
 * risken att någon glömmer räkna om värdet. Men en genererad kolumn kan bara
 * härleda ur det som är LAGRAT, och `issueDate` är en `DATE`: tidszonen är redan
 * borta när den skulle räkna.
 *
 * Uppslaget mot `RentNotice` använder med flit svensk civil tid, eftersom avins
 * `month`/`year` är en civil månad som skickas explicit till
 * `generateMonthlyNotices`. För en tidsstämpel mellan 22:00 UTC och midnatt ger
 * de två härledningarna olika månad. Uppmätt:
 *
 *     in 2026-06-01              → civil 06, lagrad DATE-månad 06   (ense)
 *     in 2026-05-31T23:30:00Z    → civil 06, lagrad DATE-månad 05   (OENSE)
 *
 * Och AI-vägen skickar just en tidsstämpel: `issueDate: new Date().toISOString()`.
 *
 * En genererad kolumn hade alltså infört en ANDRA definition av "period" vid
 * sidan av uppslagets, och de hade varit oense ett par timmar om dygnet. Det är
 * ett värre fel än det den skulle ta bort — inte drift, utan två sanningar.
 */
export function rentPeriodFalt(
  type: string | undefined,
  issueDate: string | Date,
):
  | { rentPeriodYear: number; rentPeriodMonth: number }
  | { rentPeriodYear: null; rentPeriodMonth: null } {
  // Bara hyra har en period. En serviceavgift för samma avtal och månad är en
  // annan sak, och ska inte bära ett värde som ser ut att betyda något.
  if (type !== 'RENT') return { rentPeriodYear: null, rentPeriodMonth: null }
  const { year, month } = stockholmCivilDate(new Date(issueDate))
  return { rentPeriodYear: year, rentPeriodMonth: month }
}

/** EN text, oavsett om uppslaget eller indexet råkade träffa först. */
export const DUBBEL_HYRESFAKTURA_TEXT =
  'Hyresavtalet har redan en hyresfaktura för denna period. Ingen ny faktura ' +
  'har skapats. Ska hyran ändras: kreditera den befintliga fakturan i stället ' +
  'för att skapa en till.'

/**
 * Betyder den här P2002:an "det finns redan en hyresfaktura för perioden"?
 *
 * ALDRIG EN BLIND FÅNGST — och avgränsningen räknas om varje gång `Invoice` får
 * ett unikt villkor till. Tabellen har redan två andra
 * (`organizationId, invoiceNumber` och `organizationId, ocrNumber`), och ingen
 * av dem delar kolumn med det här: kravet på alla tre fälten är därför entydigt
 * i dag, men det är ett faktum om dagens schema, inte en evig sanning.
 */
export function ärHyresperiodskonflikt(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false
  const target = (err.meta as { target?: unknown } | undefined)?.target
  if (typeof target === 'string') return target.includes('invoice_rent_period_unique')
  if (!Array.isArray(target)) return false
  const fält = target.map(String)
  return (
    fält.includes('leaseId') && fält.includes('rentPeriodYear') && fält.includes('rentPeriodMonth')
  )
}
