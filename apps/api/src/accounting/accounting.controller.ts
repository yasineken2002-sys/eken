import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { AccountingService } from './accounting.service'
import { AccountingPeriodService } from './accounting-period.service'
// Värde-import, inte `import type` — ValidationPipe behöver klassen i runtime.
import { ReopenPeriodDto } from './dto/reopen-period.dto'
import { ReverseEntryDto } from './dto/reverse-entry.dto'
// VÄRDE-import, aldrig `import type`: NestJS läser reflect-metadata i runtime och
// en typ-import raderar klassen, varpå ValidationPipe tappar all metadata.
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto'
import { CreateExpenseDto } from './dto/create-expense.dto'
import { CreateSupplierInvoiceDto, PaySupplierInvoiceDto } from './dto/supplier-invoice.dto'
import { SupplierInvoiceService } from './supplier-invoice.service'
import type { SupplierInvoiceStatus } from './supplier-invoice-status'
import { randomUUID } from 'crypto'

// Validerar ISO-datum (YYYY-MM-DD) från query. Kastar 400 vid saknat/felaktigt
// format så rapporterna aldrig kör mot ogiltiga Date-objekt (NaN-period).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function requireDate(value: string | undefined, field: string): string {
  if (!value || !DATE_RE.test(value)) {
    throw new BadRequestException(`${field} måste anges på formatet ÅÅÅÅ-MM-DD`)
  }
  // Formatregex släpper igenom kalenderorimliga datum (2026-02-30). JS koercerar
  // dem tyst (→ 2026-03-02) vilket skulle ge rapport för FEL period utan fel.
  // toISOString-rundtur fångar overflow: koercerat datum ≠ inmatad sträng.
  const parsed = new Date(value)
  if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} är inte ett giltigt kalenderdatum`)
  }
  return value
}

// Property-filter (valfritt) måste vara ett UUID om det anges — vi ekar inte
// godtyckliga strängar i svaret. Org-scopning sker i servicen.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function optionalUuid(value: string | undefined, field: string): string | undefined {
  if (value == null) return undefined
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${field} måste vara ett giltigt UUID`)
  }
  return value
}

// C1: att LÄSA bokföringen kräver en roll som arbetar i verksamheten — utan
// klassgrinden kunde VIEWER läsa hela verifikationsjournalen. MANAGER står med
// avsiktligt: en förvaltare får se bokföringen, men inte agera bindande i den.
// Den linjen dras per endpoint (close/reverse listar inte MANAGER), inte här.
// Klass-nivån täcker alla GET-routes och stänger ute VIEWER.
@Controller('accounting')
@UseGuards(JwtAuthGuard)
@Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
export class AccountingController {
  constructor(
    private readonly accountingService: AccountingService,
    private readonly supplierInvoices: SupplierInvoiceService,
    private readonly periods: AccountingPeriodService,
  ) {}

  @Get('accounts')
  async getAccounts(@OrgId() organizationId: string) {
    return this.accountingService.getAccounts(organizationId)
  }

  // ── Bokföringsperioder (T5 PR1a) ─────────────────────────────────────────
  // Gör den befintliga ClosedAccountingPeriod-mekanismen nåbar utanför AI-
  // assistenten. Ingen ny spärr: allocate() är fortsatt den enda punkt som
  // hindrar en bokföring i en stängd period.

  /** Översikt: vilka perioder är stängda, vilka är öppna, vad stängdes senast. */
  @Get('periods')
  async getPeriods(@OrgId() organizationId: string, @Query('months') months?: string) {
    const parsed = months != null ? Number(months) : undefined
    return this.periods.getOverview(
      organizationId,
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    )
  }

  /** Vad är ofullständigt i perioden? Visas innan operatören låser. */
  @Get('periods/:year/:month/precheck')
  async precheckPeriod(
    @OrgId() organizationId: string,
    @Param('year') year: string,
    @Param('month') month: string,
  ) {
    return this.periods.precheck(organizationId, Number(year), Number(month))
  }

