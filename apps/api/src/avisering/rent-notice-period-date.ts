/**
 * Kalkylatorns perioddatum är lokala kalenderdagar (new Date(år, månad, dag)).
 * Prisma skriver @db.Date från UTC-delen: lokal midnatt i Stockholm skulle
 * annars lagras som föregående dag. Bevara de lokala kalenderfälten och skapa
 * UTC-midnatt endast vid skrivgränsen för RentNotice.periodStart/periodEnd.
 *
 * Använd inte för tidpunkter, dueDate eller redan lagrade @db.Date-värden.
 */
export function rentNoticePeriodDate(value: Date): Date {
  return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()))
}
