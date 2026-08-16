jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
/**
 * #471 — GALLRING AV SKANNINGSDATA VID COMMIT.
 *
 * `ContractImportRow` var systemets sista ställe med ett personnummer i
 * KLARTEXT i vila. Purge (`Prisma.JsonNull`) skedde bara i `cancelBatch`, så en
 * `COMMITTED` rad behöll `originalScanData`/`reviewedData`/`confirmedData` för
 * alltid — efter att avtalet skapats och numret redan låg krypterat på `Tenant`.
 *
 * Redovisningsgenomgången i #471 svarade att ingen av de tre kolumnerna är
 * räkenskapsinformation: ingen verifikation och ingen bokföringspost hänvisar
 * till dem. AI-mot-människa-spåret bedömdes som ett styrningsintresse, inte en
 * bevarandeplikt — och det kräver inte klartext.
 *
 * Specen bevakar tre saker, i stigande ordning av hur lätta de är att tappa:
 *   1. att gallringen SKER vid commit
 *   2. att spåret som ersätter den aldrig bär personnumret eller rawText
 *   3. att villkoret som skulle ÄNDRA redovisningssvaret bryts synligt
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { ContractScanBatchService, buildCommitAuditTrail } from './contract-scan-batch.service'
import type { ScannedContract } from './contract-scanner.service'

const PERSONNUMMER = '19850101-1234'
const RAWTEXT = `Hyresavtal mellan Anna Andersson (${PERSONNUMMER}) och Fastighets AB …`

function scan(over: Partial<ScannedContract> = {}): ScannedContract {
  return {
    tenantName: 'Anna Andersson',
    tenantType: 'INDIVIDUAL',
    tenantEmail: 'anna@example.se',
    tenantPhone: null,
    personalNumber: PERSONNUMMER,
    companyName: null,
    orgNumber: null,
    propertyAddress: 'Storgatan 1',
    unitDescription: '1201',
    monthlyRent: 12000,
    depositAmount: null,
    startDate: '2026-07-01',
    endDate: null,
    noticePeriodMonths: null,
    confidence: 0.95,
    rawText: RAWTEXT,
    ...over,
  }
}

const META = { committedByUserId: 'user-1', unitId: 'unit-1', committedAt: '2026-08-16T10:00:00Z' }

// ── 1. Spåret (ren funktion) ────────────────────────────────────────────────

describe('buildCommitAuditTrail — fältnivå-spår utan klartext-PII', () => {
  it('orörd avläsning ger tomt spår — inget ändrades', () => {
    const s = scan()
    expect(buildCommitAuditTrail(s, s, META).changedFields).toEqual([])
  })

  it('registrerar ett ändrat fält med från/till', () => {
    const trail = buildCommitAuditTrail(scan(), scan({ monthlyRent: 13500 }), META)
    expect(trail.changedFields).toEqual([{ field: 'monthlyRent', from: 12000, to: 13500 }])
  })

  it('registrerar ett fält operatören LADE TILL (AI:n läste null)', () => {
    const trail = buildCommitAuditTrail(
      scan({ tenantPhone: null }),
      scan({ tenantPhone: '070-1234567' }),
      META,
    )
    expect(trail.changedFields).toEqual([{ field: 'tenantPhone', from: null, to: '070-1234567' }])
  })

  it('KANARIEFÅGEL: ett ändrat personnummer registreras men VÄRDET skrivs aldrig', () => {
    // Matar in det som måste ge utslag: numret ändras, alltså hamnar fältet i
    // spåret. Slutar redigeringen fungera står klartexten här — och då är hela
    // gallringen meningslös, eftersom PII:n bara flyttat kolumn.
    const trail = buildCommitAuditTrail(scan(), scan({ personalNumber: '19900202-5678' }), META)
    const post = trail.changedFields.find((c) => c.field === 'personalNumber')
    expect(post).toEqual({ field: 'personalNumber', from: '[redigerat]', to: '[redigerat]' })

    const serialiserat = JSON.stringify(trail)
    expect(serialiserat).not.toContain(PERSONNUMMER)
    expect(serialiserat).not.toContain('198501011234')
    expect(serialiserat).not.toContain('19900202-5678')
  })

  it('KANARIEFÅGEL: rawText utelämnas HELT, även när den ändrats', () => {
    // rawText är ostrukturerad kontraktstext som bär personnumret i löptext.
    // Den får inte ens registreras som ändrad — ett från/till på 500 tecken
    // fritext vore samma läcka i ny form.
    const trail = buildCommitAuditTrail(scan(), scan({ rawText: 'annan text' }), META)
    expect(trail.changedFields.map((c) => c.field)).not.toContain('rawText')
    expect(JSON.stringify(trail)).not.toContain(PERSONNUMMER)
  })

  it('tål att originalScanData saknas — spåret byggs ändå', () => {
    const trail = buildCommitAuditTrail(null, scan(), META)
    expect(trail.version).toBe(1)
    expect(JSON.stringify(trail)).not.toContain(PERSONNUMMER)
  })

  it('bär vem som committade, när, och mot vilken enhet', () => {
    const trail = buildCommitAuditTrail(scan(), scan(), META)
    expect(trail).toMatchObject({
      version: 1,
      committedAt: META.committedAt,
      committedByUserId: 'user-1',
      unitId: 'unit-1',
    })
  })
})

// ── 2. Gallringen sker faktiskt vid commit ──────────────────────────────────

describe('confirmRow — gallrar klartext-PII vid commit', () => {
  function make() {
    const prisma = {
      contractImportRow: {
        findFirst: jest.fn().mockResolvedValue({
          rowStatus: 'SCANNED',
          matchStatus: 'AUTO_MATCHED',
          matchedUnitId: 'unit-1',
          documentId: null,
          reviewedData: scan(),
          originalScanData: scan(),
          createdLeaseId: null,
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      contractImportBatch: {
        findUnique: jest.fn().mockResolvedValue({ status: 'SCANNED' }),
        findFirst: jest.fn().mockResolvedValue({ status: 'SCANNED' }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockResolvedValue([0, { status: 'SCANNED' }]),
    }
    const service = new ContractScanBatchService(
      prisma as never,
      { checkOrgDailyCostCap: jest.fn() } as never,
      { enqueueRow: jest.fn() } as never,
      { createWithTenant: jest.fn().mockResolvedValue({ id: 'lease-9' }) } as never,
      { linkToLease: jest.fn(), purge: jest.fn(), archive: jest.fn() } as never,
    )
    return { service, prisma }
  }

  /** Den update som sätter COMMITTED — inte claim-låset. */
  function commitSkrivning(prisma: ReturnType<typeof make>['prisma']) {
    return prisma.contractImportRow.update.mock.calls
      .map(([arg]) => arg as { data: Record<string, unknown> })
      .find((c) => c.data.rowStatus === 'COMMITTED')!
  }

  it('nollar originalScanData OCH reviewedData', async () => {
    const { service, prisma } = make()
    await service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1')

    const { data } = commitSkrivning(prisma)
    expect(data.originalScanData).toBe(Prisma.JsonNull)
    expect(data.reviewedData).toBe(Prisma.JsonNull)
    // fileData nollades redan vid SCANNED; symmetrin ska ändå hållas.
    expect(data.fileData).toBeNull()
  })

  it('KANARIEFÅGEL: hela commit-skrivningen bär inte personnumret någonstans', async () => {
    // Bredaste formen — den fäller även om PII:n dyker upp i en kolumn ingen
    // tänkt på. Serialiserar allt som skrivs, inte bara de fält vi granskat.
    const { service, prisma } = make()
    await service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1')

    const serialiserat = JSON.stringify(commitSkrivning(prisma))
    expect(serialiserat).not.toContain(PERSONNUMMER)
    expect(serialiserat).not.toContain('198501011234')
    expect(serialiserat).not.toContain(RAWTEXT)
  })

  it('confirmedData bär spåret, inte det råa DTO:t', async () => {
    const { service, prisma } = make()
    await service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1')

    const trail = commitSkrivning(prisma).data.confirmedData as {
      version: number
      unitId: string
      changedFields: unknown[]
    }
    expect(trail.version).toBe(1)
    expect(trail.unitId).toBe('unit-1')
    expect(Array.isArray(trail.changedFields)).toBe(true)
  })

  it('operatörens redigering syns i spåret', async () => {
    const { service, prisma } = make()
    await service.confirmRow('batch-1', 'row-1', 'org-1', 'user-1', {
      reviewedData: { monthlyRent: 13500 },
    })

    const trail = commitSkrivning(prisma).data.confirmedData as {
      changedFields: Array<{ field: string; from: unknown; to: unknown }>
    }
    expect(trail.changedFields).toContainEqual({ field: 'monthlyRent', from: 12000, to: 13500 })
  })
})