  /**
   * Stänger perioden. MANAGER utesluts: att låsa en månad är en
   * redovisningshandling, inte förvaltning.
   *
   * Den avsikten fanns här hela tiden, men listan kunde inte uttrycka den förrän
   * R2 steg 2 — den hierarkiska guarden släppte in allt över den lägsta listade
   * rollen, alltså MANAGER, och `CLOSE_ROLES` i tjänsten fick bära spärren
   * ensam. Nu säger listan vad den gör: MANAGER nekas av grinden.
   *
   * Tjänstegrinden står ändå kvar (#194-mönstret). Den är inte överflödig bara
   * för att dekoratorn blivit ärlig: AI-vägen och framtida interna anropare når
   * `closePeriod` utan att passera någon dekorator alls.
   */
  @Post('periods/:year/:month/close')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  @HttpCode(200)
  async closePeriod(
    @OrgId() organizationId: string,
    @Param('year') year: string,
    @Param('month') month: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.periods.closePeriod(organizationId, Number(year), Number(month), {
      actorRole: user.role,
      actorUserId: user.sub,
    })
  }

  /**
   * Periodens historik + underlaget återöppningsdialogen behöver (momsperioder,
   * räkenskapsårsfönstret). Egen endpoint, inte påhängd på översikten — den ska
   * inte bära N händelser per period för en sida som listar tolv månader.
   *
   * ROLLGRINDEN ÄR MEDVETET KLASSNIVÅNS (minst ACCOUNTANT), inte OWNER-only som
   * själva återöppningen. Att LÄSA vad som hänt med en period är inte samma sak
   * som att få ändra det, och den som ska kunna stänga behöver kunna se varför
   * perioden öppnades. `reason` är fritext och kan nämna en enskild avi ("hyres-
   * avin för lgh 12") — men samma läsare når redan hela verifikationsjournalen
   * (`GET journal`) under samma grind, så historiken exponerar inget nytt.
   * VIEWER stängs ute av klassnivån.
   */
  @Get('periods/:year/:month/history')
  async getPeriodHistory(
    @OrgId() organizationId: string,
    @Param('year') year: string,
    @Param('month') month: string,
  ) {
    return this.periods.getDetail(organizationId, Number(year), Number(month))
  }

  /**
   * Öppnar en stängd period igen. OWNER-only — men dekoratorn är inte skyddet:
   * rollen, orsakskategorin, räkenskapsårsspärren och tillståndskontrollen
   * upprepas alla i tjänsten (fail-closed chokepunkt, #194-mönstret), så en
   * framtida intern anropare träffar samma grindar.
   *
   * ACCOUNTANT får stänga men INTE öppna: den som upptäcker behovet ska behöva
   * förklara det för den som bär bokföringsansvaret.
   */
  @Post('periods/:year/:month/reopen')
  @Roles('OWNER')
  @HttpCode(200)
  async reopenPeriod(
    @OrgId() organizationId: string,
    @Param('year') year: string,
    @Param('month') month: string,
    @Body() dto: ReopenPeriodDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.periods.reopenPeriod(organizationId, Number(year), Number(month), {
      actorRole: user.role,
      actorUserId: user.sub,
      reason: dto.reason,
      reasonCategory: dto.reasonCategory,
    })
  }

  // ── Årsstängning (#704 PR 2) ─────────────────────────────────────────────

  /**
   * Räkenskapsårens läge — underlaget till korten (#704 PR 3).
   *
   * KLASSNIVÅNS GRIND (minst ACCOUNTANT), inte ADMIN/OWNER som stängningen.
   * Att SE att ett år är stängt, när och med vilket verifikat är samma sorts
   * uppgift som periodöversikten redan visar under samma grind — och den som
   * inte får stänga behöver ändå kunna se varför en period inte går att öppna.
   * Svaret bär inga belopp; det föreslagna verifikatet ligger i
   * `close-preview`, som är grindad hårdare.
   */
  @Get('fiscal-years')
  async listFiscalYears(@OrgId() organizationId: string, @Query('years') years?: string) {
    const parsed = years != null ? Number(years) : undefined
    return this.periods.listFiscalYears(
      organizationId,
      Number.isFinite(parsed) ? (parsed as number) : undefined,
    )
  }

