/**
 * Avidentifieringens kärna — vad som FAKTISKT skrubbas, vad som FAKTISKT bevaras,
 * och att en andra körning inte gör något dumt.
 *
 * Testerna kör mot en tillståndsbärande fejk-transaktion i stället för
 * `jest.fn()`-attrapper som glömmer vad de skrivit. Det är avsiktligt:
 * idempotens går inte att bevisa mot en mock som inte minns det första anropet —
 * den skulle vara grön oavsett.
 */

import { anonymizeTenantWithin, maskedTenantEmail } from './anonymize-tenant'
import type { Prisma } from '@prisma/client'

const TENANT = 'aaaaaaaa-1111-2222-3333-444444444444'
const ORG = 'org-1'

interface FakeState {
  tenant: Record<string, unknown>
  sessions: { tenantId: string }[]
  keyHandovers: { tenantId: string; issuedToName: string | null }[]
  sentMessages: { tenantId: string; subject: string; content: string }[]
  logs: Record<string, unknown>[]
  /** Varje `data`-objekt som skickats till tenant.update, i ordning. */
  updates: Record<string, unknown>[]
}

function freshState(): FakeState {
  return {
    tenant: {
      id: TENANT,
      firstName: 'Anna',
      lastName: 'Andersson',
      companyName: null,
      email: 'anna@example.se',
      phone: '070-1234567',
      personalNumberEnc: 'CIPHERTEXT',
      personalNumberHash: 'BLINDINDEX',
      orgNumber: null,
      street: 'Storgatan 1',
      city: 'Göteborg',
      postalCode: '41100',
      contactPerson: 'Anna',
      passwordHash: '$2a$12$hash',
      portalActivated: true,
      activationTokenHash: 'tok',
      activationTokenExpiresAt: new Date('2026-01-01'),
      activationReminderSentAt: new Date('2026-01-01'),
      passwordResetTokenHash: 'rst',
      passwordResetTokenExpiresAt: new Date('2026-01-01'),
      anonymizedAt: null,
      ocrNumber: '00000000019',
    },
    sessions: [{ tenantId: TENANT }, { tenantId: TENANT }],
    keyHandovers: [
      { tenantId: TENANT, issuedToName: 'Sambo Svensson' },
      { tenantId: TENANT, issuedToName: null },
    ],
    sentMessages: [
      {
        tenantId: TENANT,
        subject: 'Anmaning om rättelse',
        content: 'Anna Andersson, 850101-1234, ombeds omedelbart upphöra med störningarna.',
      },
    ],
    logs: [],
    updates: [],
  }
}

/** Minimal men TILLSTÅNDSBÄRANDE Prisma-transaktion. */
function fakeTx(state: FakeState) {
  return {
    tenant: {
      findUniqueOrThrow: async () => ({ anonymizedAt: state.tenant.anonymizedAt }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        state.updates.push(data)
        Object.assign(state.tenant, data)
        return state.tenant
      },
    },
    tenantSession: {
      deleteMany: async ({ where }: { where: { tenantId: string } }) => {
        const before = state.sessions.length
        state.sessions = state.sessions.filter((s) => s.tenantId !== where.tenantId)
        return { count: before - state.sessions.length }
      },
    },
    keyHandover: {
      updateMany: async ({ where }: { where: { tenantId: string } }) => {
        let n = 0
        for (const k of state.keyHandovers) {
          if (k.tenantId === where.tenantId && k.issuedToName !== null) {
            k.issuedToName = null
            n++
          }
        }
        return { count: n }
      },
    },
    sentMessage: {
      updateMany: async () => {
        throw new Error(
          'sentMessage.updateMany anropades — SentMessage är ett uttryckligt undantag ' +
            'som väntar på juridisk bedömning.',
        )
      },
    },
    tenantAnonymizationLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.logs.push(data)
        return data
      },
    },
  } as unknown as Prisma.TransactionClient
}

const ACTOR = { performedById: 'user-1', ipAddress: '1.2.3.4', userAgent: 'jest' }

