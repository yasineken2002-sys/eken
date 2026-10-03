/**
 * KUNDSTART-001 §12.4 (K-B5 / T2-4): vattenmärke över organisationens ekonomiska läge.
 *
 * Godkännandet av ett öppningspaket binds inte bara till filens sha, version och
 * brytdatum utan också till detta märke. Verkställningen räknar om det i SAMMA
 * transaktion (efter FOR UPDATE på organisation och paket, SERIALIZABLE) och avvisar med
 * skäl om något ändrats sedan godkännandet: bankimport, betalning, avmatchning, manuell
 * bokföring, ny eller ändrad avi, deposition, ändrat avtal eller hyresgäst som raderna
 * pekar på, Fortnox-anslutningens bindning, serie, dimensionsval, mappningar eller en ny
 * Fortnox-läsning.
 *
 * Märket är en sha256 över en deterministisk JSON — delarna redovisas också (för skälet).
 * Antal + senaste tid fångar tillägg och ändringar; antal fångar raderingar.
 */
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'

export interface VattenmarkeDelar {
  bank: string
  avier: string
  betalningar: string
  verifikat: string
  depositioner: string
  avtal: string
  hyresgaster: string
  anslutning: string
  mappningar: string
  lasningar: string
}

export async function ekonomisktLage(
  db: Prisma.TransactionClient,
  organizationId: string,
  ref: { leaseIds: string[]; tenantIds: string[] },
): Promise<{ sha256: string; delar: VattenmarkeDelar }> {
  const leaseIds = [...new Set(ref.leaseIds)].sort()
  const tenantIds = [...new Set(ref.tenantIds)].sort()
  const tom = ['00000000-0000-0000-0000-000000000000']
  const rader = await db.$queryRaw<Array<Record<keyof VattenmarkeDelar, string | null>>>(Prisma.sql`
    SELECT
      (SELECT count(*)::text || '|' || coalesce(max("createdAt")::text,'') || '|' ||
              coalesce(max("matchedAt")::text,'') || '|' ||
              coalesce(md5(string_agg(id || ':' || status::text, ',' ORDER BY id)), '')
         FROM "BankTransaction" WHERE "organizationId" = ${organizationId}) AS bank,
      (SELECT count(*)::text || '|' || coalesce(max("updatedAt")::text,'')
         FROM "RentNotice" WHERE "organizationId" = ${organizationId}) AS avier,
      (SELECT count(*)::text || '|' || coalesce(max(p."createdAt")::text,'') || '|' ||
              coalesce(sum(p.amount)::text,'')
         FROM "RentNoticePayment" p JOIN "RentNotice" n ON n.id = p."rentNoticeId"
        WHERE n."organizationId" = ${organizationId}) AS betalningar,
      (SELECT count(*)::text || '|' || coalesce(max("createdAt")::text,'')
         FROM "JournalEntry" WHERE "organizationId" = ${organizationId}) AS verifikat,
      (SELECT count(*)::text || '|' || coalesce(max("updatedAt")::text,'')
         FROM "Deposit" WHERE "organizationId" = ${organizationId}) AS depositioner,
      (SELECT coalesce(string_agg(id || '@' || "updatedAt"::text || '@' || status::text, ',' ORDER BY id), '')
         FROM "Lease" WHERE "organizationId" = ${organizationId}
          AND id IN (${Prisma.join(leaseIds.length ? leaseIds : tom)})) AS avtal,
      (SELECT coalesce(string_agg(id || '@' || "updatedAt"::text, ',' ORDER BY id), '')
         FROM "Tenant" WHERE "organizationId" = ${organizationId}
          AND id IN (${Prisma.join(tenantIds.length ? tenantIds : tom)})) AS hyresgaster,
      (SELECT coalesce(string_agg(
                id || '|' || status::text || '|' || generation::text || '|' ||
                "fortnoxDatabaseNumber"::text || '|' || coalesce("fortnoxOrgNumber",'') || '|' ||
                coalesce("exportVoucherSeries",'') || '|' || coalesce("exportOmitDimensionsAt"::text,'') || '|' ||
                "connectedAt"::text, ',' ORDER BY id), '')
         FROM "FortnoxConnection" WHERE "organizationId" = ${organizationId}) AS anslutning,
      (SELECT count(*)::text || '|' || coalesce(md5(string_agg(
                "dimensionType"::text || ':' || code || ':' || "propertyId", ',' ORDER BY "dimensionType", code)), '')
         FROM "FortnoxDimensionMapping" WHERE "organizationId" = ${organizationId}) AS mappningar,
      (SELECT count(*)::text || '|' || coalesce(max("startedAt")::text,'') || '|' ||
              coalesce(max("completedAt")::text,'')
         FROM "FortnoxReadRun" WHERE "organizationId" = ${organizationId}) AS lasningar
  `)
  const r = rader[0]
  if (!r) throw new Error('Vattenmärket kunde inte läsas')
  const nycklar = Object.keys(r).sort() as (keyof VattenmarkeDelar)[]
  const delar = Object.fromEntries(
    nycklar.map((k) => [k, r[k] ?? '']),
  ) as unknown as VattenmarkeDelar
  const sha256 = createHash('sha256').update(JSON.stringify(delar), 'utf8').digest('hex')
  return { sha256, delar }
}

export const VATTENMARKE_SKAL =
  'Organisationens ekonomiska läge har ändrats sedan paketet godkändes (t.ex. bankimport, ' +
  'betalning, avmatchning, ny avi eller deposition, manuell bokföring, ändrat avtal eller ' +
  'hyresgäst, Fortnox-anslutning, mappning eller ny Fortnox-läsning). Verkställningen ' +
  'avbröts utan effekt; paketet kräver ny validering och nytt godkännande.'