  /**
   * Vad skulle årsstängningen göra, och får den göras? Ren läsning.
   *
   * Klassnivåns grind (minst ACCOUNTANT) hade räckt för en LÄSNING, men
   * endpointen är medvetet grindad som stängningen själv. Skälet är inte
   * hemlighet utan förväxling: svaret innehåller det FÖRESLAGNA verifikatet rad
   * för rad, och en förhandsvisning som fler kan öppna än som kan bekräfta
   * inbjuder till att någon räknar på ett bokslut hen sedan inte får verkställa.
   */
  @Get('fiscal-years/:year/close-preview')
  @Roles('ADMIN', 'OWNER')
  async previewFiscalYearClose(@OrgId() organizationId: string, @Param('year') year: string) {
    return this.periods.previewFiscalYearClose(organizationId, Number(year))
  }

  /**
   * Stänger räkenskapsåret. OWNER/ADMIN — ACCOUNTANT får stänga en MÅNAD men
   * inte ett ÅR: en månad kan öppnas igen (spårat, av OWNER), ett år kan inte
   * öppnas alls. Det oåterkalleliga beslutet ligger hos den som bär ansvaret för
   * bokslutet.
   *
   * Dekoratorn är inte skyddet: `CLOSE_YEAR_ROLES` upprepas i tjänsten
   * (#194-mönstret), så en framtida intern anropare träffar samma grind utan att
   * passera någon dekorator.
   *
   * `now` skickas IN i tjänsten i stället för att läsas där. Stängningstidpunkten
   * är räkenskapsinformation som hamnar i både `FiscalYearClose.closedAt` och i
   * ögonblicksbilden, och en klocka som tjänsten läser själv går inte att styra
   * i ett prov — då blir tidsberoendet en flake i stället för en invariant.
   */
  @Post('fiscal-years/:year/close')
  @Roles('ADMIN', 'OWNER')
  @HttpCode(200)
  async closeFiscalYear(
    @OrgId() organizationId: string,
    @Param('year') year: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.periods.closeFiscalYear(organizationId, Number(year), new Date(), {
      actorRole: user.role,
      actorUserId: user.sub,
    })
  }

  @Post('accounts/seed')
  @Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
  async seedAccounts(@OrgId() organizationId: string) {
    await this.accountingService.seedDefaultAccounts(organizationId)
    return { message: 'Standardkonton skapade' }
  }

  @Get('journal')
  async getJournal(
    @OrgId() organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('source') source?: string,
  ) {
    return this.accountingService.getJournalEntries(organizationId, {
      ...(from != null ? { from } : {}),
      ...(to != null ? { to } : {}),
      ...(source != null ? { source } : {}),
    })
  }

  @Get('journal/:id')
  async getJournalEntry(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.accountingService.getJournalEntry(id, organizationId)
  }

  /**
   * RÄTTAR ett verifikat genom att bokföra dess motsats, daterad idag.
   *
   * Originalet rörs inte — det står kvar exakt som det bokfördes, och rättelsen
   * länkas till det. Rättelsen går genom `allocate` som all annan bokföring och
   * träffar därför periodspärren om innevarande period är stängd; det finns
   * ingen specialväg förbi låset.
   *
   * MANAGER utesluts: att bokföra en rättelse är en redovisningshandling, inte
   * förvaltning. Rättelsen är ett eget verifikat i huvudboken med förvaltarens
   * fritext som beskrivning — den syns i redovisningen för alltid.
   *
   * Samma historia som periodstängningen ovan: avsikten låg i `REVERSAL_ROLES`
   * tills R2 steg 2 gjorde det möjligt för listan att säga den själv.
   * Tjänstegrinden står kvar som andra lager.
   */
  @Post('journal/:id/reverse')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  @HttpCode(201)
  async reverseJournalEntry(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: ReverseEntryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.accountingService.reverseJournalEntry({
      entryId: id,
      organizationId,
      actorRole: user.role,
      actorUserId: user.sub,
      reason: dto.reason,
    })
  }