describe('avidentifiering — identifierande fält nollas', () => {
  it('nollar namn, kontaktuppgifter och maskerar e-posten', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.tenant.firstName).toBeNull()
    expect(state.tenant.lastName).toBeNull()
    expect(state.tenant.phone).toBeNull()
    expect(state.tenant.street).toBeNull()
    expect(state.tenant.city).toBeNull()
    expect(state.tenant.postalCode).toBeNull()
    expect(state.tenant.contactPerson).toBeNull()
    expect(state.tenant.companyName).toBe('Raderad hyresgäst')
    expect(state.tenant.email).toBe(maskedTenantEmail(TENANT))
    expect(state.tenant.email).not.toContain('anna')
  })

  it('nollar personnumret i BÅDA kolumnerna — chiffertext och blind-index', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.tenant.personalNumberEnc).toBeNull()
    // Blind-indexet är deterministiskt och jämförbart mellan rader. Lämnas det
    // kvar går personen att korrelera trots att chiffertexten är borta.
    expect(state.tenant.personalNumberHash).toBeNull()
  })

  it('river portal-inloggningen: credentials nollade och sessioner raderade', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.tenant.passwordHash).toBeNull()
    expect(state.tenant.activationTokenHash).toBeNull()
    expect(state.tenant.passwordResetTokenHash).toBeNull()
    expect(state.tenant.portalActivated).toBe(false)
    expect(state.sessions).toHaveLength(0)
  })

  it('skrubbar KeyHandover.issuedToName — fritextnamnet i angränsande tabell', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.keyHandovers.map((k) => k.issuedToName)).toEqual([null, null])
  })

  it('sätter anonymizedAt så att tillståndet blir läsbart', async () => {
    const state = freshState()
    const res = await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.tenant.anonymizedAt).toBeInstanceOf(Date)
    expect(res.performed).toBe(true)
    expect(res.anonymizedAt).toEqual(state.tenant.anonymizedAt)
  })
})

describe('avidentifiering — vad som med flit INTE rörs', () => {
  it('lämnar SentMessage orört (uttryckligt undantag, öppen juridisk fråga)', async () => {
    const state = freshState()
    // Fejken kastar om `sentMessage.updateMany` anropas. Skulle någon lägga till
    // en skrubb utan att först ha den juridiska bedömningen faller detta test.
    await expect(anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)).resolves.toBeDefined()

    expect(state.sentMessages[0]!.content).toContain('Anna Andersson')
    expect(state.sentMessages[0]!.subject).toBe('Anmaning om rättelse')
  })

  it('lämnar ocrNumber orört — mätt beslut, se GDPR-ärendet', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    // Nollningen skulle ta bort en kopia av N+1: RentNotice.ocrNumber är NOT NULL
    // och bär samma värde på varje avi. Kopplingen person→avier går dessutom via
    // tenantId, inte via OCR.
    expect(state.tenant.ocrNumber).toBe('00000000019')
  })
})

describe('KANARIEFÅGEL — avidentifieringen är idempotent', () => {
  it('två körningar ger samma sluttillstånd, inget fel och EN loggpost', async () => {
    const state = freshState()

    const first = await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)
    const afterFirst = JSON.parse(JSON.stringify(state.tenant)) as Record<string, unknown>

    // Andra körningen får inte kasta.
    const second = await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    // Samma sluttillstånd, fält för fält.
    expect(JSON.parse(JSON.stringify(state.tenant))).toEqual(afterFirst)

    // Exakt EN loggpost. En idempotent operation ska inte se ut som två
    // raderingsbegäranden i revisionsspåret.
    expect(state.logs).toHaveLength(1)

    // anonymizedAt behåller sin FÖRSTA tidpunkt.
    //
    // Att jämföra värdena räcker INTE. Båda körningarna ligger inom samma
    // millisekund, så `new Date()` ger samma tal och jämförelsen är grön även om
    // fältet skrivs om varje gång — uppmätt: negativkontrollen som alltid satte
    // `anonymizedAt` gav 11/11 gröna innan den här raden fanns.
    //
    // Vi mäter i stället att den andra skrivningen inte ens NÄMNER fältet.
    expect(state.updates).toHaveLength(2)
    expect(state.updates[0]).toHaveProperty('anonymizedAt')
    expect(Object.keys(state.updates[1]!)).not.toContain('anonymizedAt')
    expect(second.anonymizedAt).toEqual(first.anonymizedAt)

    // Och returvärdet skiljer fallen åt, så anroparen slipper gissa.
    expect(first.performed).toBe(true)
    expect(second.performed).toBe(false)
  })

  it('skrubbar ändå data som tillkommit EFTER den första körningen', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    // En ny nyckelkvittens med ett namn dyker upp efteråt.
    state.keyHandovers.push({ tenantId: TENANT, issuedToName: 'Ny Person' })

    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    // Idempotens betyder samma SLUTTILLSTÅND, inte "gör ingenting". En tidig
    // retur på anonymizedAt hade lämnat namnet kvar.
    expect(state.keyHandovers.every((k) => k.issuedToName === null)).toBe(true)
    expect(state.logs).toHaveLength(1)
  })
})

describe('revisionsspåret', () => {
  it('skriver aktör, org, mål och härkomst', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.logs[0]).toMatchObject({
      organizationId: ORG,
      tenantId: TENANT,
      performedById: 'user-1',
      ipAddress: '1.2.3.4',
      userAgent: 'jest',
    })
  })

  it('portalvägen loggas med performedById = null (hyresgästen själv)', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, { performedById: null })

    // Null är ett VÄRDE här, inte ett saknat fält: en logg som bara känner till
    // operatörsvägen ger fel svar på "har den här personen begärt radering?".
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0]!.performedById).toBeNull()
  })
})
