/**
 * Backupens färskhetslarm: larmar på ÅLDER, inte på fel.
 *
 * Formen speglar payment-freshness.service.spec.ts — rent `evaluate` testas
 * direkt, larmvägen genom tjänsten med dubblar.
 */

// @aws-sdk/client-s3 är ESM och kan inte parsas av jest-runtimen. Den dras in
// transitivt via backup.service — samma mock som backup.service.spec.ts har.
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = jest.fn()
  },
  PutObjectCommand: class {},
  ListObjectsV2Command: class {},
  DeleteObjectCommand: class {},
}))
jest.mock('@sentry/nestjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }))

import {
  BACKUP_MAX_AGE_DAYS,
  BackupFreshnessService,
  backupFreshnessMessage,
  evaluateBackupFreshness,
} from './backup-freshness.service'
import type { BackupFreshnessKind } from './backup-freshness.service'

const NU = new Date('2026-08-21T09:00:00Z')

/** En nyckel för en backup tagen N dygn före NU. */
function nyckel(dygnSedan: number): string {
  const d = new Date(NU.getTime() - dygnSedan * 24 * 60 * 60 * 1000)
  const stamp = d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `db-backups/eken-${stamp}.dump`
}

const IGÅR = nyckel(1)
const FÖRRFÖRRA = nyckel(3)

describe('evaluateBackupFreshness — de fyra utfallen', () => {
  const prodOK = { isProduction: true, productionBlockReason: null, now: NU }

  it('(a) FÖR GAMMAL → larm', () => {
    const v = evaluateBackupFreshness({ ...prodOK, keys: [FÖRRFÖRRA] })
    expect(v.alarm).toBe(true)
    expect(v.kind).toBe<BackupFreshnessKind>('stale')
    expect(v.ageDays).toBe(3)
    expect(v.thresholdDays).toBe(BACKUP_MAX_AGE_DAYS)
  })

  it('(b) INGEN BACKUP ALLS → larm', () => {
    const v = evaluateBackupFreshness({ ...prodOK, keys: [] })
    expect(v.alarm).toBe(true)
    expect(v.kind).toBe<BackupFreshnessKind>('never')
    expect(v.latestBackupAt).toBeNull()
    expect(v.backupCount).toBe(0)
  })

  it('(c) AVSTÄNGD/BLOCKERAD i produktion → larm', () => {
    const v = evaluateBackupFreshness({
      isProduction: true,
      productionBlockReason: 'BACKUP_ENABLED är inte satt till "true" — nattjobbet är avstängt',
      keys: [],
      now: NU,
    })
    expect(v.alarm).toBe(true)
    expect(v.kind).toBe<BackupFreshnessKind>('disabled')
    expect(v.blockReason).toContain('BACKUP_ENABLED')
  })

  it('(d) FÄRSK backup → TYST', () => {
    const v = evaluateBackupFreshness({ ...prodOK, keys: [IGÅR] })
    expect(v.alarm).toBe(false)
    expect(v.kind).toBe<BackupFreshnessKind>('fresh')
    expect(v.ageDays).toBe(1)
  })

  it('utanför produktion larmar den inte — avstängd backup är normalt i dev', () => {
    const v = evaluateBackupFreshness({
      isProduction: false,
      productionBlockReason: null,
      keys: [],
      now: NU,
    })
    expect(v.alarm).toBe(false)
    expect(v.kind).toBe<BackupFreshnessKind>('not-production')
  })

  it('AVSTÄNGD rapporteras som avstängd även när gamla dumpar finns kvar', () => {
    // Annars skickas mottagaren att leta efter ett fel i jobbet i stället för i
    // konfigurationen.
    const v = evaluateBackupFreshness({
      isProduction: true,
      productionBlockReason: 'isoleringsgrinden blockerar',
      keys: [FÖRRFÖRRA],
      now: NU,
    })
    expect(v.kind).toBe<BackupFreshnessKind>('disabled')
    expect(v.backupCount).toBe(1)
  })

  it('tröskeln tolererar EN missad natt, inte två', () => {
    expect(evaluateBackupFreshness({ ...prodOK, keys: [nyckel(1)] }).alarm).toBe(false)
    expect(evaluateBackupFreshness({ ...prodOK, keys: [nyckel(2)] }).alarm).toBe(true)
  })

  it('okända nyckelformat räknas inte som backuper', () => {
    const v = evaluateBackupFreshness({ ...prodOK, keys: ['db-backups/anteckning.txt'] })
    expect(v.kind).toBe<BackupFreshnessKind>('never')
    expect(v.backupCount).toBe(0)
  })

  it('nyaste nyckeln vinner, oavsett ordning i listan', () => {
    const v = evaluateBackupFreshness({ ...prodOK, keys: [FÖRRFÖRRA, IGÅR, nyckel(9)] })
    expect(v.kind).toBe<BackupFreshnessKind>('fresh')
    expect(v.backupCount).toBe(3)
  })
})

// ── KANARIEFÅGEL ─────────────────────────────────────────────────────────────
//
// De namngivna testerna ovan skyddar mot specifika återfall. De upptäcker inte
// att åldersjämförelsen gått blind — en `evaluate` som alltid svarar "färsk"
// gör dem röda en och en, men en som tappat EN av de tre larmande arterna kan
// annars passera tyst.
//
// Kanariefågeln matar in ett tillstånd per larmande art som MÅSTE ge larm, och
// kräver att VARJE art faktiskt larmar. Motparet kräver att det tysta fallet
// förblir tyst — ett larm som alltid larmar är samma defekt som inget larm,
// bara högre.
describe('KANARIEFÅGEL — larmet mäter fortfarande', () => {
  const MÅSTE_LARMA: Array<{
    kind: BackupFreshnessKind
    input: Parameters<typeof evaluateBackupFreshness>[0]
  }> = [
    {
      kind: 'stale',
      input: { isProduction: true, productionBlockReason: null, keys: [nyckel(30)], now: NU },
    },
    {
      kind: 'never',
      input: { isProduction: true, productionBlockReason: null, keys: [], now: NU },
    },
    {
      kind: 'disabled',
      input: {
        isProduction: true,
        productionBlockReason: 'nattjobbet är avstängt',
        keys: [],
        now: NU,
      },
    },
  ]

  it.each(MÅSTE_LARMA)('tillståndet "$kind" MÅSTE ge larm', ({ kind, input }) => {
    const v = evaluateBackupFreshness(input)
    expect(v.alarm).toBe(true)
    expect(v.kind).toBe(kind)
    // Och larmet måste kunna formuleras — ett larm utan text är inget larm.
    expect(backupFreshnessMessage(v)).toContain('LARM')
  })

  it('alla tre larmande arter täcks — antalet är poängen', () => {
    const arter = new Set(MÅSTE_LARMA.map((f) => evaluateBackupFreshness(f.input).kind))
    expect(arter).toEqual(new Set(['stale', 'never', 'disabled']))
    expect(arter.size).toBe(3)
  })

  it('och det TYSTA fallet förblir tyst (larmet fäller inte allt)', () => {
    const v = evaluateBackupFreshness({
      isProduction: true,
      productionBlockReason: null,
      keys: [IGÅR],
      now: NU,
    })
    expect(v.alarm).toBe(false)
    expect(backupFreshnessMessage(v)).not.toContain('LARM')
  })
})

describe('backupFreshnessMessage — antal och tidsstämplar, inget annat', () => {
  it('säger vilken art det är och vad man gör åt det', () => {
    const stale = backupFreshnessMessage(
      evaluateBackupFreshness({
        isProduction: true,
        productionBlockReason: null,
        keys: [FÖRRFÖRRA],
        now: NU,
      }),
    )
    expect(stale).toContain('3 dygn gammal')
    expect(stale).toContain('gränsen är 1 dygn')
    expect(stale).toContain('ett jobb som aldrig körs kan aldrig misslyckas')
  })

  it('namnger skälet när backupen är avstängd', () => {
    const msg = backupFreshnessMessage(
      evaluateBackupFreshness({
        isProduction: true,
        productionBlockReason: 'BACKUP_ENABLED är inte satt till "true" — nattjobbet är avstängt',
        keys: [],
        now: NU,
      }),
    )
    expect(msg).toContain('kör INTE i produktion')
    expect(msg).toContain('BACKUP_ENABLED')
    expect(msg).toContain('ingen dump alls')
  })

  it('läcker varken personuppgifter, hemligheter eller belopp', () => {
    const alla = (['stale', 'never', 'disabled', 'fresh'] as const).map((kind) =>
      backupFreshnessMessage(
        evaluateBackupFreshness({
          isProduction: true,
          productionBlockReason: kind === 'disabled' ? 'nattjobbet är avstängt' : null,
          keys:
            kind === 'never' || kind === 'disabled' ? [] : [kind === 'stale' ? FÖRRFÖRRA : IGÅR],
          now: NU,
        }),
      ),
    )
    for (const msg of alla) {
      // Inga kronbelopp, ingen e-post, inga nyckel-liknande strängar.
      expect(msg).not.toMatch(/\d+[\s,.]?\d*\s*kr\b/i)
      expect(msg).not.toMatch(/@/)
      expect(msg).not.toMatch(/secret|access[_-]?key|password|token=/i)
    }
  })
})

describe('BackupFreshnessService.check — larmar och loggar', () => {
  const Sentry = jest.requireMock('@sentry/nestjs') as { captureMessage: jest.Mock }

  function tjänst(
    backup: Partial<{
      isProduction: boolean
      productionBlockReason: string | null
      listBackups: () => Promise<Array<{ key: string }>>
    }>,
  ) {
    return new BackupFreshnessService({
      isProduction: true,
      productionBlockReason: null,
      listBackups: async () => [],
      ...backup,
    } as never)
  }

  beforeEach(() => Sentry.captureMessage.mockClear())

  it('larmar till Sentry när backupen är avstängd i produktion', async () => {
    const svc = tjänst({ productionBlockReason: 'nattjobbet är avstängt' })
    const v = await svc.check(NU)
    expect(v.alarm).toBe(true)
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
    expect(Sentry.captureMessage.mock.calls[0]![0]).toContain('LARM')
  })

  it('rör ALDRIG lagringen när backupen är blockerad — skälet får inte maskeras', async () => {
    const listBackups = jest.fn(async () => [])
    const svc = tjänst({ productionBlockReason: 'isoleringsgrinden blockerar', listBackups })
    await svc.check(NU)
    expect(listBackups).not.toHaveBeenCalled()
  })

  it('är TYST när en färsk backup finns', async () => {
    const svc = tjänst({ listBackups: async () => [{ key: IGÅR }] })
    const v = await svc.check(NU)
    expect(v.alarm).toBe(false)
    expect(Sentry.captureMessage).not.toHaveBeenCalled()
  })

  it('larmar en gång per dygn och art, inte en gång per körning', async () => {
    const svc = tjänst({ listBackups: async () => [] })
    await svc.check(NU)
    await svc.check(new Date(NU.getTime() + 60_000))
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)

    // Nytt dygn → nytt larm.
    await svc.check(new Date(NU.getTime() + 24 * 60 * 60 * 1000))
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2)
  })

  it('ett oläsbart lager är ett LARM, inte ett tyst hopp över', async () => {
    const svc = tjänst({
      listBackups: async () => {
        throw new Error('R2 nere')
      },
    })
    await expect(svc.check(NU)).rejects.toThrow('R2 nere')
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1)
    expect(Sentry.captureMessage.mock.calls[0]![0]).toContain('okänt läge är inte samma sak')
  })
})