  // ── MANUELL BOKFÖRING: MÄNNISKANS VÄG ───────────────────────────────────
  //
  // De två rutterna nedan är motsvarigheten till AI-verktygen
  // `create_journal_entry` och `record_expense`, som stod i
  // `tool-human-path.baseline.json` som verktyg UTAN mänsklig väg: controllern
  // hade 17 rutter och ingen av dem skapade ett verifikat — bara
  // `journal/:id/reverse` — så AI:n kunde bokföra en verifikation hyresvärden
  // inte kunde bokföra själv.
  //
  // Konteringen är inte en parallell implementation: den byggs av de rena
  // funktionerna i `manual-entry.ts`, samma som AI-verktyget använder.
  // Skrivningen går ut i `createNumberedEntry`; AI-vägen har sin egen
  // transaktion, och den skillnaden står utskriven i manual-entry.ts.
  //
  // ROLLERNA: ACCOUNTANT och uppåt, alltså klassnivåns mängd minus MANAGER. Att
  // bokföra ett fritt verifikat är en redovisningshandling, inte en
  // förvaltningsåtgärd — samma avgränsning som `journal/:id/reverse` och
  // periodstängningen redan har.

  /**
   * Fritt verifikat. Balanskravet (debet = kredit) och kontouppslaget ligger i
   * tjänsten; ett obalanserat verifikat ger 422 med beloppen utskrivna, aldrig
   * ett tyst avrundat verifikat.
   *
   * `idempotencyKey` faller tillbaka på ett serverside-uuid när klienten inte
   * skickar någon. Det är AVSIKTLIGT inte ett fel: en anropare som inte kan göra
   * om sitt anrop ska få ett verifikat, inte ett 400. Webben skickar alltid en
   * nyckel per öppnad modal, så dess omtag är idempotenta.
   */
  @Post('journal-entries')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  @HttpCode(201)
  async createJournalEntry(
    @OrgId() organizationId: string,
    @Body() dto: CreateJournalEntryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.accountingService.createManualJournalEntry({
      organizationId,
      date: new Date(dto.date),
      description: dto.description,
      lines: dto.lines,
      idempotencyKey: dto.idempotencyKey ?? `manual-journal:${randomUUID()}`,
      createdById: user.sub,
      ...(dto.attachmentUrl ? { attachmentUrl: dto.attachmentUrl } : {}),
    })
  }

  /**
   * Utgift. `amount` är BRUTTO — det som lämnar 1930 — och `vatAmount` bryts UT
   * ur det. Kontering: kostnadskonto (netto) debet, 2641 (moms) debet om den
   * finns, 1930 kredit (brutto).
   */
  @Post('expenses')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  @HttpCode(201)
  async createExpense(
    @OrgId() organizationId: string,
    @Body() dto: CreateExpenseDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // Leverantören står i beskrivningen och inte i en relation: en
    // leverantörsmodell är ett eget arbete, och en halv sådan (fritextnamn i en
    // egen tabell utan orgnr, betalvillkor eller historik) hade varit sämre än
    // ingen alls.
    const beskrivning = dto.supplier ? `${dto.supplier} — ${dto.description}` : dto.description

    return this.accountingService.recordManualExpense({
      organizationId,
      date: new Date(dto.date),
      idempotencyKey: dto.idempotencyKey ?? `manual-expense:${randomUUID()}`,
      createdById: user.sub,
      ...(dto.attachmentUrl ? { attachmentUrl: dto.attachmentUrl } : {}),
      utgift: {
        belopp: dto.amount,
        ...(dto.vatAmount !== undefined ? { moms: dto.vatAmount } : {}),
        kontonummer: dto.accountNumber,
        beskrivning,
      },
    })
  }

  // ── LEVERANTÖRSSKULD (2440): FAKTURAMETODEN ─────────────────────────────
  //
  // "Registrera utgift" (#782) är KONTANTMETODEN — en redan betald utgift i ett
  // steg mot 1930. Rutterna nedan är fakturametoden: skulden bokas när fakturan
  // tas emot, och regleras när den betalas.
  //
  // Båda verifikaten går genom `createNumberedEntry`, samma chokepunkt som
  // människans fria verifikat och som AI-vägen sedan #792.
  //
  // ROLLERNA: ACCOUNTANT och uppåt, som de övriga bokföringsrutterna.

