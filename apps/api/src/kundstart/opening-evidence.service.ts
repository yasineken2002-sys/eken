import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, type OpeningPackage, type OpeningPackageRow, type UserRole } from '@prisma/client'
import {
  createOpeningEvidenceInputSchema,
  reviewOpeningEvidenceInputSchema,
  type CreateOpeningEvidenceInput,
  type ReviewOpeningEvidenceInput,
  type OpeningEvidenceView,
  type OpeningEvidenceListView,
} from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { losRader } from './opening-resolve'
import { kronorTillOre, tolkaDatum } from './opening-csv'
import {
  assertUpload,
  canonical,
  hash,
  key,
  order,
  parseSource,
  parseMapping,
  SOURCE_FORMAT,
  MAPPING_FORMAT,
  NORMALIZATION,
} from './opening-evidence-format'
import { compareEvidence, type EvidenceComparison } from './opening-evidence-compare'

type Actor = { sub: string; role: UserRole }
type Package = OpeningPackage & { rows: OpeningPackageRow[] }
type Evidence = Prisma.OpeningEvidenceGetPayload<{ include: { review: true } }>
const iso = (date: Date) => date.toISOString().slice(0, 10)
const orgDigits = (value: string) => value.replace(/-/gu, '')
const decimalOre = (value: Prisma.Decimal | null) =>
  value === null ? null : kronorTillOre(value.toFixed(2))
const TX = {
  ...PAYMENT_TX_LIMITS,
  timeout: 60_000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
}

/** Token claims alone never authorize a write, including direct service calls. */
export async function requireOpeningActor(
  db: Prisma.TransactionClient,
  organizationId: string,
  user: Actor,
  allowed: readonly UserRole[],
) {
  if (!allowed.includes(user.role))
    throw new ForbiddenException('Rollen får inte utföra kundstartshandlingen')
  const actor = await db.user.findFirst({
    where: { id: user.sub, organizationId, isActive: true },
    select: { id: true, role: true },
  })
  if (!actor || actor.role !== user.role)
    throw new ForbiddenException('Aktuell användare eller roll saknar behörighet')
  return actor
}

/** Single falsifiable guard. E21 mutates only this guard; all identities/hashes/locks remain. */
export function requireMatchingEvidence(result: EvidenceComparison) {
  if (result.comparisonStatus !== 'OK')
    throw new ConflictException(
      'Kundavstämningen har stopp eller dokumentavvikelser — rätta och granska en ny version',
    )
}

