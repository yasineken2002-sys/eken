import { createHash } from 'node:crypto'
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { ReadingReviewAssessment } from '@prisma/client'
import {
  latestReadingReview,
  READING_REVIEW_RULE_VERSION,
  readingComparisonCandidates,
} from '@eken/shared'
import type { ChargeControl, ReadingFinding, ReadingReviewSnapshot } from '@eken/shared'
import { loadReadingReview } from './reading-review.query'

type Finding = ReadingReviewSnapshot['findings'][number]

// Uttömmande produktionsbeslut. Facit i charge-gate.spec.ts är separat.
export const CHARGE_FINDING_POLICY = {
  DATA: 'BLOCK',
  OVERLAP: 'BLOCK',
  DECREASE: 'BLOCK',
  HIGH_RATE: 'REQUIRE_ATTESTATION',
} as const satisfies Record<ReadingFinding['code'], string>
export const CHARGE_ASSESSMENT_POLICY = {
  NEEDS_INVESTIGATION: false,
  CONFIRMED: false,
  EXPLAINED: true,
} as const satisfies Record<ReadingReviewAssessment, boolean>

export function findingAllowsCharge(finding: Finding, ruleVersion: string): boolean {
  const latest = latestReadingReview(finding)
  return (
    CHARGE_FINDING_POLICY[finding.code] === 'REQUIRE_ATTESTATION' &&
    !!latest &&
    latest.fingerprint === finding.fingerprint &&
    latest.ruleVersion === ruleVersion &&
    CHARGE_ASSESSMENT_POLICY[latest.assessment] &&
    latest.billingBasisDecision === 'VERIFIED_CORRECT_REAL_INCREASE'
  )
}

// READ COMMITTED krävs när en tidigare låsinnehavare kan ändra underlaget.
// Samma nyckel finns i migrationernas fyra skrivtriggers; låset hålls till commit.
export async function lockConsumptionEvidence(
  tx: Prisma.TransactionClient,
  organizationId: string,
) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'consumption-gate:' + organizationId}, 0))::text`
}

export async function requireChargeActor(
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} AND "organizationId" = ${organizationId} FOR SHARE`
  const actor = await tx.user.findFirst({
    where: { id: userId, organizationId, isActive: true },
    select: { firstName: true, lastName: true, role: true },
  })
  if (!actor || !['OWNER', 'ADMIN', 'MANAGER'].includes(actor.role))
    throw new ForbiddenException(
      'Din roll får inte godkänna förbrukningsunderlag eller konfirmera debitering.',
    )
  return `${actor.firstName} ${actor.lastName}`.trim()
}

export const chargeConflict = () =>
  new ConflictException(
    'Underlaget eller bedömningen har ändrats. Läs om kontrollen i Förbrukning innan du försöker igen.',
  )
export function consumptionConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || (error.code === 'P2010' && error.meta?.code === '40P01'))
  )
    throw chargeConflict()
  throw error
}

