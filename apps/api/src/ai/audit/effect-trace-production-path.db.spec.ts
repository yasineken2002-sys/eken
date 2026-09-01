/**
 * EFFEKTSPÅRET SKRIVS AV PRODUKTIONSVÄGEN — mot riktig Postgres.
 *
 * ── VARFÖR DEN HÄR SPECEN BEHÖVDES ──────────────────────────────────────────
 *
 * `ai-effect-extension.spec.ts` heter *"effekterna PERSISTERAS som rader"*, men
 * den anropar `prisma.aiToolExecution.create(...)` DIREKT i testet. Den prövar
 * alltså att Prismas nästlade skrivning fungerar — inte att produktionsvägen
 * använder den. Det är inte en svag vakt; det är fel fråga.
 *
 * Uppmätt 2026-09-01: med det ENDA persisteringsstället bortkopplat
 * (`effects: { create: … }` struken ur `AiAuditService.logToolExecution`) var
 * `check-ai-tool-effects.mjs` grön, 27 riktade tester gröna och HELA sviten grön
 * — 338/338 sviter, 3478/3478 tester. Spåret var obevakat.
 *
 * ── VAD DEN HÄR SPECEN GÖR I STÄLLET ────────────────────────────────────────
 *
 * Kör `ToolExecutorService.executeTool` — den RIKTIGA metoden, inte en kopia av
 * dess innehåll — för ett riktigt verktyg mot en riktig databas, och kräver att
 * `AiToolEffect`-raderna finns efteråt och pekar på det som faktiskt skapades.
 *
 * Tjänsten instansieras via `Object.create` med bara de kollaboratörer
 * `create_journal_entry` rör (`prisma`, `verifikationsnummer`, `audit`). Skälet
 * är inte bekvämlighet: konstruktorn tar 24 beroenden, och att räkna upp dem
 * positionellt hade gjort specen röd av fel skäl så fort någon la till ett
 * tjugofemte. Metodkroppen som körs är produktionens.
 *
 * ── VARFÖR DEN POLLAR ───────────────────────────────────────────────────────
 *
 * `void this.audit.logToolExecution(...)` — fyra anropare, alla `void`. Skrivningen
 * inväntas inte, så det finns ingen punkt att `await`:a. Pollningen är inte
 * slarv; den är själva egenskapen synliggjord. Skulle spåret en dag bli
 * `TRANSAKTIONELL` kan väntan tas bort, och att den behövs i dag är precis vad
 * `traceIntegrity: 'BÄST_MÖJLIGA'` deklarerar.
 *
 * ── ANSVARSDELNING (utskriven i BÅDA filerna) ───────────────────────────────
 *
 * Den här specen äger MEKANIKEN: att vägen faktiskt skriver raden.
 * `check-effect-trace.mjs` äger PÅKOPPLINGEN: att alla anropare av
 * `logToolExecution` finns i en HÄRLEDD mängd och skickar med sina effekter, och
 * att persisteringsstället har kvar sin nästlade skrivning.
 */
import { randomUUID } from 'node:crypto'

// StorageService drar in @aws-sdk (ESM) som ts-jest inte transformerar, och den
// når hit bara via importkedjan tool-executor → invoices.service → pdf.service.
// Stubbarna rör INTE vägen som mäts: `create_journal_entry` använder enbart
// `prisma` och `verifikationsnummer`. Samma mönster som collections-role-gate.spec.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { PrismaService } from '../../common/prisma/prisma.service'
import { AiAuditService } from './ai-audit.service'
import { ToolExecutorService } from '../tools/tool-executor.service'
import { VerifikationsnummerService } from '../../accounting/verifikationsnummer.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    // Utan den här raden är filen grön av att den hoppades över.
    expect(HAR_DB).toBe(true)
  })
})

/** Hur länge vi väntar på en skrivning som ingen inväntar. */
const SPAR_DEADLINE_MS = 8_000

