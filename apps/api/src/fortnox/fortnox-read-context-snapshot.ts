import { BadRequestException, ConflictException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Prisma, type FortnoxReadContextSnapshot } from '@prisma/client'
import { z } from 'zod'
import {
  canonicalCheckpointInput,
  checkpointDigest,
  CheckpointContextSchema,
  CheckpointInputSchema,
} from './fortnox-read-checkpoint-context'

type Tx = Prisma.TransactionClient
const PAGE_SIZE = 100
const KINDS = ['MAPPINGS', 'OWN_EXPORTS'] as const
type Kind = (typeof KINDS)[number]
const count = z.number().int().nonnegative().safe()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const collection = z
  .object({ itemCount: count, pageCount: count, root: hash })
  .strict()
  .refine((v) => v.pageCount === Math.ceil(v.itemCount / PAGE_SIZE))
const ManifestSchema = z
  .object({
    version: z.literal(1),
    input: CheckpointInputSchema,
    sourceDigest: hash,
    connection: z
      .object({
        id: z.string(),
        generation: count,
        databaseNumber: z.number().int().positive().safe(),
        orgNumber: z.string().nullable(),
      })
      .strict(),
    collections: z.object({ MAPPINGS: collection, OWN_EXPORTS: collection }).strict(),
  })
  .strict()
type Manifest = z.infer<typeof ManifestSchema>
type Header = Omit<FortnoxReadContextSnapshot, 'manifest'> & { manifest: Manifest }
type Context = z.infer<typeof CheckpointContextSchema>
type Items = Context['mappings'] | Context['ownExports']
const runSelect = {
  id: true,
  organizationId: true,
  workVersion: true,
  connectionId: true,
  connectionGeneration: true,
  fortnoxDatabaseNumber: true,
  fortnoxOrgNumber: true,
  requestHash: true,
  financialYearId: true,
  periodFrom: true,
  periodTo: true,
  costAccounts: true,
} as const satisfies Prisma.FortnoxReadRunSelect
type RunBinding = Prisma.FortnoxReadRunGetPayload<{ select: typeof runSelect }>
const json = (value: unknown) => value as Prisma.InputJsonValue
const invalid = () =>
  new ConflictException('Det frysta läsunderlaget är ofullständigt eller ogiltigt')

function inputMatches(run: RunBinding, input: Manifest['input']): boolean {
  return (
    run.workVersion === 1 &&
    run.requestHash === checkpointDigest(canonicalCheckpointInput(input)) &&
    run.financialYearId === input.financialYearId &&
    run.periodFrom.toISOString().slice(0, 10) === input.periodFrom &&
    run.periodTo.toISOString().slice(0, 10) === input.periodTo &&
    checkpointDigest(run.costAccounts) === checkpointDigest(input.costAccounts)
  )
}

function connectionOf(run: RunBinding): Manifest['connection'] {
  if (run.connectionGeneration === null) throw invalid()
  return {
    id: run.connectionId,
    generation: run.connectionGeneration,
    databaseNumber: run.fortnoxDatabaseNumber,
    orgNumber: run.fortnoxOrgNumber,
  }
}

function bindingDigest(header: Pick<Header, 'id' | 'organizationId' | 'runId' | 'manifest'>) {
  const { version, input, sourceDigest, connection } = header.manifest
  return checkpointDigest({
    snapshotId: header.id,
    organizationId: header.organizationId,
    runId: header.runId,
    version,
    input,
    sourceDigest,
    connection,
  })
}

function initialRoot(binding: string, kind: Kind) {
  return checkpointDigest({ version: 1, binding, kind })
}

function extendRoot(previousRoot: string, page: number, itemCount: number, digest: string) {
  return checkpointDigest({ previousRoot, page, itemCount, digest })
}

function pageDigest(binding: string, kind: Kind, page: number, items: Items) {
  return checkpointDigest({ version: 1, binding, kind, page, itemCount: items.length, items })
}

