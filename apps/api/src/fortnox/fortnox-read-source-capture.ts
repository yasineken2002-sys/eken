import { BadRequestException, ConflictException } from '@nestjs/common'
import {
  Prisma,
  type FortnoxReadSourceCapture,
  type FortnoxReadSourceExport,
  type FortnoxReadSourceMapping,
} from '@prisma/client'
import { z } from 'zod'
import {
  canonicalCheckpointInput,
  checkpointDigest,
  type StartCheckpointInput,
} from './fortnox-read-checkpoint-context'

type Tx = Prisma.TransactionClient
type Header = Omit<FortnoxReadSourceCapture, 'input'> & { input: StartCheckpointInput }
type SourcePage<T> = { items: T[]; nextAfterOrdinal: bigint | null }
const PAGE_SIZE = 100
const nonnegative = z.number().int().nonnegative().safe()
const HeaderFields = z.object({
  formatVersion: z.literal(1),
  connectionId: z.string().min(1),
  connectionGeneration: nonnegative,
  fortnoxDatabaseNumber: z.number().int().positive().safe(),
  fortnoxOrgNumber: z.string().nullable(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  mappingCount: nonnegative,
  exportCount: nonnegative,
  sealedAt: z.date(),
})
const connectionSelect = {
  id: true,
  organizationId: true,
  status: true,
  generation: true,
  fortnoxDatabaseNumber: true,
  fortnoxOrgNumber: true,
} as const satisfies Prisma.FortnoxConnectionSelect
const invalid = () =>
  new ConflictException('Det frysta källunderlaget är ofullständigt eller ogiltigt')

function checkedHeader(row: FortnoxReadSourceCapture): Header {
  try {
    HeaderFields.parse(row)
    const input = canonicalCheckpointInput(row.input)
    if (
      checkpointDigest(input) !== row.requestHash ||
      checkpointDigest(row.input) !== row.requestHash
    )
      throw invalid()
    return { ...row, input }
  } catch {
    throw invalid()
  }
}

/**
 * Fryst KÄLLA, inte validerad kontext eller rätt att fortsätta en körning.
 * Anroparen äger en RepeatableRead-transaktion med ordinarie tidsgränser.
 * Serialiseringsfel måste propageras; ett omförsök kräver en HELT ny transaktion.
 * Inga FortnoxReadRun, HTTP-anrop, token eller ekonomiska resultat ändras här.
 */
export async function captureCheckpointSource(
  tx: Tx,
  organizationId: string,
  captureId: string,
  input: StartCheckpointInput,
): Promise<Header> {
  let canonical: StartCheckpointInput
  try {
    z.string().uuid().parse(captureId)
    const { financialYearStart, financialYearEnd, ...required } = canonicalCheckpointInput(input)
    // Valfria undefined-fält sparas inte i JSON. Hashera den form som faktiskt
    // blir beständig så uttryckligt undefined och utelämnat fält kan återläsas.
    canonical = {
      ...required,
      ...(financialYearStart === undefined ? {} : { financialYearStart }),
      ...(financialYearEnd === undefined ? {} : { financialYearEnd }),
    }
  } catch {
    throw new BadRequestException('Ogiltig identitet eller urval för källkopian')
  }
  const isolation = await tx.$queryRaw<Array<{ isolation: string; createdAt: Date }>>`
    SELECT current_setting('transaction_isolation') AS isolation,
      CURRENT_TIMESTAMP AS "createdAt"`
  const databasePoint = isolation[0]
  if (!databasePoint || databasePoint.isolation !== 'repeatable read')
    throw new ConflictException('Källkopiering kräver en RepeatableRead-transaktion')

  // Samma låsordning som checkpointkärnan. Inga fria callerfält får bestämma
  // företag eller generation. RR kan avvisa en anslutning som ändrats vid väntan.
  await tx.$queryRaw`
    SELECT "id" FROM "FortnoxConnection"
    WHERE "organizationId" = ${organizationId} FOR UPDATE`
  const connection = await tx.fortnoxConnection.findUnique({
    where: { organizationId },
    select: connectionSelect,
  })
  if (!connection || connection.status !== 'ACTIVE')
    throw new ConflictException('Ingen aktiv Fortnox-anslutning')
  const requestHash = checkpointDigest(canonical)
  await tx.$queryRaw`
    SELECT "id" FROM "FortnoxReadSourceCapture"
    WHERE "id" = ${captureId} AND "organizationId" = ${organizationId} FOR UPDATE`
  const previous = await tx.fortnoxReadSourceCapture.findUnique({
    where: { id: captureId, organizationId },
  })
  if (previous) {
    const header = checkedHeader(previous)
    if (
      header.requestHash !== requestHash ||
      header.connectionId !== connection.id ||
      header.connectionGeneration !== connection.generation ||
      header.fortnoxDatabaseNumber !== connection.fortnoxDatabaseNumber ||
      header.fortnoxOrgNumber !== connection.fortnoxOrgNumber
    )
      throw new ConflictException('Källkopian hör till ett annat urval eller en äldre anslutning')
    return header
  }

  // En tidigare capture kan ha lämnat denna constraint IMMEDIATE i samma
  // caller-Tx. Bara den egna constrainten skjuts upp medan nästa kopia byggs.
  await tx.$executeRaw`SET CONSTRAINTS "fortnox_source_commit_seal" DEFERRED`
  try {
    await tx.fortnoxReadSourceCapture.create({
      data: {
        id: captureId,
        organizationId,
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        fortnoxDatabaseNumber: connection.fortnoxDatabaseNumber,
        fortnoxOrgNumber: connection.fortnoxOrgNumber,
        input: canonical as Prisma.InputJsonValue,
        requestHash,
        // Samma DB-tid som transaktionens början, uttryckligen bunden även
        // när ORM:en skickar ett värde i stället för att använda SQL-default.
        createdAt: databasePoint.createdAt,
      },
      select: { id: true },
    })
  } catch (error) {
    // Bara headerns id/organisation är unika här. Ett främmande id eller en
    // samtidig, för RR osynlig commit får aldrig tyst adopteras eller skrivas om.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new ConflictException('Källkopians identitet används redan; läs om i en ny transaktion')
    throw error
  }

  const mappingCount = await tx.$executeRaw`
    INSERT INTO "FortnoxReadSourceMapping"
      ("id", "organizationId", "captureId", "ordinal", "sourceId",
       "dimensionType", "code", "propertyId", "propertyName")
    SELECT gen_random_uuid()::text, ${organizationId}, ${captureId},
      row_number() OVER (ORDER BY m."dimensionType" ASC, m."code" ASC),
      m."id", m."dimensionType", m."code", m."propertyId", p."name"
    FROM "FortnoxDimensionMapping" m
    JOIN "Property" p ON p."id" = m."propertyId"
    WHERE m."organizationId" = ${organizationId} AND p."organizationId" = ${organizationId}
    ORDER BY m."dimensionType" ASC, m."code" ASC`

  // Behåll råa JSON-typer och ordning: SQL gör ingen kontonormalisering.
  // Nullrader ska fortfarande ge kallkontons TypeError; andra felaktiga rows
  // ignoreras där som förut. Array-expansion sker enbart för en faktisk array.
  // Årsurvalet får inte krympas till efterfrågad månad eller kostnadskonton.
  const exportCount = await tx.$executeRaw`
    INSERT INTO "FortnoxReadSourceExport"
      ("id", "organizationId", "captureId", "ordinal", "sourceId", "externalYear",
       "externalSeries", "externalNumber", "journalEntryId", "accountSource")
    SELECT gen_random_uuid()::text, ${organizationId}, ${captureId},
      row_number() OVER (ORDER BY e."id" ASC), e."id", e."externalYear",
      e."externalSeries", e."externalNumber", e."journalEntryId",
      jsonb_build_object(
        'provenance', jsonb_build_object('lines',
          CASE WHEN jsonb_typeof(e."draft" #> '{provenance,lines}') = 'array'
            THEN (SELECT jsonb_agg(
              CASE WHEN source_line.value = 'null'::jsonb THEN source_line.value
                ELSE jsonb_build_object(
                  'localAccountNumber', source_line.value -> 'localAccountNumber',
                  'externalAccountNumber', source_line.value -> 'externalAccountNumber')
              END ORDER BY source_line.ordinal)
              FROM jsonb_array_elements(e."draft" #> '{provenance,lines}')
                WITH ORDINALITY AS source_line(value, ordinal))
            ELSE e."draft" #> '{provenance,lines}' END),
        'kontomappning', jsonb_build_object('revision', e."draft" #> '{kontomappning,revision}'))
    FROM "FortnoxVoucherExport" e
    JOIN "JournalEntry" j ON j."id" = e."journalEntryId"
    WHERE e."organizationId" = ${organizationId}
      AND j."organizationId" = ${organizationId}
      AND e."state" = 'CONFIRMED'
      AND e."fortnoxDatabaseNumber" = ${connection.fortnoxDatabaseNumber}
      AND e."externalYear" = ${canonical.financialYearId}
      AND e."externalSeries" IS NOT NULL AND e."externalNumber" IS NOT NULL
    ORDER BY e."id" ASC`

  const sealed = await tx.$queryRaw<FortnoxReadSourceCapture[]>`
    UPDATE "FortnoxReadSourceCapture"
    SET "mappingCount" = ${mappingCount}, "exportCount" = ${exportCount},
        "sealedAt" = clock_timestamp()
    WHERE "id" = ${captureId} AND "organizationId" = ${organizationId}
    RETURNING *`
  if (sealed.length !== 1 || !sealed[0]) throw invalid()
  // Prisma 5.22 kan rapportera fulfilled vid avvisad deferred COMMIT. Riktad
  // IMMEDIATE ger ett explicit fel och rör inte anroparens andra constraints.
  await tx.$executeRaw`SET CONSTRAINTS "fortnox_source_commit_seal" IMMEDIATE`
  return checkedHeader(sealed[0])
}

/** Historisk råkälla. Ingen liveanslutning/fence eller validerad kontext intygas. */
export async function readCheckpointSourceHeader(
  tx: Tx,
  organizationId: string,
  captureId: string,
): Promise<Header> {
  const row = await tx.fortnoxReadSourceCapture.findUnique({
    where: { id: captureId, organizationId },
  })
  if (!row) throw invalid()
  return checkedHeader(row)
}

function pageLength(afterOrdinal: bigint, count: number): number {
  if (typeof afterOrdinal !== 'bigint' || afterOrdinal < 0n || afterOrdinal > BigInt(count))
    throw new BadRequestException('Ogiltig position i det frysta källunderlaget')
  return Math.min(PAGE_SIZE, count - Number(afterOrdinal))
}

function checkedPage<T extends { organizationId: string; captureId: string; ordinal: bigint }>(
  header: Header,
  items: T[],
  afterOrdinal: bigint,
  count: number,
): SourcePage<T> {
  const length = pageLength(afterOrdinal, count)
  if (
    items.length !== length ||
    items.some(
      (row, index) =>
        row.organizationId !== header.organizationId ||
        row.captureId !== header.id ||
        row.ordinal !== afterOrdinal + BigInt(index) + 1n,
    )
  )
    throw invalid()
  const last = afterOrdinal + BigInt(length)
  return { items, nextAfterOrdinal: last < BigInt(count) ? last : null }
}

/** Max100 poster, inte en bytegräns. Inga råa fulla drafts eller token läses. */
export async function readCheckpointSourceMappingPage(
  tx: Tx,
  organizationId: string,
  captureId: string,
  afterOrdinal = 0n,
): Promise<SourcePage<FortnoxReadSourceMapping>> {
  const header = await readCheckpointSourceHeader(tx, organizationId, captureId)
  pageLength(afterOrdinal, header.mappingCount)
  const items = await tx.fortnoxReadSourceMapping.findMany({
    where: { organizationId, captureId, ordinal: { gt: afterOrdinal } },
    orderBy: { ordinal: 'asc' },
    take: PAGE_SIZE,
  })
  return checkedPage(header, items, afterOrdinal, header.mappingCount)
}

export async function readCheckpointSourceExportPage(
  tx: Tx,
  organizationId: string,
  captureId: string,
  afterOrdinal = 0n,
): Promise<SourcePage<FortnoxReadSourceExport>> {
  const header = await readCheckpointSourceHeader(tx, organizationId, captureId)
  const length = pageLength(afterOrdinal, header.exportCount)
  // Tom text bevarar orgjämförelsen men hindrar ett missvisande orgindexval
  // vid gamla stats: uppmätt 72 000 lästa rader för en sida om 100. Scope ligger
  // kvar före LIMIT; capture/ordinal-indexet kan begränsa själva läsarbetet.
  // Bara fulla sidor avgränsas uppåt. Öppen kort/tom svans låter checkedPage
  // fortsatt upptäcka rader utöver headerns antal, även efter en lucka.
  const upperBound =
    length === PAGE_SIZE
      ? Prisma.sql`AND "ordinal" <= ${afterOrdinal + BigInt(PAGE_SIZE)}`
      : Prisma.empty
  const items = await tx.$queryRaw<FortnoxReadSourceExport[]>`
    SELECT "id", "organizationId", "captureId", "ordinal", "sourceId",
           "externalYear", "externalSeries", "externalNumber", "journalEntryId", "accountSource"
    FROM "FortnoxReadSourceExport"
    WHERE ("organizationId" || '') = ${organizationId}
      AND "captureId" = ${captureId} AND "ordinal" > ${afterOrdinal}
      ${upperBound}
    ORDER BY "ordinal" ASC LIMIT ${PAGE_SIZE}`
  return checkedPage(header, items, afterOrdinal, header.exportCount)
}