/** Ska läsas under organisationslåset vid varje beslut/effekt. */
export async function loadChargeControl(
  tx: Prisma.TransactionClient,
  organizationId: string,
  chargeId: string,
) {
  const charge = await tx.consumptionCharge.findFirst({ where: { id: chargeId, organizationId } })
  if (!charge) throw new NotFoundException('Förbrukningsposten hittades inte')
  const reading = await tx.meterReading.findFirst({
    where: { id: charge.meterReadingId, organizationId },
  })
  if (!reading) throw new ConflictException('Debiteringens avläsning saknas i organisationen.')
  const rows = await tx.meterReading.findMany({
    where: { organizationId, meterId: reading.meterId, periodEnd: { lte: reading.periodEnd } },
    orderBy: [{ periodEnd: 'asc' }, { id: 'asc' }],
  })
  const report = await loadReadingReview(organizationId, tx, reading.meterId)
  const previous = rows.filter((r) => r.periodEnd < reading.periodEnd).at(-1)
  const toReviewReading = (r: typeof reading) => ({
    ...r,
    value: r.value.toString(),
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
  })
  const relevantIds = new Set(
    readingComparisonCandidates(rows.map(toReviewReading), toReviewReading(reading)).map(
      (r) => r.id,
    ),
  )
  if (reading.readingType === 'CUMULATIVE' && previous) relevantIds.add(previous.id)
  // En tidigare bedömd varning får inte bli ett tyst klartecken när ändrad
  // historik gör att just trendkontrollen inte längre går att utföra.
  const latestHistory = new Map<string, ReadingReviewSnapshot['history'][number]>()
  for (const row of report.history) {
    const key = `${row.evidence.readingId}:${row.evidence.code}`
    if (!latestHistory.has(key) || latestHistory.get(key)!.revision < row.revision)
      latestHistory.set(key, row)
  }
  // Även varningar på källor som använts i varningens jämförelseunderlag gäller.
  let added = true
  while (added) {
    added = false
    for (const row of latestHistory.values())
      if (relevantIds.has(row.evidence.readingId))
        for (const source of row.evidence.sourceReadings)
          if (!relevantIds.has(source.id)) {
            relevantIds.add(source.id)
            added = true
          }
    for (const f of report.findings.filter((f) => relevantIds.has(f.readingId)))
      for (const source of f.sourceReadings)
        if (!relevantIds.has(source.id)) {
          relevantIds.add(source.id)
          added = true
        }
  }
  const findings = report.findings
    .filter((f) => relevantIds.has(f.readingId))
    .sort((a, b) => `${a.readingId}:${a.code}`.localeCompare(`${b.readingId}:${b.code}`))
  const quantity =
    reading.readingType === 'PERIOD_VOLUME'
      ? reading.value
      : previous
        ? reading.value.minus(previous.value)
        : null
  const problems: string[] = []
  const missingFindings = [...latestHistory.values()].filter(
    (r) =>
      relevantIds.has(r.evidence.readingId) &&
      !findings.some((f) => f.readingId === r.evidence.readingId && f.code === r.evidence.code),
  )
  for (const row of missingFindings)
    problems.push(
      `Avläsning ${row.evidence.readingId}: tidigare bedömt underlag (${row.evidence.code}) har ändrats och varningen kan inte längre prövas. Läs historiken och jämförelseunderlaget i Granskning. Rättelsevägen är ett separat kommande bygge; en försvunnen varning är inget nytt godkännande.`,
    )
  if (charge.status === 'CANCELLED') problems.push('Debiteringen är annullerad.')
  if (
    charge.kind !== 'ACTUAL' ||
    !quantity ||
    !quantity.equals(charge.quantity) ||
    quantity.lte(0) ||
    charge.unitId !== reading.unitId ||
    charge.periodStart.getTime() !== reading.periodStart.getTime() ||
    charge.periodEnd.getTime() !== reading.periodEnd.getTime()
  )
    problems.push(
      'Debiteringens underlag stämmer inte med den aktuella avläsningen och dess förbrukning. Rättelsevägen är ett separat kommande bygge.',
    )
  await tx.$queryRaw`SELECT "id" FROM "Lease" WHERE "id" = ${charge.leaseId} AND "organizationId" = ${organizationId} FOR SHARE`
  await tx.$queryRaw`SELECT "id" FROM "Meter" WHERE "id" = ${reading.meterId} AND "organizationId" = ${organizationId} FOR SHARE`
  const lease = await tx.lease.findFirst({
    where: { id: charge.leaseId, organizationId, unitId: charge.unitId, tenantId: charge.tenantId },
  })
  const meter = await tx.meter.findFirst({
    where: { id: reading.meterId, organizationId, unitId: charge.unitId, type: charge.meterType },
  })
  if (!lease || !meter)
    problems.push('Avläsning, mätare, avtal och debitering hör inte till samma underlag.')
  for (const f of findings)
    if (!findingAllowsCharge(f, report.ruleVersion))
      problems.push(
        `Avläsning ${f.readingId} (${f.code}): ${f.explanation} Öppna Granskning i Förbrukning och bedöm varningen mot aktuellt underlag. Endast en förklarad verklig ökning med uttryckligt intyg om korrekt underlag kan tillåtas; felaktigt underlag kräver den kommande rättelsevägen.`,
      )
  const evidence = {
    ruleVersion: report.ruleVersion,
    charge: {
      id: charge.id,
      organizationId,
      readingId: reading.id,
      leaseId: charge.leaseId,
      tenantId: charge.tenantId,
      unitId: charge.unitId,
      meterType: charge.meterType,
      periodStart: charge.periodStart,
      periodEnd: charge.periodEnd,
      quantity: charge.quantity,
      pricePerUnit: charge.pricePerUnit,
      netAmount: charge.netAmount,
      vatStatus: charge.vatStatus,
      vatRate: charge.vatRate,
      vatAmount: charge.vatAmount,
      totalAmount: charge.totalAmount,
      kind: charge.kind,
      deliveryMode: charge.deliveryMode,
    },
    readings: rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      meterId: r.meterId,
      unitId: r.unitId,
      value: r.value,
      readingType: r.readingType,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
    })),
    missingFindings,
    findings: findings.map((f) => ({
      ...f,
      reviews: undefined,
      latestReview: latestReadingReview(f) ?? null,
    })),
    // Täckningen gäller rapporten, inte att varje avläsning kunnat trendkontrolleras.
    trendCoverage: {
      trendAssessed: report.trendAssessed,
      notTrendAssessed: report.notTrendAssessed,
    },
  }
  // Täckning för mätarens rapport sparas; framtida perioder ändrar inte denna identitet.
  const { trendCoverage: _coverage, ...identity } = evidence
  void _coverage
  const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const saved = await tx.consumptionChargeCheck.findFirst({
    where: { chargeId, organizationId },
    orderBy: { revision: 'desc' },
  })
  const control: ChargeControl = {
    chargeId,
    readingId: reading.id,
    fingerprint,
    ruleVersion: report.ruleVersion,
    allowed: problems.length === 0,
    problems,
    hasCurrentCheck:
      saved?.fingerprint === fingerprint &&
      saved.readingId === reading.id &&
      saved.ruleVersion === READING_REVIEW_RULE_VERSION,
    findingCount: findings.length,
    ...(saved
      ? { checkedAt: saved.createdAt.toISOString(), checkedByName: saved.checkedByName }
      : {}),
  }
  return { charge, control, evidence, nextRevision: (saved?.revision ?? 0) + 1 }
}

export async function requireChargeCheck(
  tx: Prisma.TransactionClient,
  organizationId: string,
  chargeId: string,
) {
  await lockConsumptionEvidence(tx, organizationId)
  const current = await loadChargeControl(tx, organizationId, chargeId)
  if (!current.control.allowed) throw new ConflictException(current.control.problems.join('\n'))
  if (
    !current.control.hasCurrentCheck ||
    !['CONFIRMED', 'ATTACHED'].includes(current.charge.status)
  )
    throw new ConflictException(
      `Avläsning ${current.control.readingId}: debiteringen saknar en aktuell sparad kontroll. Öppna posten i Förbrukning, läs om kontrollen och konfirmera på nytt.`,
    )
  return current.charge
}
