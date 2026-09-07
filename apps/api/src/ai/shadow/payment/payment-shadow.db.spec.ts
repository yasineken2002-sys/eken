/**
 * AGENT 2, ETAPP A — MOT RIKTIG POSTGRES.
 *
 * ── VARFÖR DET HÄR INTE GÅR ATT MOCKA ───────────────────────────────────────
 *
 * Tre av gaterna nedan handlar om vad DATABASEN gör, inte om vad koden säger:
 * det partiella unika indexet som gör två samtidiga körningar till ETT förslag,
 * org-avgränsningen som gör en annan organisations rader osynliga, och att ETT
 * godkännande ger EN journalpost. En attrapp returnerar det den blev tillsagd
 * oavsett `where`, så alla tre hade varit gröna även med avgränsningen borta —
 * det är CLAUDE.md:s "en ATTRAPP kan inte pröva den FÖR GROVA riktningen".
 *
 * ── MODELLEN ANROPAS ALDRIG HÄR ─────────────────────────────────────────────
 *
 * Två vägar används, och båda är äkta:
 *
 *   utan kandidater   `provaKandidater` svarar INGEN och producenten skriver
 *                     förslaget UTAN ett modellanrop. Det är produktionsvägen,
 *                     inte en genväg — de deterministiska reglerna går före.
 *   med kandidater    `frågaModellen` ersätts på INSTANSEN med ett fast svar.
 *                     Nätverk hör inte hemma i ett db-prov, och det som mäts är
 *                     vad som SKRIVS när ett svar kommit — inte att det kom.
 *
 * ── RIGGEN SKAPAR SINA EGNA FÖRUTSÄTTNINGAR ─────────────────────────────────
 *
 * Ingen `findFirst` mot omgivningens data. Allt skapas här och städas i
 * FK-riktning, så att två körningar mot samma databas ger samma svar — provad,
 * inte antagen (#612).
 */
import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient, RentNoticeType } from '@prisma/client'

import { PaymentShadowService } from './payment-shadow.service'
import { PaymentOutcomeService } from './payment-outcome.service'
import { INGEN_AVI, OKAND_MOTPART, SKUGGKALLA_BANKRAD } from './payment-fields'

const Decimal = Prisma.Decimal
const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