medDb('effektspåret skrivs av produktionsvägen', () => {
  let prisma: PrismaService
  let executor: ToolExecutorService
  let orgId: string
  let userId: string

  beforeAll(async () => {
    prisma = new PrismaService()
    const audit = new AiAuditService(prisma)
    const verifikationsnummer = new VerifikationsnummerService(prisma)

    // Produktionens metodkropp, med produktionens kollaboratörer för just den
    // här vägen. Se docblocket för varför inte konstruktorn.
    executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, { prisma, audit, verifikationsnummer })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `spar-${sfx}`,
        email: `spar-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `spar-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'S',
        lastName: 'P',
        role: 'OWNER',
      },
    })
    userId = user.id
    await prisma.account.createMany({
      data: [
        { organizationId: orgId, number: 1930, name: 'Bank', type: 'ASSET' },
        { organizationId: orgId, number: 3911, name: 'Hyresintäkt', type: 'REVENUE' },
      ],
    })
  })

  afterAll(async () => {
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: orgId } },
    })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })

    // STÄDNINGEN MÅSTE TÅLA EN SEN SKRIVNING — och det är egenskapen specen
    // mäter, sedd från andra hållet. `logToolExecution` anropas med `void`, så
    // den kan landa EFTER att testet tog slut. Raderas auditraden en gång kan
    // en försenad insert dyka upp efteråt, och `Organization`-raderingen faller
    // då på AiToolExecution_organizationId_fkey. Att i stället "sova en stund"
    // hade dolt precis det som är intressant.
    for (let försök = 1; ; försök++) {
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
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
   * Väntar tills spåret dykt upp, eller ger upp.
   *
   * ⚠️ POLLNINGEN MÅSTE OMFATTA SJÄLVA UPPSLAGET, inte bara effekterna. Första
   * versionen slog upp körningen med en vanlig `findMany` och pollade sedan på
   * dess id — och blev flakig, 4 röda av 5. Skälet är egenskapen som mäts:
   * auditraden skrivs `void`, så den finns inte nödvändigtvis när testet
   * frågar. Specen hade alltså samma antagande som produktionskoden gör om sitt
   * eget spår, och blev flakig av precis det.
   */
  const väntaPåSpår = async (toolName: string) => {
    const deadline = Date.now() + SPAR_DEADLINE_MS
    for (;;) {
      const rad = await prisma.aiToolExecution.findFirst({
        where: { organizationId: orgId, toolName },
        select: { id: true, effects: { select: { entityType: true, entityId: true } } },
      })
      if (rad) return rad
      if (Date.now() > deadline) return null
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  it('ett riktigt verktyg genom executeTool skriver BÅDE effekten och spåret', async () => {
    const beskrivning = `spårprov ${randomUUID().slice(0, 8)}`
    const resultat = await executor.executeTool(
      'create_journal_entry',
      {
        date: '2026-09-01',
        description: beskrivning,
        lines: [
          { accountNumber: 1930, debit: 100 },
          { accountNumber: 3911, credit: 100 },
        ],
      },
      orgId,
      userId,
      'OWNER',
      // Bindande verktyg kräver ett konsumerat anspråk (action-authorization.ts).
      { actionProof: { claimed: true } },
    )
    expect(resultat.success).toBe(true)

    // 1. EFFEKTEN skedde.
    const verifikat = await prisma.journalEntry.findFirst({
      where: { organizationId: orgId, description: beskrivning },
      select: { id: true },
    })
    expect(verifikat).not.toBeNull()

    // 2. SPÅRET finns — och det är det här som föll bort när persisteringen
    //    kopplades bort, utan att något annat i sviten märkte det.
    const spår = await väntaPåSpår('create_journal_entry')
    expect(spår).not.toBeNull()
    const körningar = await prisma.aiToolExecution.count({
      where: { organizationId: orgId, toolName: 'create_journal_entry' },
    })
    expect(körningar).toBe(1)

    // 3. Spåret pekar på det som FAKTISKT skapades, inte bara på "något".
    const träffar = spår!.effects.filter((e) => e.entityType === 'JournalEntry')
    expect(träffar.length).toBeGreaterThan(0)
    expect(träffar.map((e) => e.entityId)).toContain(verifikat!.id)
  })
})
