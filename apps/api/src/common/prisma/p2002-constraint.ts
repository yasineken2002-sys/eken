import { Prisma } from '@prisma/client'

/**
 * Identifierar ETT unikt index, så att en P2002 kan bindas till just det.
 *
 * `column` måste vara ENTYDIG bland tabellens övriga unika index — det är den
 * som skiljer "rätt" constraint från alla andra. Väljs en kolumn som finns i två
 * index blir predikatet tvetydigt utan att sluta vara grönt.
 */
export interface UniqueConstraintId {
  /** Kolumn som entydigt identifierar constrainten bland tabellens unika index. */
  column: string
  /** Indexnamnet i Postgres — bara för den defensiva sträng-grenen. */
  indexName: string
}

/**
 * Kom den här P2002:an från EN BESTÄMD constraint?
 *
 * ── VARFÖR DET ÄR EN EGEN FRÅGA ──────────────────────────────────────────────
 *
 * `err.code === 'P2002'` säger bara att NÅGON unikhet bröts. Att behandla det
 * som "raden fanns redan" är rätt för den ena constrainten och katastrofalt för
 * den andra. Aviseringens aktiveringsväg gjorde precis det: den fångade varje
 * P2002 som benign idempotens, så en kollision på `noticeNumber` maskerades som
 * "någon annan hann skapa avin", `findFirst` gav null, och hyresgästen fick
 * aldrig sin första avi — utan fel, utan logg.
 *
 * Maskineriet fanns redan på två andra ställen med var sin kopia
 * (`platform-invoices.service.ts`, `leases.service.ts`). Tre kopior av
 * "vilket P2002 är benignt" är hur felklassen sprider sig — så den bor här nu.
 * Bara constraintens IDENTITET skiljer anroparna åt; logiken gör det inte.
 *
 * ── FORMEN PÅ err.meta.target ────────────────────────────────────────────────
 *
 * EMPIRISKT verifierad mot dev-Postgres (Prisma 5.19): target rapporteras som en
 * KOLUMN-ARRAY. Sträng-grenen (indexnamn) behålls som defensiv fallback ifall
 * Prisma eller drivern skulle byta form — den formen är observerad i
 * `leases.service.ts`.
 *
 * ── FAIL-CLOSED ──────────────────────────────────────────────────────────────
 *
 * Okänd eller saknad target ⇒ `false` ⇒ INTE den här constrainten. Det betyder
 * att anroparen låter felet gå vidare i stället för att tysta det. Hellre ett
 * larm än en tyst försvunnen rad — defaulten är det som gör hjälparen säker att
 * använda för idempotens-grenar.
 */
export function isP2002From(err: unknown, constraint: UniqueConstraintId): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (err.code !== 'P2002') return false

  const target = (err.meta as { target?: unknown } | undefined)?.target
  if (Array.isArray(target)) return target.includes(constraint.column)
  if (typeof target === 'string') return target.includes(constraint.indexName)
  return false
}