function klient(): PrismaClient {
  const u = new URL(process.env.DATABASE_URL as string)
  u.searchParams.set('connection_limit', '10')
  return new PrismaClient({ datasources: { db: { url: u.toString() } } })
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('agent 2 — skuggförslag på omatchade betalningar', () => {
  let prisma: PrismaClient
  let service: PaymentShadowService
  let facit: PaymentOutcomeService
  let orgId: string
  let annanOrgId: string
  let tenantId: string
  let leaseId: string
  let räknare = 0
  const utfall: Record<string, unknown> = {}

  async function skapaOrg(prefix: string): Promise<string> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `${prefix}-${sfx}`,
        email: `${prefix}-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'Stockholm',
        orgNumber: `5560${sfx.slice(0, 6)}`,
        fiscalYearStartMonth: 1,
        shadowPaymentAgentEnabled: true,
      },
      select: { id: true },
    })
    return org.id
  }

  beforeAll(async () => {
    prisma = klient()
    orgId = await skapaOrg('a2')
    annanOrgId = await skapaOrg('a2-annan')

    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Anna',
        lastName: 'Lindqvist',
        email: `t-${randomUUID().slice(0, 8)}@example.se`,
      },
      select: { id: true },
    })
    tenantId = tenant.id

    const sfx = randomUUID().slice(0, 8)
    const prop = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `p-${sfx}`,
        propertyDesignation: `A2 ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: prop.id,
        name: `Lgh ${sfx}`,
        unitNumber: `1-${sfx}`,
        type: 'APARTMENT',
        rooms: 2,
        area: 55,
        monthlyRent: 8450,
        status: 'OCCUPIED',
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: orgId,
        unitId: unit.id,
        tenantId,
        contractNumber: `HK-${sfx}`,
        monthlyRent: 8450,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    leaseId = lease.id

    facit = new PaymentOutcomeService(prisma as never)
    service = new PaymentShadowService(
      prisma as never,
      { logUsage: async () => undefined } as never,
      { checkOrgDailyCostCap: async () => undefined } as never,
    )
  })

  afterEach(async () => {
    for (const org of [orgId, annanOrgId]) {
      await prisma.aiAssignment.deleteMany({ where: { organizationId: org } })
      await prisma.bankTransaction.deleteMany({ where: { organizationId: org } })
      await prisma.rentNotice.deleteMany({ where: { organizationId: org } })
    }
  })

  afterAll(async () => {
    // I FK-RIKTNING. Tenant har barn i RentNotice/AiAssignment, och de är redan
    // borta av afterEach — men ordningen står här ändå, eftersom en rigg som
    // städar i fel ordning ser ut att fungera tills någon lägger till en rad.
    for (const org of [orgId, annanOrgId]) {
      await prisma.aiAssignment.deleteMany({ where: { organizationId: org } })
      await prisma.bankTransaction.deleteMany({ where: { organizationId: org } })
      await prisma.rentNotice.deleteMany({ where: { organizationId: org } })
      await prisma.lease.deleteMany({ where: { organizationId: org } })
      await prisma.tenant.deleteMany({ where: { organizationId: org } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: org } } })
      await prisma.property.deleteMany({ where: { organizationId: org } })
      await prisma.tenantOcrSequence.deleteMany({ where: { organizationId: org } })
      await prisma.rentNoticeNumberSequence.deleteMany({ where: { organizationId: org } })
      await prisma.organization.deleteMany({ where: { id: org } })
    }
    console.warn(`[agent2] utfall: ${JSON.stringify(utfall, null, 1)}`)
    await prisma.$disconnect()
  })

  async function avi(opts: {
    ocr: string
    belopp: number
    org?: string
    tenant?: string
  }): Promise<string> {
    const nr = ++räknare
    const rad = await prisma.rentNotice.create({
      data: {
        organizationId: opts.org ?? orgId,
        tenantId: opts.tenant ?? tenantId,
        leaseId,
        noticeNumber: `A-${randomUUID().slice(0, 6)}-${nr}`,
        ocrNumber: opts.ocr,
        month: ((nr - 1) % 12) + 1,
        year: 2026,
        amount: opts.belopp,
        totalAmount: opts.belopp,
        dueDate: new Date(Date.UTC(2026, (nr - 1) % 12, 27)),
        status: 'SENT',
        collectionStage: 'NONE',
        type: RentNoticeType.RENT,
      },
      select: { id: true },
    })
    return rad.id
  }

  async function bankrad(opts: {
    belopp: number
    text?: string
    ocr?: string | null
    org?: string
  }): Promise<string> {
    const rad = await prisma.bankTransaction.create({
      data: {
        organizationId: opts.org ?? orgId,
        date: new Date('2026-09-02'),
        description: opts.text ?? 'BG INBETALNING',
        amount: new Decimal(opts.belopp),
        ...(opts.ocr ? { rawOcr: opts.ocr } : {}),
      },
      select: { id: true },
    })
    return rad.id
  }

  function förslagFör(txId: string, org = orgId) {
    return prisma.aiAssignment.findMany({
      where: { organizationId: org, sourceKind: SKUGGKALLA_BANKRAD, sourceId: txId },
    })
  }

  // ── GATE 1 ────────────────────────────────────────────────────────────────
  it('en omatchad rad utan kandidater ger ETT förslag med prediction INGEN', async () => {
    const tx = await bankrad({ belopp: 4312, text: 'INBETALNING NORDISK SERVICE AB' })
    const r = await service.korForBankrad(orgId, tx)
    expect(r.utfall).toBe('SKAPAD')

    const rader = await förslagFör(tx)
    expect(rader).toHaveLength(1)
    const p = rader[0]!
    expect(p.kind).toBe('PAYMENT_MATCH_PROPOSAL')
    expect(p.shadow).toBe(true)
    expect((p.prediction as Record<string, unknown>)['avi']).toBe(INGEN_AVI)
    expect((p.prediction as Record<string, unknown>)['motpart']).toBe(OKAND_MOTPART)
    // KONSEKVENSTEXTEN SÄGER ATT INGENTING UTFÖRS. Ett godkännande av ett
    // "ingen avi passar" är ett medhåll, inte en handling.
    expect(p.consequence).toContain('Ingenting utförs')
    utfall['gate1_utan_kandidater'] = { utfall: r.utfall, rader: rader.length }
  })

  // ── GATE 1, NEGATIVKONTROLL ───────────────────────────────────────────────
  it('NEGATIVKONTROLL: med flaggan AV skrivs inget förslag', async () => {
    await prisma.organization.update({
      where: { id: orgId },
      data: { shadowPaymentAgentEnabled: false },
    })
    const tx = await bankrad({ belopp: 4312, text: 'INBETALNING NORDISK SERVICE AB' })
    const r = await service.korForBankrad(orgId, tx)
    await prisma.organization.update({
      where: { id: orgId },
      data: { shadowPaymentAgentEnabled: true },
    })

    expect(r.utfall).toBe('AVSTANGD')
    expect(await förslagFör(tx)).toHaveLength(0)
    utfall['gate1_neg_flagga_av'] = r.utfall
  })

  // ── GATE 2 ────────────────────────────────────────────────────────────────
  it('exakt OCR där beloppet ryms ger INGET förslag — automatiken tar raden', async () => {
    await avi({ ocr: '10000000018', belopp: 8450 })
    const tx = await bankrad({ belopp: 8450, ocr: '10000000018' })
    const r = await service.korForBankrad(orgId, tx)

    expect(r.utfall).toBe('INGEN_FRAGA')
    expect(await förslagFör(tx)).toHaveLength(0)
    utfall['gate2_exakt_ocr'] = r.utfall
  })

  // ── GATE 2, NEGATIVKONTROLL ───────────────────────────────────────────────
  it('NEGATIVKONTROLL: exakt OCR men DUBBELT belopp ger ändå ett förslag', async () => {
    // DEN LAGNING MÄTKORPUSEN AVSLÖJADE. En dubbelbetalning bär ett KORREKT
    // OCR. Den första versionen av regeln svarade "automatiken tar den" och
    // föreslog aldrig något — trots att avstämningen avvisar en överbetalning
    // och raden blir UNMATCHED. Utfallet hade varit tystnad med pengar på
    // kontot, vilket är den värsta av de tre möjliga.
    await avi({ ocr: '10000000026', belopp: 9200 })
    const tx = await bankrad({ belopp: 18400, ocr: '10000000026' })
    ;(service as unknown as Record<string, unknown>)['frågaModellen'] = async () => ({
      avi: INGEN_AVI,
      confidence: 0.8,
      reasoning: 'Beloppet är dubbla det utestående.',
    })
    const r = await service.korForBankrad(orgId, tx)
    delete (service as unknown as Record<string, unknown>)['frågaModellen']

    expect(r.utfall).toBe('SKAPAD')
    expect(await förslagFör(tx)).toHaveLength(1)
    utfall['gate2_neg_dubbelbetalning'] = r.utfall
  })

  // ── GATE 3 ────────────────────────────────────────────────────────────────
  it('samma rad två gånger ger ETT förslag — det partiella unika indexet håller', async () => {
    const tx = await bankrad({ belopp: 4312, text: 'INBETALNING OKAND AB' })
    const a = await service.korForBankrad(orgId, tx)
    const b = await service.korForBankrad(orgId, tx)

    expect(a.utfall).toBe('SKAPAD')
    expect(b.utfall).toBe('REDAN_FINNS')
    expect(await förslagFör(tx)).toHaveLength(1)
    utfall['gate3_idempotens'] = { första: a.utfall, andra: b.utfall }
  })

  // ── GATE 3, NEGATIVKONTROLL ───────────────────────────────────────────────
  it('NEGATIVKONTROLL: TVÅ olika rader ger TVÅ förslag', async () => {
    // DEN FÖR GROVA RIKTNINGEN. Utan det här provet hade en avgränsning som
    // tappat `sourceId` sett ut som en fungerande idempotens: det andra
    // förslaget hade avvisats som en dubblett, och gate 3 varit grön.
    const tx1 = await bankrad({ belopp: 4312, text: 'INBETALNING A' })
    const tx2 = await bankrad({ belopp: 5555, text: 'INBETALNING B' })
    await service.korForBankrad(orgId, tx1)
    await service.korForBankrad(orgId, tx2)

    expect(await förslagFör(tx1)).toHaveLength(1)
    expect(await förslagFör(tx2)).toHaveLength(1)
    const alla = await prisma.aiAssignment.count({
      where: { organizationId: orgId, sourceKind: SKUGGKALLA_BANKRAD },
    })
    expect(alla).toBe(2)
    utfall['gate3_neg_tva_rader'] = alla
  })

  // ── GATE 4 ────────────────────────────────────────────────────────────────
  it('en annan organisations rad syns inte', async () => {
    const tx = await bankrad({ belopp: 4312, org: annanOrgId, text: 'INBETALNING X' })
    const r = await service.korForBankrad(orgId, tx)

    expect(r.utfall).toBe('SAKNAS')
    expect(await förslagFör(tx, annanOrgId)).toHaveLength(0)
    utfall['gate4_org'] = r.utfall
  })

  // ── GATE 4, NEGATIVKONTROLL ───────────────────────────────────────────────
  it('NEGATIVKONTROLL: samma rad under RÄTT org ger ett förslag', async () => {
    const tx = await bankrad({ belopp: 4312, org: annanOrgId, text: 'INBETALNING X' })
    const r = await service.korForBankrad(annanOrgId, tx)

    expect(r.utfall).toBe('SKAPAD')
    expect(await förslagFör(tx, annanOrgId)).toHaveLength(1)
    utfall['gate4_neg_ratt_org'] = r.utfall
  })

  // ── GATE 5 ────────────────────────────────────────────────────────────────
  it('en redan MATCHAD rad ger inget förslag', async () => {
    const tx = await bankrad({ belopp: 4312, text: 'INBETALNING OKAND' })
    await prisma.bankTransaction.update({ where: { id: tx }, data: { status: 'MATCHED' } })
    const r = await service.korForBankrad(orgId, tx)

    expect(r.utfall).toBe('INGEN_FRAGA')
    expect(await förslagFör(tx)).toHaveLength(0)
    utfall['gate5_matchad'] = r.utfall
  })

  // ── GATE 5, NEGATIVKONTROLL ───────────────────────────────────────────────
  it('NEGATIVKONTROLL: en människas AVMATCHNING stoppar också förslaget', async () => {
    const tx = await bankrad({ belopp: 4312, text: 'INBETALNING OKAND' })
    await prisma.bankTransaction.update({
      where: { id: tx },
      data: { autoMatchExcludedAt: new Date() },
    })
    const r = await service.korForBankrad(orgId, tx)

    expect(r.utfall).toBe('INGEN_FRAGA')
    expect(r.detalj).toContain('avmatchat')
    expect(await förslagFör(tx)).toHaveLength(0)
    utfall['gate5_neg_avmatchad'] = r.detalj
  })

  // ── FACIT ─────────────────────────────────────────────────────────────────
  it('facit skrivs, och en hävning NOLLSTÄLLER det i stället för att skriva INGEN', async () => {
    const aviId = await avi({ ocr: '10000000034', belopp: 7150 })
    const tx = await bankrad({ belopp: 4312, text: 'INBETALNING OKAND' })
    await service.korForBankrad(orgId, tx)

    await facit.skrivFacitMatchad(
      orgId,
      tx,
      { id: aviId, utestaende: 7150, motpartId: tenantId },
      7150,
    )
    const efterMatch = (await förslagFör(tx))[0]!
    expect((efterMatch.outcome as Record<string, unknown>)['avi']).toBe(aviId)
    expect((efterMatch.outcome as Record<string, unknown>)['belopp']).toBe('FULL')
    expect(efterMatch.outcomeAt).not.toBeNull()

    await facit.nollstallFacit(orgId, tx)
    const efterHävning = (await förslagFör(tx))[0]!
    // NOLLSTÄLLT, INTE `INGEN`. En hävning säger att den förra matchningen var
    // fel — den säger ingenting om vad som var rätt. Att skriva INGEN hade
    // räknat ett okänt svar som ett facit.
    expect(efterHävning.outcome).toBeNull()
    expect(efterHävning.outcomeAt).toBeNull()
    utfall['facit'] = { skrivet: aviId, efterHavning: efterHävning.outcome }
  })

  it('en DELBETALNING blir belopp: DEL i facit', async () => {
    // NEGATIVKONTROLL MOT `beloppsutfall`: samma post, mindre belopp, annat
    // svar. Utan den mäter facit bara att fältet skrivs.
    const aviId = await avi({ ocr: '10000000042', belopp: 11300 })
    const tx = await bankrad({ belopp: 4312, text: 'INBETALNING OKAND' })
    await service.korForBankrad(orgId, tx)
    await facit.skrivFacitMatchad(
      orgId,
      tx,
      { id: aviId, utestaende: 11300, motpartId: tenantId },
      6000,
    )
    const rad = (await förslagFör(tx))[0]!
    expect((rad.outcome as Record<string, unknown>)['belopp']).toBe('DEL')
    utfall['facit_del'] = 'DEL'
  })

  it('facitskrivningen är en NO-OP när ingen skuggrad finns', async () => {
    // NORMALFALLET, och det ska inte kasta: flaggan är av för nästan alla
    // organisationer, så `manualMatch` anropar det här utan att någon rad
    // finns. En kastande no-op hade rullat tillbaka en bokföring.
    const tx = await bankrad({ belopp: 999, text: 'INGEN SKUGGRAD' })
    await expect(
      facit.skrivFacitMatchad(orgId, tx, { id: 'x', utestaende: 1, motpartId: null }, 1),
    ).resolves.toBeUndefined()
    await expect(facit.nollstallFacit(orgId, tx)).resolves.toBeUndefined()
    utfall['facit_noop'] = 'ok'
  })
})
