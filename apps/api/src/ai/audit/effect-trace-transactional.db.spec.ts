/**
 * `TRANSAKTIONELL` MÅSTE GÅ ATT SÄGA EMOT — mot riktig Postgres.
 *
 * ── VARFÖR ──────────────────────────────────────────────────────────────────
 *
 * `traceIntegrity` är ett DEKLARATIONSFÄLT, och ett deklarationsfält kan glida
 * från verkligheten. Gör det det är det prosa som ser ut som kod: en post kan
 * påstå `TRANSAKTIONELL` om ett spår som i själva verket skrivs efteråt, och
 * ingenting blir rött. Den nivån måste därför vara mekaniskt falsifierbar.
 *
 * PROVET: kör effekten i en transaktion som RULLAS TILLBAKA. Är spåret
 * transaktionellt försvinner det med effekten. Ligger det kvar var påståendet
 * falskt — och tvärtom, försvinner spåret medan effekten står kvar är det också
 * falskt.
 *
 * ── DEN TOMMA MÄNGDENS FÄLLA ────────────────────────────────────────────────
 *
 * I dag står ALLA 30 poster `BÄST_MÖJLIGA`, så loopen över TRANSAKTIONELL-poster
 * är TOM. En tom loop bevisar ingenting, och en spec som bara innehåller en tom
 * loop är grön för alltid — precis R5-defekten i check-action-tool-authorization.
 *
 * Därför bär den här filen en KANARIEFÅGEL som matar predikatet med dagens
 * verkliga mekanism och KRÄVER att den underkänns. Faller inte den mäter
 * loopen ingenting den dag någon skriver TRANSAKTIONELL.
 */
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../../common/prisma/prisma.service'
import { AiAuditService } from './ai-audit.service'
import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('traceIntegrity: TRANSAKTIONELL är falsifierbar', () => {
  let prisma: PrismaService
  let audit: AiAuditService
  let orgId: string
  let kontoId: string

  beforeAll(async () => {
    prisma = new PrismaService()
    audit = new AiAuditService(prisma)
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `tx-${sfx}`,
        email: `tx-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
    const konto = await prisma.account.create({
      data: { organizationId: orgId, number: 1930, name: 'Bank', type: 'ASSET' },
    })
    kontoId = konto.id
  })

  afterAll(async () => {
    for (let försök = 1; ; försök++) {
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
      await prisma.journalEntryLine.deleteMany({
        where: { journalEntry: { organizationId: orgId } },
      })
      await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
      await prisma.account.deleteMany({ where: { organizationId: orgId } })
      try {
        await prisma.organization.delete({ where: { id: orgId } })
        break
      } catch (err) {
        if (försök >= 5) throw err
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    await prisma.$disconnect()
  })

  /**
   * Predikatet. Skriver en effekt i en transaktion som rullas tillbaka, och
   * spåret på det sätt `skrivSpår` anger. Returnerar vad som ÖVERLEVDE.
   *
   * `TRANSAKTIONELL` kräver att BÅDA försvann — spåret ska dela effektens öde,
   * inte bara vara borta av en slump.
   */
  const provaRollback = async (
    skrivSpår: (tx: unknown, entityId: string, executionId: string) => Promise<void>,
  ) => {
    const executionId = randomUUID()
    let entityId = ''
    try {
      await prisma.$transaction(async (tx) => {
        const verifikat = await tx.journalEntry.create({
          data: {
            organizationId: orgId,
            date: new Date('2026-09-01'),
            description: `rollback-prov ${executionId.slice(0, 8)}`,
            source: 'AI',
            sourceId: `tx-prov:${executionId}`,
            series: 'A',
            verNumber: Math.floor(Math.random() * 1_000_000) + 500_000,
            fiscalYear: 2026,
            lines: { create: [{ accountId: kontoId, debit: 1 }] },
          },
        })
        entityId = verifikat.id
        await skrivSpår(tx, verifikat.id, executionId)
        // Rullar tillbaka HELA transaktionen. Effekten ska försvinna.
        throw new Error('AVSIKTLIG ROLLBACK')
      })
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'AVSIKTLIG ROLLBACK') throw err
    }
    const effektKvar = await prisma.journalEntry.findUnique({ where: { id: entityId } })
    const spårKvar = await prisma.aiToolEffect.findFirst({ where: { entityId } })
    return { effektKvar: effektKvar !== null, spårKvar: spårKvar !== null }
  }

  it('KANARIEFÅGEL: dagens mekanism är BEVISLIGEN INTE transaktionell', async () => {
    // Spåret skrivs som produktionen skriver det: via AiAuditService på den
    // ORDINARIE klienten, alltså utanför anroparens transaktion. Det är inte en
    // förenkling — `$extends` ser inte anroparens tx-klient, och det står
    // utskrivet i ai-effect-extension.ts.
    const utfall = await provaRollback(async (_tx, entityId, executionId) => {
      await audit.logToolExecution({
        id: executionId,
        organizationId: orgId,
        toolName: 'create_journal_entry',
        toolInput: {},
        success: true,
        durationMs: 1,
        effects: [{ entityType: 'JournalEntry', entityId, operation: 'CREATE', rowCount: 1 }],
      })
    })

    // Effekten rullades tillbaka …
    expect(utfall.effektKvar).toBe(false)
    // … men spåret står kvar och pekar på en rad som aldrig blev till.
    expect(utfall.spårKvar).toBe(true)

    // Alltså: predikatet UNDERKÄNNER dagens mekanism. Utan den här raden vore
    // loopen nedan grön av att den är tom.
    expect(utfall.effektKvar === false && utfall.spårKvar === false).toBe(false)
  })

  it('varje post som påstår TRANSAKTIONELL klarar rollback-provet', async () => {
    const påstår = Object.entries(EFFECT_DECLARATIONS)
      .filter(([, d]) => d.traceIntegrity === 'TRANSAKTIONELL')
      .map(([namn]) => namn)
      .sort()

    // LOOPEN ÄR INTE LÄNGRE TOM (steg 3b). Två verktyg skriver sitt spår inne i
    // sin EGEN transaktion via `AiAuditService.writeInTransaction`, och bara de.
    // Talet står här med flit: läggs ett tredje till utan att dess skrivväg
    // faktiskt är transaktionell faller provet nedan.
    expect(påstår).toEqual(['create_journal_entry', 'record_expense'])

    for (const namn of påstår) {
      const utfall = await provaRollback(async (tx, entityId, executionId) => {
        // EXAKT den väg verktyget använder — `writeInTransaction` på anroparens
        // tx, inte en kopia av dess innehåll.
        await audit.writeInTransaction(tx as Parameters<typeof audit.writeInTransaction>[0], {
          id: executionId,
          organizationId: orgId,
          toolName: namn,
          toolInput: {},
          effects: [{ entityType: 'JournalEntry', entityId, operation: 'CREATE', rowCount: 1 }],
        })
      })
      // BÅDA försvann. Att spåret står kvar och pekar på en rad som aldrig blev
      // till är värre än inget spår — det är ett revisionsspår som ljuger.
      expect({ verktyg: namn, ...utfall }).toEqual({
        verktyg: namn,
        effektKvar: false,
        spårKvar: false,
      })
    }
  })

  it('KANARIEFÅGEL: predikatet är fortfarande skarpt — det underkänner BÄST_MÖJLIGA', async () => {
    // Loopen ovan fylldes med två verktyg. Den får INTE tysta beviset att
    // predikatet kan säga emot: om `provaRollback` av något skäl slutade mäta
    // skulle båda testerna bli gröna, och den tomma loopens fälla vore tillbaka i
    // ny form. Den här raden binder samma predikat till ett utfall som MÅSTE
    // underkännas.
    const utfall = await provaRollback(async (_tx, entityId, executionId) => {
      await audit.logToolExecution({
        id: executionId,
        organizationId: orgId,
        toolName: 'compose_and_send_email',
        toolInput: {},
        success: true,
        durationMs: 1,
        effects: [{ entityType: 'JournalEntry', entityId, operation: 'CREATE', rowCount: 1 }],
      })
    })
    expect(utfall).toEqual({ effektKvar: false, spårKvar: true })
  })
})