@Injectable()
export class OpeningEvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  private async lockedPackage(
    tx: Prisma.TransactionClient,
    organizationId: string,
    packageId: string,
  ): Promise<Package> {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM "OpeningPackage" WHERE id = ${packageId} AND "organizationId" = ${organizationId} FOR UPDATE`
    const p = await tx.openingPackage.findFirst({
      where: { id: packageId, organizationId },
      include: { rows: { orderBy: { rowNo: 'asc' } } },
    })
    if (!p) throw new NotFoundException('Öppningspaketet hittades inte')
    return p
  }

  private async latest(db: Prisma.TransactionClient, p: Package) {
    return db.openingEvidence.findFirst({
      where: { organizationId: p.organizationId, packageId: p.id },
      orderBy: { evidenceVersion: 'desc' },
      include: { review: true },
    })
  }

  private input(input: CreateOpeningEvidenceInput): CreateOpeningEvidenceInput {
    const parsed = createOpeningEvidenceInputSchema.strict().safeParse(input)
    if (!parsed.success)
      throw new BadRequestException(
        'Källans deklaration eller filuppgifter saknas eller är ogiltiga',
      )
    const v = parsed.data
    for (const field of [
      'sourceSystemProduct',
      'sourceCompanyKey',
      'scopeDeclaration',
      'scopeResponsible',
      'sourceName',
      'mappingName',
    ] as const)
      if (!v[field].trim()) throw new BadRequestException('Källans deklaration får inte vara tom')
    if (
      !tolkaDatum(v.sourceAsOfDate) ||
      !tolkaDatum(v.sourceExportedAt.slice(0, 10)) ||
      !Number.isFinite(new Date(v.sourceExportedAt).getTime())
    )
      throw new BadRequestException('Källans datum är ogiltigt')
    assertUpload(v.sourceContent, v.mappingContent)
    return v
  }

  private async calculate(
    db: Prisma.TransactionClient,
    p: Package,
    raw: CreateOpeningEvidenceInput,
  ) {
    const input = this.input(raw)
    const org = await db.organization.findUniqueOrThrow({
      where: { id: p.organizationId },
      select: { orgNumber: true, billingCutoverDate: true },
    })
    const asOf = iso(new Date(p.cutoverDate.getTime() - 86_400_000))
    if (
      !org.orgNumber ||
      !org.billingCutoverDate ||
      org.billingCutoverDate.getTime() !== p.cutoverDate.getTime() ||
      org.orgNumber !== p.orgNumber ||
      orgDigits(input.sourceOrgNumber) !== orgDigits(org.orgNumber) ||
      input.sourceAsOfDate !== asOf
    )
      throw new ConflictException(
        'Källföretag, organisationsnummer eller avstämningsdag stämmer inte med aktuellt paket',
      )
    const source = parseSource(input.sourceContent, input.sourceCompanyKey, iso(p.cutoverDate))
    const mapping = parseMapping(input.mappingContent)
    const tenants = await db.tenant.findMany({
      where: { organizationId: p.organizationId, id: { in: mapping.map((m) => m.tenantId) } },
      select: { id: true, anonymizedAt: true },
    })
    const leases = await db.lease.findMany({
      where: { organizationId: p.organizationId, id: { in: mapping.map((m) => m.leaseId) } },
      select: { id: true, tenantId: true, status: true },
    })
    const checked = mapping.map((m) => ({
      ...m,
      valid:
        tenants.some((t) => t.id === m.tenantId && !t.anonymizedAt) &&
        leases.some((l) => l.id === m.leaseId && l.tenantId === m.tenantId && l.status !== 'DRAFT'),
    }))
    const resolution = await losRader(db, p.organizationId, p.cutoverDate, p.rows)
    const imported = p.rows.map((r) => {
      const current = resolution.find((l) => l.rowId === r.id)!
      return {
        row: r.rowNo,
        document: r.sourceId,
        kind: r.kind,
        tenantId: current.tenantId,
        leaseId: current.leaseId,
        original: decimalOre(r.originalAmount),
        paid: decimalOre(r.priorPaidAmount),
        credited: decimalOre(r.priorCreditedAmount),
        open: decimalOre(r.openAmount),
        period:
          r.periodYear && r.periodMonth
            ? `${r.periodYear}-${String(r.periodMonth).padStart(2, '0')}`
            : '',
        due: r.dueDate ? iso(r.dueDate) : '',
        received: r.receivedDate ? iso(r.receivedDate) : '',
        resolutionOk:
          current.errors.length === 0 &&
          current.tenantId === r.tenantId &&
          current.leaseId === r.leaseId,
      }
    })
    const normalized = mapping
      .map(({ row: _row, ...m }) => m)
      .sort((a, b) => order(canonical(a), canonical(b)))
    const binding = {
      mapping: checked
        .map((m) => ({
          ...normalized.find(
            (n) =>
              key(n.company, n.customer, n.contract) === key(m.company, m.customer, m.contract),
          ),
          valid: m.valid,
          leaseTenantId: leases.find((l) => l.id === m.leaseId)?.tenantId ?? null,
        }))
        .sort((a, b) => order(canonical(a), canonical(b))),
      imports: p.rows
        .map((r, i) => ({
          id: r.id,
          storedTenantId: r.tenantId,
          storedLeaseId: r.leaseId,
          tenantRef: r.tenantRef,
          leaseRef: r.leaseRef,
          propertyRef: r.propertyRef,
          unitRef: r.unitRef,
          ...imported[i]!,
        }))
        .sort((a, b) => order(a.id, b.id)),
    }
    return {
      input,
      result: compareEvidence(source, checked, imported, input.sourceCompanyKey),
      mappingNormalizedSha256: hash(canonical(normalized)),
      bindingSha256: hash(canonical(binding)),
    }
  }

  private record(
    p: Package,
    c: Awaited<ReturnType<OpeningEvidenceService['calculate']>>,
    evidenceVersion: number,
    createdById: string,
  ) {
    if (!p.orgNumber)
      throw new ConflictException('Organisationsnummer saknas — validera aktuellt paket')
    const i = c.input
    const metadata = {
      organizationId: p.organizationId,
      packageId: p.id,
      evidenceVersion,
      formatVersion: SOURCE_FORMAT,
      mappingFormatVersion: MAPPING_FORMAT,
      normalizationVersion: NORMALIZATION,
      orgNumber: p.orgNumber,
      cutoverDate: iso(p.cutoverDate),
      sourceAsOfDate: i.sourceAsOfDate,
      packageVersion: p.version,
      packageSourceSha256: p.sourceSha256,
      declaredSourceOrgNumber: i.sourceOrgNumber,
      sourceExportedAt: new Date(i.sourceExportedAt).toISOString(),
      scopeResponsible: i.scopeResponsible,
      sourceSystemProduct: i.sourceSystemProduct,
      sourceCompanyKey: i.sourceCompanyKey,
      scopeDeclaration: i.scopeDeclaration,
      scopeDeclarationSha256: hash(i.scopeDeclaration),
      sourceName: i.sourceName,
      sourceRawSha256: hash(i.sourceContent),
      sourceRawBytes: Buffer.byteLength(i.sourceContent),
      mappingName: i.mappingName,
      mappingRawSha256: hash(i.mappingContent),
      mappingNormalizedSha256: c.mappingNormalizedSha256,
      bindingSha256: c.bindingSha256,
      comparisonStatus: c.result.comparisonStatus,
      comparisonResultSha256: hash(canonical(c.result)),
      comparisonCounts: c.result.counts,
      createdById,
    }
    return {
      ...metadata,
      cutoverDate: p.cutoverDate,
      sourceAsOfDate: new Date(i.sourceAsOfDate),
      sourceExportedAt: new Date(i.sourceExportedAt),
      sourceRaw: Buffer.from(i.sourceContent),
      mappingRaw: Buffer.from(i.mappingContent),
      comparisonResult: c.result as unknown as Prisma.InputJsonValue,
      comparisonCounts: c.result.counts as unknown as Prisma.InputJsonValue,
      evidenceSha256: hash(canonical(metadata)),
    }
  }

  private async current(db: Prisma.TransactionClient, p: Package, e: Evidence) {
    if (
      e.organizationId !== p.organizationId ||
      e.packageId !== p.id ||
      (await this.latest(db, p))?.id !== e.id
    )
      throw new ConflictException('En ny evidensversion måste granskas')
    const sourceContent = Buffer.from(e.sourceRaw).toString('utf8'),
      mappingContent = Buffer.from(e.mappingRaw).toString('utf8')
    if (
      hash(e.sourceRaw) !== e.sourceRawSha256 ||
      hash(e.mappingRaw) !== e.mappingRawSha256 ||
      !Buffer.from(sourceContent).equals(Buffer.from(e.sourceRaw)) ||
      !Buffer.from(mappingContent).equals(Buffer.from(e.mappingRaw))
    )
      throw new ConflictException('Bevarade källbytes stämmer inte med hashen')
    const calculated = await this.calculate(db, p, {
      sourceSystemProduct: e.sourceSystemProduct,
      sourceCompanyKey: e.sourceCompanyKey,
      scopeDeclaration: e.scopeDeclaration,
      scopeResponsible: e.scopeResponsible,
      sourceOrgNumber: e.declaredSourceOrgNumber,
      sourceAsOfDate: iso(e.sourceAsOfDate),
      sourceExportedAt: e.sourceExportedAt.toISOString(),
      sourceName: e.sourceName,
      sourceContent,
      mappingName: e.mappingName,
      mappingContent,
    })
    const expected = this.record(p, calculated, e.evidenceVersion, e.createdById)
    if (
      expected.evidenceSha256 !== e.evidenceSha256 ||
      expected.bindingSha256 !== e.bindingSha256 ||
      expected.mappingNormalizedSha256 !== e.mappingNormalizedSha256 ||
      expected.comparisonResultSha256 !== e.comparisonResultSha256 ||
      expected.comparisonStatus !== e.comparisonStatus ||
      hash(canonical(e.comparisonResult)) !== expected.comparisonResultSha256 ||
      canonical(e.comparisonCounts) !== canonical(expected.comparisonCounts) ||
      e.packageVersion !== p.version ||
      e.packageSourceSha256 !== p.sourceSha256 ||
      e.orgNumber !== p.orgNumber ||
      e.cutoverDate.getTime() !== p.cutoverDate.getTime() ||
      e.sourceRawBytes !== expected.sourceRawBytes ||
      e.scopeDeclarationSha256 !== expected.scopeDeclarationSha256 ||
      e.formatVersion !== SOURCE_FORMAT ||
      e.mappingFormatVersion !== MAPPING_FORMAT ||
      e.normalizationVersion !== NORMALIZATION
    )
      throw new ConflictException(
        'Underlag, import eller identitet har ändrats — skapa och granska ny evidens',
      )
    return calculated.result
  }

  private async requireReview(
    db: Prisma.TransactionClient,
    p: Package,
    e: Evidence,
    approverId: string,
  ) {
    const r = e.review
    if (
      !r ||
      r.organizationId !== p.organizationId ||
      r.evidenceId !== e.id ||
      r.evidenceSha256 !== e.evidenceSha256 ||
      r.reviewerRole !== 'ACCOUNTANT' ||
      r.identityMode !== 'APP_AUTENTISERAD_ACCOUNTANT'
    )
      throw new ConflictException('Exakt evidensversion måste granskas av ekonomigranskare')
    if (r.reviewerUserId === approverId)
      throw new ConflictException('Granskare och godkännare måste vara två skilda användare')
    const reviewer = await db.user.findFirst({
      where: {
        id: r.reviewerUserId,
        organizationId: p.organizationId,
        role: 'ACCOUNTANT',
        isActive: true,
      },
      select: { id: true },
    })
    if (!reviewer)
      throw new ConflictException('Ekonomigranskarens behörighet har ändrats — ny granskning krävs')
  }

  async create(
    organizationId: string,
    packageId: string,
    user: Actor,
    raw: CreateOpeningEvidenceInput,
  ): Promise<OpeningEvidenceView> {
    const input = this.input(raw)
    return this.prisma.$transaction(async (tx) => {
      const p = await this.lockedPackage(tx, organizationId, packageId)
      await requireOpeningActor(tx, organizationId, user, ['OWNER', 'ADMIN'])
      if (p.status !== 'VALIDATED')
        throw new ConflictException('Validera paketet före ny kundavstämning')
      const c = await this.calculate(tx, p, input),
        prior = await this.latest(tx, p)
      const e = await tx.openingEvidence.create({
        data: this.record(p, c, (prior?.evidenceVersion ?? 0) + 1, user.sub),
        include: { review: true },
      })
      return this.view(tx, p, e)
    }, TX)
  }

  async review(
    organizationId: string,
    packageId: string,
    evidenceId: string,
    user: Actor,
    input: ReviewOpeningEvidenceInput,
  ): Promise<OpeningEvidenceView> {
    if (!reviewOpeningEvidenceInputSchema.strict().safeParse(input).success)
      throw new BadRequestException('Granskningen kräver exakt evidenshash')
    return this.prisma.$transaction(async (tx) => {
      const p = await this.lockedPackage(tx, organizationId, packageId)
      await requireOpeningActor(tx, organizationId, user, ['ACCOUNTANT'])
      if (p.status !== 'VALIDATED')
        throw new ConflictException('Paketet måste vara VALIDATED för granskning')
      const e = await tx.openingEvidence.findFirst({
        where: { id: evidenceId, packageId, organizationId },
        include: { review: true },
      })
      if (!e) throw new NotFoundException('Evidensen hittades inte')
      if (e.evidenceSha256 !== input.evidenceSha256)
        throw new ConflictException('Evidenshashen har ändrats')
      requireMatchingEvidence(await this.current(tx, p, e))
      if (e.review) {
        if (
          e.review.reviewerUserId !== user.sub ||
          e.review.organizationId !== organizationId ||
          e.review.evidenceSha256 !== e.evidenceSha256
        )
          throw new ConflictException('Evidensversionen har redan en annan granskning')
        return this.view(tx, p, e)
      }
      await tx.openingEvidenceReview.create({
        data: {
          organizationId,
          evidenceId: e.id,
          evidenceSha256: e.evidenceSha256,
          reviewerUserId: user.sub,
          reviewerRole: 'ACCOUNTANT',
          identityMode: 'APP_AUTENTISERAD_ACCOUNTANT',
        },
      })
      return this.view(tx, p, (await this.latest(tx, p))!)
    }, TX)
  }

  async kravForGodkannande(
    tx: Prisma.TransactionClient,
    organizationId: string,
    p: Package,
    user: Actor,
    evidenceSha256: string,
  ) {
    await requireOpeningActor(tx, organizationId, user, ['OWNER'])
    const e = await this.latest(tx, p)
    if (!e || e.evidenceSha256 !== evidenceSha256)
      throw new ConflictException(
        'Aktuell kundavstämning saknas — skapa och granska evidens före godkännande',
      )
    requireMatchingEvidence(await this.current(tx, p, e))
    await this.requireReview(tx, p, e, user.sub)
    return { evidenceId: e.id, evidenceSha256: e.evidenceSha256 }
  }

  async kravForVerkstallning(
    tx: Prisma.TransactionClient,
    organizationId: string,
    p: Package,
    user: Actor,
  ) {
    await requireOpeningActor(tx, organizationId, user, ['OWNER'])
    const e = await this.latest(tx, p)
    if (
      !e ||
      e.id !== p.approvedEvidenceId ||
      e.evidenceSha256 !== p.approvedEvidenceSha256 ||
      !p.approvedById
    )
      throw new ConflictException('Godkänd kundavstämning saknas — ny evidens och granskning krävs')
    const approver = await tx.user.findFirst({
      where: { id: p.approvedById, organizationId, role: 'OWNER', isActive: true },
      select: { id: true },
    })
    if (!approver) throw new ConflictException('Godkännarens aktuella behörighet saknas')
    requireMatchingEvidence(await this.current(tx, p, e))
    await this.requireReview(tx, p, e, p.approvedById)
    await this.requireReview(tx, p, e, user.sub)
  }

  private async view(
    db: Prisma.TransactionClient,
    p: Package,
    e: Evidence,
  ): Promise<OpeningEvidenceView> {
    const reasons: string[] = []
    if (p.status !== 'VALIDATED') reasons.push('Paketet är inte i granskningsläge')
    if (p.status !== 'EXECUTED') {
      try {
        requireMatchingEvidence(await this.current(db, p, e))
      } catch (error) {
        if (!(error instanceof ConflictException || error instanceof BadRequestException))
          throw error
        reasons.push(error.message)
      }
    }
    let reviewValid = false
    if (e.review) {
      try {
        await this.requireReview(db, p, e, '')
        reviewValid = true
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error
        reasons.push(error.message)
      }
    }
    const result = e.comparisonResult as unknown as EvidenceComparison
    return {
      id: e.id,
      evidenceVersion: e.evidenceVersion,
      packageVersion: e.packageVersion,
      formatVersion: e.formatVersion,
      mappingFormatVersion: e.mappingFormatVersion,
      sourceSystemProduct: e.sourceSystemProduct,
      sourceCompanyKey: e.sourceCompanyKey,
      sourceAsOfDate: iso(e.sourceAsOfDate),
      declaredSourceOrgNumber: e.declaredSourceOrgNumber,
      sourceExportedAt: e.sourceExportedAt.toISOString(),
      scopeResponsible: e.scopeResponsible,
      scopeDeclaration: e.scopeDeclaration,
      sourceName: e.sourceName,
      mappingName: e.mappingName,
      comparisonStatus: e.comparisonStatus,
      counts: result.counts,
      stopp: result.stopp,
      avvikelser: result.avvikelser,
      createdById: e.createdById,
      createdAt: e.createdAt.toISOString(),
      evidenceSha256: e.evidenceSha256,
      granskning: e.review
        ? {
            reviewerUserId: e.review.reviewerUserId,
            reviewerRole: e.review.reviewerRole,
            reviewedAt: e.review.reviewedAt.toISOString(),
          }
        : null,
      artefaktKontroll: {
        kallaOk: hash(e.sourceRaw) === e.sourceRawSha256,
        mappningOk: hash(e.mappingRaw) === e.mappingRawSha256,
      },
      giltighet: {
        forGranskning: reasons.length === 0 && !e.review,
        forGodkannande: reasons.length === 0 && reviewValid,
        skal: reasons,
      },
    }
  }

  async list(organizationId: string, packageId: string): Promise<OpeningEvidenceListView> {
    const p = await this.prisma.openingPackage.findFirst({
      where: { id: packageId, organizationId },
      include: { rows: { orderBy: { rowNo: 'asc' } } },
    })
    if (!p) throw new NotFoundException('Öppningspaketet hittades inte')
    const entries = await this.prisma.openingEvidence.findMany({
      where: { packageId, organizationId },
      orderBy: { evidenceVersion: 'desc' },
      include: { review: true },
    })
    const views: OpeningEvidenceView[] = []
    for (const e of entries) views.push(await this.view(this.prisma, p, e))
    return {
      packageId,
      packageVersion: p.version,
      aktuell: views[0] ?? null,
      tidigare: views.slice(1),
    }
  }
}