  @Post('supplier-invoices')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  @HttpCode(201)
  async createSupplierInvoice(
    @OrgId() organizationId: string,
    @Body() dto: CreateSupplierInvoiceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.supplierInvoices.create({
      organizationId,
      createdById: user.sub,
      supplierName: dto.supplierName,
      ...(dto.invoiceNumber ? { invoiceNumber: dto.invoiceNumber } : {}),
      description: dto.description,
      invoiceDate: new Date(dto.invoiceDate),
      dueDate: new Date(dto.dueDate),
      expenseAccount: dto.expenseAccount,
      totalAmount: dto.amount,
      vatRate: dto.vatRate,
      ...(dto.vatAmount !== undefined ? { vatAmount: dto.vatAmount } : {}),
      ...(dto.attachmentUrl ? { attachmentUrl: dto.attachmentUrl } : {}),
    })
  }

  /**
   * Öppna poster. `status` och `overdue` räknas i tjänsten, inte här och inte i
   * webben — ett beräknat tillstånd som räknas på tre ställen är tre svar.
   */
  @Get('supplier-invoices')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  async listSupplierInvoices(@OrgId() organizationId: string, @Query('status') status?: string) {
    const giltiga: SupplierInvoiceStatus[] = ['OPEN', 'PAID', 'CANCELLED']
    // Ett OKÄNT värde FÄLLER, det faller inte tillbaka på "visa allt". En tyst
    // reserv hade gett den som skrivit fel en komplett lista som SER filtrerad
    // ut — utfallet är då en obetald faktura som räknas som betald av den som
    // läser skärmen, inte ett fel någon kan se.
    if (status !== undefined && !giltiga.includes(status as SupplierInvoiceStatus)) {
      throw new BadRequestException(
        `Okänd status "${status}". Giltiga värden: ${giltiga.join(', ')}.`,
      )
    }
    return this.supplierInvoices.findAll(
      organizationId,
      status ? { status: status as SupplierInvoiceStatus } : undefined,
    )
  }

  @Post('supplier-invoices/:id/pay')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  @HttpCode(200)
  async paySupplierInvoice(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: PaySupplierInvoiceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.supplierInvoices.markPaid({
      organizationId,
      invoiceId: id,
      paidDate: new Date(dto.paidDate),
      createdById: user.sub,
    })
  }

  /**
   * Makulera en OBETALD faktura. Ett motverifikat bokförs som vänder
   * mottagningen — spärren mot att makulera en BETALD ligger i tjänsten och
   * inte här, därför att det är en redovisningsregel.
   */
  @Post('supplier-invoices/:id/cancel')
  @Roles('ACCOUNTANT', 'ADMIN', 'OWNER')
  @HttpCode(200)
  async cancelSupplierInvoice(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.supplierInvoices.cancel({
      organizationId,
      invoiceId: id,
      createdById: user.sub,
    })
  }

  // ── Finansiella rapporter ───────────────────────────────────────────────
  // Exponerar samma beräkning som AI-verktygen (en sanningskälla i
  // AccountingService). Klass-nivå @Roles gäller → minst ACCOUNTANT.

  @Get('reports/profit-loss')
  async getProfitLoss(
    @OrgId() organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('propertyId') propertyId?: string,
  ) {
    return this.accountingService.getProfitLossReport(
      organizationId,
      requireDate(from, 'from'),
      requireDate(to, 'to'),
      optionalUuid(propertyId, 'propertyId'),
    )
  }

  @Get('reports/balance-sheet')
  async getBalanceSheet(@OrgId() organizationId: string, @Query('asOf') asOf?: string) {
    return this.accountingService.getBalanceSheet(organizationId, requireDate(asOf, 'asOf'))
  }

  @Get('reports/vat')
  async getVatReport(
    @OrgId() organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.accountingService.getVatReport(
      organizationId,
      requireDate(from, 'from'),
      requireDate(to, 'to'),
    )
  }

  // @Res() utan passthrough är avsiktligt: vi styr svaret manuellt (octet-stream
  // + Content-Disposition). TransformInterceptor körs ej, men GlobalExceptionFilter
  // fångar fel innan reply.send() anropas (datum-/Prisma-fel → 400/500 som vanligt).
  @Get('reports/sie4')
  async exportSie4(
    @OrgId() organizationId: string,
    @Res() reply: FastifyReply,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    const fromDate = requireDate(from, 'from')
    const toDate = requireDate(to, 'to')
    const buffer = await this.accountingService.exportSie4(organizationId, fromDate, toDate)
    const filename = `bokforing-${fromDate}-${toDate}.se`
    void reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Content-Length', buffer.length)
      .send(buffer)
  }
}