// ── 3. Villkoret som skulle ändra redovisningssvaret ────────────────────────

describe('VAKT: gallringen förutsätter att ingen verifikation hänvisar hit', () => {
  const SRC = join(__dirname, '..')

  function tsFiler(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return tsFiler(p)
      return e.isFile() && p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : []
    })
  }

  it('ingen kod som skriver JournalEntry refererar ContractImportRow', () => {
    // #471:s redovisningssvar vilar HELT på att ingen verifikation hänvisar till
    // stagingdatan. Ändras det ärver just den raden bevarandeplikt, och
    // gallringen ovan blir fel.
    //
    // Vakten fäller den dag någon kopplar ihop dem — i stället för att vi litar
    // på att ingen gör det. Den är medvetet bred: vilken fil som helst som
    // skapar en journalpost räknas, oavsett var den ligger.
    const skrivare = tsFiler(SRC).filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /journalEntry\s*\.\s*create|journalEntryLine\s*\.\s*create/.test(src)
    })

    // Kanariefågel för vakten själv: hittar den inga verifikationsskrivare alls
    // mäter den ingenting, och skulle vara grön för alltid.
    expect(skrivare.length).toBeGreaterThan(0)

    const trasslade = skrivare.filter((f) =>
      /ContractImportRow|contractImportRow/.test(readFileSync(f, 'utf8')),
    )
    expect(trasslade).toEqual([])
  })
})