function headerDigest(header: Pick<Header, 'id' | 'organizationId' | 'runId' | 'manifest'>) {
  return checkpointDigest({
    id: header.id,
    organizationId: header.organizationId,
    runId: header.runId,
    manifest: header.manifest,
  })
}

/**
 * Inert lagringsprimitive: kopierar EN redan fryst v1-kontext. Anropas inte av
 * checkpointtjänsten, HTTP eller en worker. Inga livekällor eller körningsfält
 * ändras. Anroparen måste propagera fel så att dess transaktion rullas tillbaka.
 * DB-spärren hindrar halvfärdig commit även om ett fel fångas, men Prisma 5.22
 * kan då returnera framgång trots PostgreSQL-rollback. Fånga aldrig felet och
 * tolka transaktionens retur som en lyckad frysning.
 * Frysningen läser hela källan en gång; detta är inte en minnesbegränsad start.
 */
export async function freezeCheckpointContext(tx: Tx, organizationId: string, runId: string) {
  await tx.$queryRaw`SELECT "id" FROM "FortnoxReadRun" WHERE "id" = ${runId} AND "organizationId" = ${organizationId} FOR UPDATE`
  const run = await tx.fortnoxReadRun.findUnique({
    where: { id: runId, organizationId },
    select: { ...runSelect, frozenContext: true },
  })
  if (!run) throw invalid()
  const parsed = CheckpointContextSchema.safeParse(run.frozenContext)
  if (!parsed.success || !inputMatches(run, parsed.data.input)) throw invalid()
  const context = parsed.data
  const sourceDigest = checkpointDigest(context)
  const existing = await tx.fortnoxReadContextSnapshot.findUnique({
    where: { runId, organizationId },
  })
  if (existing) {
    const header = checkedHeader(existing, run)
    if (header.manifest.sourceDigest !== sourceDigest) throw invalid()
    return header
  }

  const manifest: Manifest = {
    version: 1,
    input: context.input,
    sourceDigest,
    connection: connectionOf(run),
    collections: {
      MAPPINGS: { itemCount: context.mappings.length, pageCount: 0, root: '' },
      OWN_EXPORTS: { itemCount: context.ownExports.length, pageCount: 0, root: '' },
    },
  }
  const header = { id: randomUUID(), organizationId, runId, manifest }
  const binding = bindingDigest(header)
  const pages: Prisma.FortnoxReadContextPageCreateManyInput[] = []
  for (const kind of KINDS) {
    const items: Items = kind === 'MAPPINGS' ? context.mappings : context.ownExports
    let root = initialRoot(binding, kind)
    for (let offset = 0; offset < items.length; offset += PAGE_SIZE) {
      const page = offset / PAGE_SIZE + 1
      const part = items.slice(offset, offset + PAGE_SIZE)
      const digest = pageDigest(binding, kind, page, part)
      pages.push({
        id: randomUUID(),
        organizationId,
        snapshotId: header.id,
        kind,
        page,
        itemCount: part.length,
        digest,
        items: json(part),
      })
      root = extendRoot(root, page, part.length, digest)
    }
    manifest.collections[kind] = {
      itemCount: items.length,
      pageCount: Math.ceil(items.length / PAGE_SIZE),
      root,
    }
  }
  ManifestSchema.parse(manifest)
  await tx.fortnoxReadContextSnapshot.create({
    data: { ...header, manifest: json(manifest), digest: headerDigest(header) },
    select: { id: true },
  })
  // Skriv små omgångar, men behåll EN transaktion och EN försegling. Ordning och
  // dubletter bevaras exakt; inga identiteter ersätts eller dedupliceras här.
  for (let offset = 0; offset < pages.length; offset += 100) {
    await tx.fortnoxReadContextPage.createMany({ data: pages.slice(offset, offset + 100) })
  }
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`
  if (!clock) throw invalid()
  const sealed = await tx.fortnoxReadContextSnapshot.update({
    where: { id: header.id, organizationId },
    data: { sealedAt: clock.now },
  })
  return checkedHeader(sealed, run)
}

function checkedHeader(row: FortnoxReadContextSnapshot, run: RunBinding): Header {
  const parsed = ManifestSchema.safeParse(row.manifest)
  if (!parsed.success || !row.sealedAt) throw invalid()
  const header = { ...row, manifest: parsed.data }
  if (
    row.organizationId !== run.organizationId ||
    row.runId !== run.id ||
    row.digest !== headerDigest(header) ||
    !inputMatches(run, parsed.data.input) ||
    checkpointDigest(parsed.data.connection) !== checkpointDigest(connectionOf(run))
  )
    throw invalid()
  return header
}

/** Läser bara liten metadata och körningens bindning, aldrig källans stora JSON. */
export async function readCheckpointContextHeader(tx: Tx, organizationId: string, runId: string) {
  const row = await tx.fortnoxReadContextSnapshot.findUnique({
    where: { runId, organizationId },
  })
  const run = await tx.fortnoxReadRun.findUnique({
    where: { id: runId, organizationId },
    select: runSelect,
  })
  if (!row || !run) throw invalid()
  return checkedHeader(row, run)
}

async function checkedPage(tx: Tx, header: Header, kind: Kind, page: number) {
  const row = await tx.fortnoxReadContextPage.findUnique({
    where: {
      snapshotId_kind_page: { snapshotId: header.id, kind, page },
      organizationId: header.organizationId,
    },
  })
  const schema =
    kind === 'MAPPINGS'
      ? CheckpointContextSchema.shape.mappings
      : CheckpointContextSchema.shape.ownExports
  const parsed = schema.safeParse(row?.items)
  const expected = Math.min(
    PAGE_SIZE,
    header.manifest.collections[kind].itemCount - (page - 1) * PAGE_SIZE,
  )
  if (
    !row ||
    !parsed.success ||
    expected < 1 ||
    row.itemCount !== expected ||
    parsed.data.length !== expected ||
    row.digest !== pageDigest(bindingDigest(header), kind, page, parsed.data)
  )
    throw invalid()
  return { items: parsed.data, digest: row.digest }
}

/**
 * En verifierad sida, inte ett ekonomiskt resultat. Högst 100 poster; namn och
 * perMal/sources har samma gränser som v1, så detta är ingen strikt bytegräns.
 */
export async function readCheckpointContextPage(
  tx: Tx,
  organizationId: string,
  runId: string,
  kind: Kind,
  page: number,
): Promise<{ items: Items; nextPage: number | null }> {
  if (!KINDS.includes(kind) || !Number.isSafeInteger(page) || page < 1)
    throw new BadRequestException('Ogiltig sida i fryst läsunderlag')
  const header = await readCheckpointContextHeader(tx, organizationId, runId)
  const total = header.manifest.collections[kind].pageCount
  if (page > total + 1) throw new BadRequestException('Sidan ligger utanför det frysta underlaget')
  if (page === total + 1) return { items: [], nextPage: null }
  const checked = await checkedPage(tx, header, kind, page)
  return { items: checked.items, nextPage: page < total ? page + 1 : null }
}

/**
 * Fullpass krävs före en framtida publicering. Det binder alla sidor och deras
 * ordning till förseglingen. Publicering/reducerare/anslutningsfence ingår inte.
 * Bara en sida och en löpande hash behöver hållas under kontrollen.
 */
export async function verifyCheckpointContextSnapshot(
  tx: Tx,
  organizationId: string,
  runId: string,
) {
  const header = await readCheckpointContextHeader(tx, organizationId, runId)
  const binding = bindingDigest(header)
  for (const kind of KINDS) {
    const collection = header.manifest.collections[kind]
    let root = initialRoot(binding, kind)
    let items = 0
    for (let page = 1; page <= collection.pageCount; page++) {
      const checked = await checkedPage(tx, header, kind, page)
      items += checked.items.length
      root = extendRoot(root, page, checked.items.length, checked.digest)
    }
    const stored = await tx.fortnoxReadContextPage.count({
      where: { organizationId, snapshotId: header.id, kind },
    })
    if (
      stored !== collection.pageCount ||
      items !== collection.itemCount ||
      root !== collection.root
    )
      throw invalid()
  }
  return header
}
