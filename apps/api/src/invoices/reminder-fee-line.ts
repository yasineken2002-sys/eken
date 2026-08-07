/**
 * Påminnelseavgiftens rad på fakturadokumentet — EN sträng, två ägare.
 *
 * `InvoiceLine` har ingen typ-, kind- eller källkolumn (se `schema.prisma`): en rad
 * är `description` + belopp och ingenting annat. Avgiftsraden går därför bara att
 * känna igen på sin text, och den texten skrivs på ett ställe
 * (`PaymentReminderService`) och läses på ett annat (`InvoicesService`, VOID-grenen
 * som plockar bort raden igen).
 *
 * Vore literalen duplicerad på båda ställena skulle en framtida omformulering —
 * ett tillagt kolon, en ändrad SFS-hänvisning — göra borttagningen till en tyst
 * no-op: fakturan skulle behålla en avgiftsrad vars verifikat är reverserat, och
 * dokumentet skulle kräva en avgift huvudboken inte längre bär. Det är precis den
 * divergens mellan reskontra och huvudbok som #357 stängde i andra riktningen.
 *
 * Konstanten är alltså inte en bekvämlighet utan kopplingen som håller de två
 * sidorna ihop. Ändras texten ändras båda samtidigt, eller ingen.
 *
 * ⚠️ ÄNDRAS TEXTEN GÄLLER DEN BARA FRAMÅT. Rader som redan skrivits bär den gamla
 * strängen och matchas inte längre. Det finns inga sådana rader i produktion i dag
 * (noll fakturor), men en textändring efter lansering kräver en migrering av
 * befintliga rader — inte bara en ny literal här.
 */
export const REMINDER_FEE_LINE_DESCRIPTION = 'Påminnelseavgift enligt 4 § lagen (1981:739)'
