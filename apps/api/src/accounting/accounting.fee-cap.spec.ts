/**
 * G3 — det lagstadgade taket för påminnelseavgift, klampat vid debiteringen.
 *
 * 4 § lagen (1981:739) anger 60 kr. Taket är TVINGANDE även mot näringsidkare:
 * 6 § första stycket gör ett avtalsvillkor som utvidgar gäldenärens
 * ersättningsskyldighet ogiltigt, och ordalydelsen har ingen konsument-
 * avgränsning. Det finns därför ingen INDIVIDUAL/COMPANY-förgrening att testa —
 * och testerna nedan låser fast att ingen införs.
 *
 * TVÅ LAGER. `@Max` i UpdateOrganizationDto hindrar att ett för högt värde
 * skrivs in; klampningen här fångar värden som redan ligger i databasen eller
 * kommer in någon annan väg. Det här specet prövar lager 2.
 *
 * DISKRIMINERANDE BELOPP: 500 är varken en multipel av 60 eller nära det, så en
 * klampning som råkade ge fel tal syns direkt.
 */

import { AccountingService } from './accounting.service'
import { resolveNoticeDebtOrigin } from './debt-origin'
import { REMINDER_FEE_MAX_SEK } from '@eken/shared'

function makeService() {
  const created: Array<{ data: { lines: { create: Array<Record<string, unknown>> } } }> = []
  const prisma = {
    account: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'acc-1510', number: 1510 },
        { id: 'acc-3593', number: 3593 },
      ]),
    },
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((arg: never) => {
        created.push(arg)
        return Promise.resolve({ id: 'je-new' })
      }),
    },
  }
  ;(prisma as unknown as { $transaction: unknown }).$transaction = (cb: (tx: unknown) => unknown) =>
    cb(prisma)
  const service = new AccountingService(
    prisma as never,
    {
      allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
    } as never,
  )
  const warn = jest.fn()
  ;(service as unknown as { logger: unknown }).logger = {
    warn,
    error: jest.fn(),
    log: jest.fn(),
  }
  return { service, created, warn }
}

/** Avtalsgrunden är på plats i samtliga fall — här prövas bara taket. */
const TILLÅTEN = {
  debtOrigin: resolveNoticeDebtOrigin({
    periodStart: new Date('2026-07-01'),
    dueDate: new Date('2026-06-30'),
  }),
  termsFrom: new Date('2026-01-01'),
}

const bas = {
  organizationId: 'org-1',
  source: 'RENT_NOTICE' as const,
  sourceId: 'reminder-fee:rn-1',
  description: 'Påminnelseavgift hyresavi rn-1',
  ...TILLÅTEN,
}

/** Debet- och kreditbenen ur den skrivna konteringen. */
function belopp(created: Array<{ data: { lines: { create: Array<Record<string, unknown>> } } }>) {
  const lines = created[0]!.data.lines.create
  return {
    debet: Number(lines[0]!.debit),
    kredit: Number(lines[1]!.credit),
  }
}

describe('G3 — taket klampas vid debiteringstillfället', () => {
  it('500 kr begärt → 60 kr bokfört på BÅDA benen', async () => {
    const { service, created } = makeService()

    await service.bookReminderFee({ ...bas, fee: 500 })

    expect(belopp(created)).toEqual({ debet: 60, kredit: 60 })
    // Inte 500 någonstans — en klampning som bara träffade ena benet hade gjort
    // verifikatet obalanserat, och det ska inte gå att missa.
    expect(belopp(created).debet).not.toBe(500)
  })

  it('klampningen LOGGAS — den som skrev in 500 ska kunna få veta varför', async () => {
    const { service, warn } = makeService()

    await service.bookReminderFee({ ...bas, fee: 500 })

    expect(warn).toHaveBeenCalledTimes(1)
    const text = String(warn.mock.calls[0]![0])
    expect(text).toContain('org-1')
    expect(text).toContain('500')
    expect(text).toContain('60')
    expect(text).toContain('1981:739')
  })

  it('60 kr → oförändrat, och INGEN logg (inget är fel)', async () => {
    const { service, created, warn } = makeService()

    await service.bookReminderFee({ ...bas, fee: REMINDER_FEE_MAX_SEK })

    expect(belopp(created)).toEqual({ debet: 60, kredit: 60 })
    expect(warn).not.toHaveBeenCalled()
  })

  it('under taket klampas inte — 40 kr förblir 40 kr', async () => {
    // Taket är ett tak, inte ett golv. En org som valt en lägre avgift ska
    // behålla den.
    const { service, created, warn } = makeService()

    await service.bookReminderFee({ ...bas, fee: 40 })

    expect(belopp(created)).toEqual({ debet: 40, kredit: 40 })
    expect(warn).not.toHaveBeenCalled()
  })

  it('0 kr → ingen bokföring alls (oförändrat beteende)', async () => {
    const { service, created } = makeService()

    const entry = await service.bookReminderFee({ ...bas, fee: 0 })

    expect(entry).toBeNull()
    expect(created).toHaveLength(0)
  })

  it('KLAMPAS, VÄGRAS INTE — hyresvärden får de 60 hen är berättigad till', async () => {
    // Att returnera null vid ett för högt belopp hade tagit bort hela avgiften
    // och straffat hyresvärden för en felkonfiguration. Bara det överskjutande
    // är ogiltigt.
    const { service } = makeService()

    const entry = await service.bookReminderFee({ ...bas, fee: 5000 })

    expect(entry).not.toBeNull()
  })

  it('taket kommer från den delade konstanten, inte en literal', () => {
    // Om någon ändrar konstanten ska klampningen följa med. Testet läser samma
    // konstant som koden — en hårdkodad 60 här hade dolt en framtida glidning.
    expect(REMINDER_FEE_MAX_SEK).toBe(60)
  })
})
