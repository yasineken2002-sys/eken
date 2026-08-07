import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import JSZip from 'jszip'
import { PrismaService } from '../common/prisma/prisma.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'
import { buildBrandedPdfHtml, escapeHtml, getLogoDataUrl } from '../common/branding'
import { DEFAULT_BRAND_COLOR, INVOICE_TRANSITIONS, isValidTransition } from '@eken/shared'
import type { InvoiceStatus } from '@eken/shared'
import { UserRole } from '@prisma/client'
import { assertMayActOnCollections } from '../common/authz/collections-authz'
import { csvCell } from '../common/csv/csv-cell'
import { computeInvoiceDebt, type InvoiceDebt } from '../invoices/invoice-debt'

/**
 * Inkassoexporten är ett av få ställen där personnumret verkligen behövs i
 * klartext — inkassobolaget måste kunna identifiera gäldenären. Selecten väljer
 * därför `personalNumberEnc` EXPLICIT ovanpå SAFE_TENANT_SELECT (som medvetet
 * inte bär personnumret) och dekrypterar först vid utskriften.
 */
const COLLECTION_TENANT_SELECT = {
  ...SAFE_TENANT_SELECT,
  personalNumberEnc: true,
} as const satisfies Prisma.TenantSelect

type InvoiceWithCollectionData = Prisma.InvoiceGetPayload<{
  include: {
    tenant: { select: typeof COLLECTION_TENANT_SELECT }
    customer: true
    organization: true
    paymentReminders: { orderBy: { sentAt: 'asc' } }
    lines: true
    lease: { include: { unit: { include: { property: true } } } }
    payments: { orderBy: { paidAt: 'asc' } }
  }
}>

/**
 * #307 PR 2b — DE STATUSAR EN FAKTURA FÅR LÄMNAS TILL INKASSO IFRÅN.
 *
 * HÄRLEDD ur `INVOICE_TRANSITIONS`, inte handskriven. Hela poängen med PR 2b är
 * att den här vägen slutade kringgå statusmaskinen: den skrev `SENT_TO_COLLECTION`
 * från VILKEN status som helst utom PAID/VOID (`notIn`-guarden), och `grep
 * isValidTransition apps/api/src/collections/` gav noll träffar. En handskriven
 * `in ['PARTIAL','OVERDUE']` hade bara bytt ut en lista mot en annan — samma
 * fel, snyggare stavat. Listan MÅSTE komma ur tabellen, annars kan de två glida
 * isär igen (jfr den duplicerade `csvCell` i #317).
 *
 * Idag: `['PARTIAL', 'OVERDUE']`. Låst av ett test, så en framtida utvidgning av
 * `INVOICE_TRANSITIONS` inte tyst öppnar inkassodörren från fler statusar.
 */
export const COLLECTION_SOURCE_STATUSES: InvoiceStatus[] = (
  Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]
).filter((from) => isValidTransition(from, 'SENT_TO_COLLECTION'))

export interface CollectionExportResult {
  invoiceId: string
  invoiceNumber: string
  pdfKey: string
  csvKey: string
  pdfUrl: string
  csvUrl: string
}

@Injectable()
export class CollectionExportService {
  private readonly logger = new Logger(CollectionExportService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly pn: PersonalNumberService,
    private readonly pdf: PdfService,
    private readonly storage: StorageService,
    private readonly pdfQueue: PdfQueue,
  ) {}

  /**
   * Köar inkassoexport för EN faktura. PDF-renderingen sker i PdfWorker
   * (exportForInvoice) — HTTP-svaret returneras direkt med jobb-id.
   */
  async enqueueExportForInvoice(
    invoiceId: string,
    organizationId: string,
    actorRole?: UserRole,
  ): Promise<{ jobId: string }> {
    // Grinden ligger HÄR, inte i controllern: dekoratorns hierarki kan inte
    // uttrycka "ACCOUNTANT men inte MANAGER". Se common/authz/collections-authz.ts.
    assertMayActOnCollections(actorRole, 'exportera underlag till inkasso')
    const jobId = await this.pdfQueue.enqueue({
      kind: 'collections-export',
      organizationId,
      invoiceId,
    })
    return { jobId }
  }

  /**
   * Köar bulk-inkassoexport (en samlad ZIP). Hela ZIP-bygget — N PDF-
   * renderingar — sker i PdfWorker (exportBulk) i ett enda jobb.
   */
  async enqueueBulkExport(
    invoiceIds: string[],
    organizationId: string,
    actorRole?: UserRole,
  ): Promise<{ jobId: string }> {
    assertMayActOnCollections(actorRole, 'bulk-exportera underlag till inkasso')
    const jobId = await this.pdfQueue.enqueue({
      kind: 'collections-bulk-export',
      organizationId,
      invoiceIds,
    })
    return { jobId }
  }

  /**
   * Genererar inkassounderlag (PDF + CSV) för EN faktura. Markerar fakturan
   * som SENT_TO_COLLECTION och pausar automatiska påminnelser så Eveno inte
   * tävlar med inkassobolaget om kommunikation till hyresgästen.
   */
  async exportForInvoice(
    invoiceId: string,
    organizationId: string,
  ): Promise<CollectionExportResult> {
    const invoice = await this.loadInvoice(invoiceId, organizationId)

    // ── #307: CLAIMA FÖRST, GÖR I/O EFTERÅT ────────────────────────────────
    //
    // Ordningen var tvärtom: läs status → generera PDF → ladda upp till R2 →
    // skriv status blint. Mellan läsningen och skrivningen låg SEKUNDER av
    // verkligt I/O (Puppeteer + två R2-uppladdningar, den senare med
    // requestTimeout 15 s × 2 försök). Hann fakturan bli betald i det fönstret
    // skrevs PAID över med SENT_TO_COLLECTION — och en hyresgäst fick kravbrev
    // för något de redan betalat.
    //
    // Det är inte ett vanligt race: PAID är TERMINAL i INVOICE_TRANSITIONS
    // (`PAID: []`). Skrivningen reverserade alltså en terminal status, vilket
    // ingen annan statusskrivare i kodbasen gör.
    //
    // (Motsatt riktning — betalning EFTER export — är inget fel och behöver
    // ingen spärr: SENT_TO_COLLECTION → PAID är en giltig övergång och statusen
    // ingår i PAYABLE_STATUSES. En hyresgäst som betalar direkt till
    // hyresvärden trots inkassokrav ska kunna registreras.)
    //
    // Claimen nedan är atomisk och status-guardad, och den gör fönstret till en
    // enda DB-transaktion. Den tar INGET radlås med flit — ett lås som hålls
    // under extern I/O vore en DoS-yta (samma skäl som att `send()` genererar
    // PDF utanför sin transaktion, verifierat i #302). En status-guardad
    // updateMany är självserialiserande och behöver inget lås.
    await this.claimForExport(
      invoice.id,
      organizationId,
      invoice.invoiceNumber,
      invoice.status,
      'Skickad till inkasso',
      this.outstandingFor(invoice),
    )

    // Först HÄR börjar det dyra arbetet. Misslyckades claimen har vi redan
    // kastat — ingen PDF genererad, ingen InvoiceEvent skriven.
    const pdfBuffer = await this.pdf.generateFromHtml(await this.buildPdfHtml(invoice))
    const csvBuffer = Buffer.from(this.buildCsv([invoice]), 'utf8')

    const date = new Date().toISOString().slice(0, 10)
    const safeNumber = invoice.invoiceNumber.replace(/[^\w-]/g, '_')
    const pdfKey = `collections/${organizationId}/${date}/inkasso-${safeNumber}.pdf`
    const csvKey = `collections/${organizationId}/${date}/inkasso-${safeNumber}.csv`

    const [pdfUrl, csvUrl] = await Promise.all([
      this.storage.uploadFile(pdfBuffer, pdfKey, 'application/pdf'),
      this.storage.uploadFile(csvBuffer, csvKey, 'text/csv'),
    ])

    // Statusen är redan satt av claimen ovan. Kvar är bara att peka ut filen —
    // nyckeln kan inte vara känd före uppladdningen, så den skrivs här.
    //
    // Att claimen ligger före betyder att en faktura kan stå SENT_TO_COLLECTION
    // med collectionExportKey = null om R2 fallerar efter claimen. Det är den
    // avsiktliga sidan av avvägningen: alternativet vore ett inkassokrav
    // uppladdat för en faktura som hunnit bli betald. En omkörning läker
    // tillståndet — claimen ser då SENT_TO_COLLECTION, hoppar över
    // statusskrivningen (ingen andra DEBT_COLLECTION-händelse) och fyller i
    // nyckeln.
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { collectionExportKey: pdfKey },
    })

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      pdfKey,
      csvKey,
      pdfUrl,
      csvUrl,
    }
  }

  /**
   * Skapar en samlad ZIP med PDF + CSV för flera fakturor i ett svep.
   * Används av "Skicka till inkasso (bulk)"-knappen.
   */
  async exportBulk(
    invoiceIds: string[],
    organizationId: string,
  ): Promise<{
    zipKey: string
    zipUrl: string
    count: number
    /** #307: fakturor som inte kunde claimas — med skälet, så operatören ser vilka. */
    skipped: Array<{ invoiceNumber: string; reason: string }>
  }> {
    if (invoiceIds.length === 0) {
      throw new BadRequestException('Inga fakturor angivna')
    }
    const laddade = await Promise.all(invoiceIds.map((id) => this.loadInvoice(id, organizationId)))

    // ── #307: CLAIMA VARJE FAKTURA FÖRE ZIP-BYGGET ─────────────────────────
    //
    // Två fel stängs här, och bara det ena är ett race:
    //
    // 1) STALE-LÄSNINGEN. Statuskontrollen låg tidigare i skriv-transaktionen
    //    längst ned och itererade de objekt som lästes FÖRE zip-bygget.
    //    Transaktionen gav atomicitet åt skrivningarna men läste aldrig om
    //    statusen — den skyddade alltså inte mot att en faktura hann bli betald
    //    under de N PDF-renderingarna. Claimen nedan läser om, i databasen.
    //
    // 2) ZIP:EN FILTRERADE INTE ALLS. Loopen renderade en PDF för VARJE begärd
    //    faktura, oavsett status. En betald eller makulerad faktura fick alltså
    //    ett fullständigt inkassokrav i den ZIP som skickas till
    //    inkassobolaget — helt utan samtidighet inblandad. Skrivloopen hoppade
    //    över den, så fakturan såg orörd ut i systemet medan kravet ändå låg i
    //    batchen. Nu kommer bara claimade fakturor in i ZIP:en.
    //
    // En faktura som inte kan claimas HOPPAS ÖVER — bulk får inte fällas för
    // att en av tjugo hann bli betald. De överhoppade returneras i `skipped`.
    //
    // ⚠️ `skipped` NÅR INTE OPERATÖREN ÄNNU. Bulk-exporten körs av PdfWorker via
    // Bull-kön, och workern kastar returvärdet — det finns ingen jobb-status-
    // endpoint som förmedlar det vidare. Fältet är alltså korrekt ifyllt men
    // osynligt i produktionsvägen. Det är en känd lucka (#307 följdpunkt), inte
    // ett löfte som infrias idag: skriv inte UI mot `skipped` förrän kö-vägen
    // kan leverera det.
    const invoices: InvoiceWithCollectionData[] = []
    const skipped: Array<{ invoiceNumber: string; reason: string }> = []
    for (const inv of laddade) {
      // ── #352 PR 2: DEPOSITIONER SVEPS INTE MED I EN BATCH ─────────────────
      //
      // Invändningen gäller verktygets NATUR, inte listans längd. Bulk-vägen är
      // byggd för att svepa, och en operatör som bockar "markera alla" har inte
      // tagit ställning till just den här depositionen. En inkasso-överlämning
      // av en deposition ska vara ett uttryckligt beslut per fall — hyresgästen
      // bor kvar och relationen pågår. (FAR-granskat, #352.)
      //
      // VÄGEN FINNS KVAR. `POST /collections/export/:invoiceId`, `mark-sent` och
      // AI-verktygen (som kräver dubbelbekräftelse) är ORÖRDA — en människa som
      // pekar ut precis den här fakturan kan fortfarande lämna den till inkasso.
      // Det är skillnaden mellan att stänga en genväg och att ta bort en
      // möjlighet.
      //
      // KONTROLLEN LIGGER FÖRE `claimForExport` med flit: claimen skriver
      // SENT_TO_COLLECTION och pausar påminnelser. Hoppade vi över fakturan
      // efteråt vore den redan överlämnad i systemets ögon utan att ha kommit
      // med i ZIP:en.
      if (inv.type === 'DEPOSIT') {
        skipped.push({
          invoiceNumber: inv.invoiceNumber,
          reason:
            'Depositionsfordran kräver enskild bedömning — exkluderad ur bulk-export. ' +
            'Använd export för enskild faktura.',
        })
        continue
      }
      try {
        await this.claimForExport(
          inv.id,
          organizationId,
          inv.invoiceNumber,
          inv.status,
          'Skickad till inkasso (bulk)',
          this.outstandingFor(inv),
        )
        invoices.push(inv)
      } catch (err) {
        if (err instanceof BadRequestException || err instanceof ConflictException) {
          skipped.push({ invoiceNumber: inv.invoiceNumber, reason: err.message })
          continue
        }
        throw err
      }
    }

    if (invoices.length === 0) {
      throw new BadRequestException(
        'Ingen av de valda fakturorna kunde exporteras — samtliga är betalda, makulerade ' +
          'eller ändrades under exporten. Inget underlag skapades.',
      )
    }

    const zip = new JSZip()
    for (const invoice of invoices) {
      const safeNumber = invoice.invoiceNumber.replace(/[^\w-]/g, '_')
      const pdfBuffer = await this.pdf.generateFromHtml(await this.buildPdfHtml(invoice))
      zip.file(`${safeNumber}/inkasso-${safeNumber}.pdf`, pdfBuffer)
    }
    // Samlad CSV med alla fakturor — många inkassobolag (Visma Collectors,
    // Intrum, Lindorff) tar emot batch-import som CSV.
    zip.file('inkasso-batch.csv', this.buildCsv(invoices))

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    const date = new Date().toISOString().slice(0, 10)
    const zipKey = `collections/${organizationId}/${date}/inkasso-batch-${Date.now()}.zip`
    const zipUrl = await this.storage.uploadFile(zipBuffer, zipKey, 'application/zip')

    // Statusen är redan claimad per faktura ovan; här pekas bara filen ut.
    // Ingen statuskontroll behövs — `invoices` innehåller per konstruktion bara
    // de som claimades, och nyckeln kan inte vara känd före uppladdningen.
    await this.prisma.$transaction(async (tx) => {
      for (const inv of invoices) {
        await tx.invoice.update({
          where: { id: inv.id },
          data: { collectionExportKey: zipKey },
        })
      }
    })

    return { zipKey, zipUrl, count: invoices.length, skipped }
  }

  /**
   * Manuell markering — fastighetsägaren har skickat fakturan till sitt
   * inkassobolag genom externt system (t.ex. Vismas portal). Vi pausar
   * påminnelser och loggar att det är gjort.
   */
  /**
   * BOKFÖR INGENTING. Fordran finns kvar — den drivs bara in av någon annan.
   * En eventuell nedskrivning/konstaterad kundförlust bokförs separat och
   * senare, i RentBadDebtService. Metoden sätter status, pausar påminnelser och
   * skriver ett append-only InvoiceEvent.
   *
   * ── #315 / #307 PR 2b: ALLT LIGGER I EN TRANSAKTION ──────────────────────
   *
   * Metoden gjorde tidigare `findFirst` → statuskontroll → skuldgrind →
   * `update` → `invoiceEvent.create`, allt som fristående anrop utan
   * transaktion, utan status-guard och utan `count`-kontroll. Två fel i ett:
   *
   *   1. TOCTOU. En betalning som landade mellan läsningen och skrivningen fick
   *      sin status överskriven. `PAID` är TERMINAL (`INVOICE_TRANSITIONS.PAID
   *      = []`), så skrivningen reverserade en terminal status — samma fel som
   *      #311 stängde i exportvägarna, bara med ett kortare fönster.
   *   2. Statusskrivningen och händelseskrivningen var inte atomiska mot
   *      varandra. Föll den andra stod fakturan `SENT_TO_COLLECTION` utan spår
   *      av VARFÖR — i den logg som är själva behandlingshistoriken.
   *
   * ── ORDNINGEN, I EN FÖLJD (#307 C) ────────────────────────────────────────
   *
   * Vägen fick aldrig ett eget avsnitt när den härdades, trots att ordningen är
   * hela poängen. Den står här för att vara läsbar utan att pusslas ihop:
   *
   *   1. `$transaction` — allt nedan är atomiskt eller inget av det.
   *   2. `SELECT … FOR UPDATE` på fakturaraden — FÖRST, före varje läsning som
   *      ska fatta ett beslut om raden.
   *   3. Statusgrinden (`transitionBlockReason`) — ur statusmaskinen, inte en
   *      handskriven lista (#307 PR 2b).
   *   4. Skuldberäkningen INNANFÖR låset: `invoicePayment.findMany` →
   *      `computeInvoiceDebt` → `debtBlockReason`. Ingen skuld, inget krav (#318).
   *   5. `updateMany` med `COLLECTION_SOURCE_STATUSES` i WHERE — en TILLÅTLISTA
   *      härledd ur `INVOICE_TRANSITIONS`, aldrig en förbudslista.
   *
   * SKULDBERÄKNINGEN LIGGER INNANFÖR TRANSAKTIONEN OCH INNANFÖR LÅSET. Låg den
   * utanför kunde en betalning landa mellan grinden och skrivningen och grinden
   * hade uttalat sig om ett inaktuellt saldo. (Samma läxa som #288 drog i
   * `markAsPaidManually`.)
   *
   * RADLÅS HÄR, MEN INTE I `claimForExport`. Skillnaden är avsiktlig: den här
   * vägen gör INGEN extern I/O — ingen Puppeteer, ingen R2-uppladdning — så
   * DoS-invändningen som förbjuder ett lås där gäller inte här. Låset är
   * dessutom det som gör läsningen av `InvoicePayment` genuint samtidig med
   * skrivningen. Vägen rör BARA `Invoice`, så ingen låsordning kan vändas
   * (#296/#298/#299).
   *
   * Av de fem grindade handlingarna är detta den ENDA som är en genuint manuell
   * användarhandling — export/bulk-export körs av workern och loggas som
   * SYSTEM. Den skrev tidigare actorType USER men lämnade actorId tomt, så
   * loggen sa "en människa gjorde detta" utan att säga vem. Det är precis den
   * fråga som ställs först om en hyresgäst bestrider en inkassoöverlämning.
   * actorId trådas därför in från den inloggade aktören.
   */
  async markSentToCollection(
    invoiceId: string,
    organizationId: string,
    note?: string,
    actorRole?: UserRole,
    actorId?: string,
  ): Promise<{ id: string; status: 'SENT_TO_COLLECTION' }> {
    assertMayActOnCollections(actorRole, 'markera som skickad till inkasso')

    await this.prisma.$transaction(async (tx) => {
      // Radlås FÖRST — serialiserar mot markAsPaidManually och bankvägens
      // claimPaidWithinTx, som båda tar FOR UPDATE på samma rad.
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} AND "organizationId" = ${organizationId} FOR UPDATE`

      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, organizationId },
        select: { id: true, status: true, invoiceNumber: true, total: true },
      })
      if (!invoice) throw new NotFoundException('Faktura hittades inte')

      // #307 PR 2b: SAMMA statusregel som exportvägarna, ur statusmaskinen.
      // Tidigare stod här enbart `status === 'PAID' || 'VOID'` — ett utkast
      // eller en ännu inte förfallen faktura kunde alltså markeras som
      // överlämnad till inkasso.
      const transitionBlocked = this.transitionBlockReason(invoice.invoiceNumber, invoice.status)
      if (transitionBlocked) throw new BadRequestException(transitionBlocked)

      // ── #307 PR3: SAMMA SKULDGRIND SOM EXPORTVÄGARNA ─────────────────────
      //
      // Den här vägen genererar inget underlag, men den gör samma BINDANDE sak:
      // markerar fordran som överlämnad till inkasso, pausar påminnelser och
      // skriver en permanent DEBT_COLLECTION-post. Utan grinden kan en operatör
      // låsa den posten på en faktura som ekonomiskt redan är reglerad —
      // statusen släpar bara efter. Påpekat av FAR i granskningen av PR 2a.
      //
      // Betalningarna laddas separat: den här metoden använder en enkel
      // findFirst (inte loadInvoice), och ska inte dra in hela PDF-underlaget
      // för en statusmarkering.
      const payments = await tx.invoicePayment.findMany({
        where: { invoiceId },
        select: { amount: true },
      })
      const debt = computeInvoiceDebt({
        total: invoice.total,
        allocations: payments.map((p) => p.amount),
      })
      const debtBlocked = this.debtBlockReason(invoice.invoiceNumber, debt)
      if (debtBlocked) throw new BadRequestException(debtBlocked)

      const now = new Date()
      const claim = await tx.invoice.updateMany({
        where: { id: invoiceId, organizationId, status: { in: COLLECTION_SOURCE_STATUSES } },
        data: {
          status: 'SENT_TO_COLLECTION',
          sentToCollectionAt: now,
          remindersPaused: true,
          remindersPausedAt: now,
          // NOTEN, inte en generisk sträng. Operatörens egen formulering är det
          // enda som säger VARFÖR påminnelserna pausades, och den ska överleva
          // in i `remindersPausedReason` (uttryckligt krav i #315).
          remindersPausedReason: note ?? 'Skickad till externt inkassobolag',
        },
      })
      // SÄKERHETSNÄT, INTE EN AKTIV KODVÄG. Grenen är onåbar så länge alla
      // Invoice-statusskrivare tar `FOR UPDATE` på raden (markAsPaidManually,
      // claimPaidWithinTx, transitionStatus och den här): grinden ovan läser då
      // samma låsta rad som claimen skriver, inom samma transaktion, och de kan
      // inte divergera. Den står kvar ändå — `markSentToCollection` VAR själv en
      // sådan blind skrivare fram till #315, så "en framtida skrivare glömmer
      // disciplinen" är inte hypotetiskt. Utan guarden blir det en tyst
      // datakorruption i stället för ett fel. (FAR-granskning av PR 2b.)
      //
      // ⚠️ #307 C — LÅSDISCIPLIN ÄR INTE STATUSDISCIPLIN. Påståendet ovan höll,
      // och räckte ändå inte. De tre betalningsskrivarna TOG sitt lås (eller fick
      // ett i C) — men skrev fel status innanför det: en delbetalning mot en
      // inkassofaktura flippade `SENT_TO_COLLECTION → PARTIAL` utan att röra
      // `remindersPaused`/`sentToCollectionAt`. `claim.count` såg inget fel,
      // eftersom raden aldrig ändrades av någon ANNAN transaktion — den ändrades
      // korrekt serialiserat till fel värde. Guarden nedan skyddar mot samtidighet,
      // inte mot en skrivare som är ensam och har fel. Rätt status är därför härledd
      // ur en delad källa (`invoice-payment-status.ts`), inte bevakad här.
      if (claim.count === 0) {
        throw new ConflictException(
          `Faktura ${invoice.invoiceNumber} ändrades under markeringen — den är nu betald, ` +
            'makulerad eller redan överlämnad. Ingen markering gjordes. Uppdatera sidan och ' +
            'kontrollera fakturan innan du försöker igen.',
        )
      }

      // SAMMA transaktion som claimen. DEBT_COLLECTION är append-only (BFL 5 kap
      // 6–9 §): den får varken skrivas utan en lyckad claim eller utebli efter en.
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          type: 'DEBT_COLLECTION',
          actorType: 'USER',
          ...(actorId ? { actorId } : {}),
          actorLabel: 'Manuell markering',
          payload: note ? { note } : {},
        },
      })
    })

    // SKRIVER INGEN `collectionExportKey`. Den manuella markeringen betyder att
    // överlämningen skett i ett EXTERNT system (Vismas portal e.d.) — det finns
    // inget underlag i vår lagring att peka på, och en påhittad nyckel vore
    // värre än ingen (#315).
    return { id: invoiceId, status: 'SENT_TO_COLLECTION' }
  }

  // ── Privata hjälpare ─────────────────────────────────────────────────────

  /**
   * #307: EN beräkning av restskulden för hela exporten — grinden, PDF-kravboxen
   * och CSV-kolumnen. Skulle de kunna divergera vore grinden meningslös: en
   * faktura kunde nekas på en siffra och exporteras på en annan.
   */
  private outstandingFor(invoice: InvoiceWithCollectionData): InvoiceDebt {
    return computeInvoiceDebt({
      total: invoice.total,
      allocations: invoice.payments.map((p) => p.amount),
    })
  }

  /**
   * #307 PR3: skälet en faktura inte får lämnas till inkasso, eller null om den
   * får det. Skiljer REGLERAD från ÖVERBETALD med flit — de kräver olika
   * åtgärd av operatören, och ett gemensamt "hela beloppet är betalt" hade
   * pekat åt fel håll i det andra fallet (då finns pengar att betala tillbaka,
   * inte bara en status att rätta).
   */
  private debtBlockReason(invoiceNumber: string, debt: InvoiceDebt): string | null {
    if (debt.claim.isNegative()) {
      return (
        `Faktura ${invoiceNumber} är ÖVERBETALD — mer är inbetalt än fakturerat. Inget ` +
        'inkassounderlag skapades. Kontrollera om mellanskillnaden ska återbetalas eller ' +
        'avräknas mot en annan faktura.'
      )
    }
    if (debt.outstanding.lte(0)) {
      return (
        `Faktura ${invoiceNumber} har ingen kvarstående skuld — hela beloppet är betalt. ` +
        'Inget inkassounderlag skapades. Kontrollera om fakturans status behöver rättas ' +
        'till betald.'
      )
    }
    return null
  }

  /**
   * #307 PR 2b: skälet en faktura inte får GÅ ÖVER till `SENT_TO_COLLECTION`
   * från sin nuvarande status, eller null om den får det.
   *
   * REGELN ÄR DELAD MELLAN BÅDA VÄGARNA (exportvägarna och den manuella
   * markeringen). Mekaniken skiljer sig av dokumenterade skäl — den ena tar
   * radlås, den andra inte; den ena skriver en SYSTEM-händelse, den andra en
   * USER-händelse — men VILKA statusar som får lämnas över får inte kunna
   * skilja sig åt. Det var precis så `csvCell` gled isär i #317.
   *
   * Verdikten kommer ur `isValidTransition`; switchen nedan väljer bara ORDEN.
   * Ett generiskt "ogiltig statusövergång DRAFT → SENT_TO_COLLECTION" hade varit
   * korrekt och obegripligt för en operatör som bara vill veta varför knappen
   * inte gör något.
   */
  private transitionBlockReason(invoiceNumber: string, from: InvoiceStatus): string | null {
    if (isValidTransition(from, 'SENT_TO_COLLECTION')) return null
    switch (from) {
      case 'PAID':
      case 'VOID':
        return 'Kan inte skapa inkassounderlag för betald eller makulerad faktura'
      case 'SENT_TO_COLLECTION':
        // Exportvägarna når aldrig hit — de behandlar det här som idempotens och
        // fyller bara i underlagsnyckeln. Den MANUELLA markeringen har inget
        // underlag att fylla i, så där är en andra markering ingen omkörning
        // utan en dubblett: den hade skrivit en ANDRA permanent
        // DEBT_COLLECTION-post för samma överlämning i en append-only-logg
        // (BFL 5 kap 6–9 §).
        return (
          `Faktura ${invoiceNumber} är redan överlämnad till inkasso. Ingen ny markering ` +
          'gjordes — överlämningen finns redan i fakturans händelselogg.'
        )
      case 'DRAFT':
        return (
          `Faktura ${invoiceNumber} är ett UTKAST och har aldrig skickats till mottagaren. ` +
          'En faktura som gäldenären aldrig fått kan inte lämnas till inkasso — skicka ' +
          'fakturan först.'
        )
      case 'SENT':
        return (
          `Faktura ${invoiceNumber} är utskickad men ännu inte markerad som förfallen. ` +
          'Inkassoöverlämning kräver att förfallodagen passerat; markeringen sker ' +
          'automatiskt kl. 09:00. Vänta till dess, eller registrera betalningen om ' +
          'fakturan redan är delvis reglerad.'
        )
      default:
        // Fail-closed: en framtida status utan egen gren nekas, inte släpps in.
        return `Faktura ${invoiceNumber} kan inte lämnas till inkasso från status ${from}.`
    }
  }

  /**
   * #307 — ATOMISK, STATUS-GUARDAD CLAIM AV `SENT_TO_COLLECTION`.
   *
   * Speglar `markAsPaidManually`/`claimPaidWithinTx`: `updateMany` med en
   * status-guard i WHERE, och `count === 0` betyder att någon hann före.
   * Skillnaden mot dem är att den här vägen medvetet INTE tar något radlås —
   * anroparen gör sekunder av extern I/O efteråt, och ett lås som hålls under
   * den tiden vore en DoS-yta. En status-guardad updateMany behöver inget lås:
   * villkoret utvärderas atomiskt av databasen vid skrivögonblicket.
   *
   * Claimen OCH händelsen skrivs i samma transaktion. `DEBT_COLLECTION` är
   * append-only och får aldrig raderas (BFL 5 kap 6–9 §) — en felaktig post på
   * en betald faktura vore permanent. Därför måste den vara omöjlig att skriva
   * utan en lyckad claim, och tvärtom.
   *
   * Idempotent: en faktura som redan är SENT_TO_COLLECTION returnerar
   * `alreadyClaimed` utan att skriva en andra händelse. Det gör omkörning efter
   * ett R2-fel ofarlig.
   *
   * UNDERLAGSREFERENSEN BOR I `Invoice.collectionExportKey`, INTE I HÄNDELSEN.
   * Eftersom claimen ligger före uppladdningen kan händelsens payload omöjligt
   * bära pdfKey/csvKey/zipKey — de existerar inte än. Kolumnen är därför den
   * auktoritativa hänvisningen till underlaget (BFL 5 kap 6 §), och den skrivs
   * av anroparen när nyckeln blir känd. Är den `null` för en SENT_TO_COLLECTION-
   * faktura betyder det att uppladdningen aldrig lyckades — se #307:s
   * följdpunkt om drift-larm för just det tillståndet.
   *
   * #307 PR 2b: metoden validerar numera övergången mot `INVOICE_TRANSITIONS`.
   * Den skrev tidigare `SENT_TO_COLLECTION` från VILKEN status som helst utom
   * PAID/VOID — ett utkast som aldrig nått mottagaren, eller en faktura som
   * ännu inte förfallit, kunde alltså lämnas över till inkasso. Grinden och
   * claimen är SAMMA operation: `COLLECTION_SOURCE_STATUSES` står i WHERE-satsen
   * nedan, så statusmaskinen utvärderas atomiskt vid skrivögonblicket och inte
   * som en fristående förkontroll som en samtidig skrivning kan hinna förbi.
   */
  private async claimForExport(
    invoiceId: string,
    organizationId: string,
    invoiceNumber: string,
    currentStatus: InvoiceStatus,
    reason: string,
    debt: InvoiceDebt,
  ): Promise<{ alreadyClaimed: boolean }> {
    // SENT_TO_COLLECTION hanteras som IDEMPOTENS längre ned, inte som ett fel —
    // därför undantas den här. Statusmaskinen säger nej till den (den är inte
    // sin egen giltiga målstatus), men för exportvägarna betyder den bara
    // "claimen är redan gjord, bara underlaget saknas".
    if (currentStatus !== 'SENT_TO_COLLECTION') {
      const transitionBlocked = this.transitionBlockReason(invoiceNumber, currentStatus)
      if (transitionBlocked) throw new BadRequestException(transitionBlocked)
    }

    // ── #307 PR3: INGEN SKULD, INGET KRAV ──────────────────────────────────
    //
    // Statusgrinden ovan räcker inte. En faktura kan vara fullt allokerad utan
    // att statusen hunnit bli PAID — och exporterades då med ett krav på 0 kr.
    // Mindre fel än att skicka hela beloppet (det stängde PR 2a), men fortfarande
    // ett felaktigt krav till en extern part: ett inkassoärende öppnas, en
    // permanent DEBT_COLLECTION-post skrivs, och påminnelser pausas — allt för en
    // fordran som inte finns.
    //
    // Grinden ligger i CLAIMEN, före all I/O, av samma skäl som #311 flyttade hit
    // statusövergången: misslyckas den ska ingen PDF genereras och ingen
    // append-only-händelse skrivas.
    //
    // SPEGLAR SYSKONVÄGENS exportBlockReason (rent-collection-export.service.ts),
    // men bara till den del som har en motsvarighet här. Av dess fyra villkor:
    //   · status ej PAID/CANCELLED  → finns redan ovan (PAID/VOID)
    //   · collectionStage = INKASSO_READY → INGEN MOTSVARIGHET. Invoice har ingen
    //     kravtrappa-stege; kravstegen lever bara på RentNotice.
    //   · outstanding > 0           → DET HÄR
    //   · ingen betalning efter collectionReadyAt → INGEN MOTSVARIGHET. Invoice
    //     har inget collectionReadyAt; exporten ÄR markeringen. En betalning som
    //     landar efteråt fångas i stället av att restskulden räknas om vid varje
    //     omkörning.
    //
    // INGET MINIMIBELOPP. En faktura med bara påminnelseavgifter kvar, eller några
    // kronor, är fortfarande en verklig fordran och ska kunna drivas in. Om en
    // undre gräns ska finnas är det ett produktbeslut (#310), inte en spärr mot
    // felaktiga krav.
    const blockReason = this.debtBlockReason(invoiceNumber, debt)
    if (blockReason) throw new BadRequestException(blockReason)

    // Redan överlämnad: ingen ny statusövergång, ingen ny händelse. Anroparen
    // får ändå generera om underlaget (t.ex. efter ett avbrutet R2-anrop).
    // Skuldgrinden ovan gäller ÄVEN här: har fakturan blivit fullt betald sedan
    // överlämningen ska en omkörning inte producera ett nytt 0 kr-krav.
    if (currentStatus === 'SENT_TO_COLLECTION') return { alreadyClaimed: true }

    await this.prisma.$transaction(async (tx) => {
      const now = new Date()
      const claim = await tx.invoice.updateMany({
        // Guarden läser databasens NUVARANDE status, inte den som lästes innan.
        // Hann fakturan bli betald eller makulerad uppdateras noll rader.
        //
        // #307 PR 2b: guarden är numera en TILLÅTLISTA härledd ur statusmaskinen
        // (`in COLLECTION_SOURCE_STATUSES`), inte en förbudslista (`notIn
        // PAID/VOID/SENT_TO_COLLECTION`). Skillnaden är riktningen på felet: en
        // förbudslista släpper igenom varje status någon glömmer lägga till i
        // den. Det var så DRAFT och SENT kunde exporteras.
        where: {
          id: invoiceId,
          organizationId,
          status: { in: COLLECTION_SOURCE_STATUSES },
        },
        data: {
          status: 'SENT_TO_COLLECTION',
          sentToCollectionAt: now,
          remindersPaused: true,
          remindersPausedAt: now,
          remindersPausedReason: reason,
        },
      })
      if (claim.count === 0) {
        throw new ConflictException(
          `Faktura ${invoiceNumber} ändrades under exporten — den är nu betald, makulerad ` +
            'eller redan överlämnad. Inget inkassounderlag skapades. Uppdatera sidan och ' +
            'kontrollera fakturan innan du försöker igen.',
        )
      }
      // SCOPAD, men inte på ett sätt det statiska verktyget känner igen:
      // `invoiceId` är BEVISAT höra till `organizationId` av updateMany:n precis
      // ovan. En lyckad claim (count > 0) på primärnyckeln `id` kan bara ske om
      // raden också matchade `organizationId` i samma WHERE — annars är count 0
      // och vi har redan kastat. Ingen separat find/assert behövs därför här.
      // (object-scope-heuristiken rapporterar "INGEN UPPTÄCKT" för den här
      // formen; se golden-filen och #308.)
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          type: 'DEBT_COLLECTION',
          actorType: 'SYSTEM',
          actorLabel: 'Inkassounderlag genererat',
          payload: { reason },
        },
      })
    })

    return { alreadyClaimed: false }
  }

  private async loadInvoice(
    invoiceId: string,
    organizationId: string,
  ): Promise<InvoiceWithCollectionData> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
      include: {
        tenant: { select: COLLECTION_TENANT_SELECT },
        customer: true,
        organization: true,
        paymentReminders: { orderBy: { sentAt: 'asc' } },
        lines: true,
        lease: { include: { unit: { include: { property: true } } } },
        // #307 PR2a: KRAVET SKA AVSE RESTSKULDEN, INTE URSPRUNGSBELOPPET.
        // Utan allokeringarna kan exporten inte veta vad som redan betalats —
        // och det var precis det som gjorde att ett inkassokrav mot en delbetald
        // faktura begärde hela `invoice.total`.
        payments: { orderBy: { paidAt: 'asc' } },
      },
    })
    if (!invoice) throw new NotFoundException(`Faktura ${invoiceId} hittades inte`)
    return invoice
  }

  private buildCsv(invoices: InvoiceWithCollectionData[]): string {
    const headers = [
      'fakturanummer',
      'forfallodatum',
      // #307 PR2a: KOLUMNEN BYTTE BÅDE VÄRDE OCH NAMN. Den bar tidigare
      // `invoice.total` under rubriken `totalbelopp`; nu bär den restskulden.
      // Att låta rubriken stå kvar vore värre än att byta den — en kolumn som
      // heter "totalbelopp" men innehåller 2 000 för en faktura på 10 000
      // mislabelar det inkassobolaget läser in maskinellt, och det är precis
      // den sortens oklarhet ett bestridande hänger på.
      //
      // ⚠️ FORMATÄNDRING MOT EXTERN PART: inkassobolag som mappar kolumner på
      // rubriknamn måste få veta. Se PR-beskrivningen.
      'restskuld',
      'paminnelseavgifter',
      'organisationsnummer_borgenar',
      'borgenar_namn',
      'galdenar_namn',
      'galdenar_personnummer',
      'galdenar_orgnummer',
      'galdenar_email',
      'galdenar_telefon',
      'galdenar_adress',
      'kontraktsreferens',
      'antal_paminnelser',
      'forsta_paminnelse_datum',
      'senaste_paminnelse_datum',
      'inkassobolag',
    ]
    const rows = invoices.map((inv) => {
      const party = inv.tenant ?? inv.customer
      const partyName = party
        ? (party.companyName ??
          `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim() ??
          party.email)
        : ''
      const reminderFees = inv.paymentReminders.reduce((s, r) => s + Number(r.feeAmount), 0)
      const firstReminder = inv.paymentReminders[0]?.sentAt ?? null
      const lastReminder = inv.paymentReminders[inv.paymentReminders.length - 1]?.sentAt ?? null
      const leaseRef = inv.lease ? `${inv.lease.unit.property.name} / ${inv.lease.unit.name}` : ''
      return [
        inv.invoiceNumber,
        inv.dueDate.toISOString().slice(0, 10),
        // #307 PR2a: restskulden, inte ursprungsbeloppet — se buildPdfHtml.
        // Det HÄR är kolumnen inkassobolaget läser in maskinellt.
        computeInvoiceDebt({
          total: inv.total,
          allocations: inv.payments.map((p) => p.amount),
        })
          .outstanding.toNumber()
          .toFixed(2),
        reminderFees.toFixed(2),
        inv.organization.orgNumber ?? '',
        inv.organization.name,
        partyName,
        this.pn.reveal(party?.personalNumberEnc) ?? '',
        party?.orgNumber ?? '',
        party?.email ?? '',
        party?.phone ?? '',
        party ? `${party.street ?? ''}, ${party.postalCode ?? ''} ${party.city ?? ''}`.trim() : '',
        leaseRef,
        String(inv.paymentReminders.length),
        firstReminder ? firstReminder.toISOString().slice(0, 10) : '',
        lastReminder ? lastReminder.toISOString().slice(0, 10) : '',
        inv.organization.collectionAgencyName ?? '',
      ]
    })
    return [headers, ...rows].map((r) => r.map((c) => csvCell(c)).join(',')).join('\n')
  }

  private async buildPdfHtml(invoice: InvoiceWithCollectionData): Promise<string> {
    const party = invoice.tenant ?? invoice.customer
    // Dekryptering vid användningstillfället — kravbrevet ska bära gäldenärens
    // personnummer, inget annat i den här filen behöver klartexten.
    const partyPersonalNumber = this.pn.reveal(party?.personalNumberEnc)
    const partyName = party
      ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
      : '–'
    const partyAddress = party
      ? `${party.street ?? ''}<br>${party.postalCode ?? ''} ${party.city ?? ''}`
      : ''
    const reminders = invoice.paymentReminders
    const totalFees = reminders.reduce((s, r) => s + Number(r.feeAmount), 0)

    // ── #307 PR2a: KRAVET AVSER RESTSKULDEN, INTE URSPRUNGSBELOPPET ────────
    //
    // Här stod `Number(invoice.total)`. Filen konsulterade aldrig
    // allokeringsmodellen — noll referenser till computeInvoiceDebt, och
    // loadInvoice laddade inte ens betalningarna. Ett inkassokrav mot en
    // delbetald faktura begärde därför HELA ursprungsbeloppet: ett krav mot en
    // person på pengar de inte längre är skyldiga, skickat till ett
    // inkassobolag (Inkassolagen 4 §, god inkassosed — kravet ska avse en
    // riktig fordran).
    //
    // Exakt samma mönster var redan fixat i betalningsvägarna. invoice-debt.ts
    // bär kommentaren om att "båda betalvägarna bokförde invoice.total oavsett
    // mottaget belopp" — fixen gjordes där och missades här. Nu delas
    // sanningskällan: computeInvoiceDebt, samma helper, samma Decimal-säkerhet.
    //
    // Påminnelseavgifterna ligger KVAR i kravet: payment-reminder.service.ts
    // skriver in dem i invoice.total när den formella påminnelsen skickas, så
    // de ingår i totalen och därmed i restskulden. Noten under beloppet
    // fortsätter redovisa dem separat.
    // Samma beräkning som grinden i claimForExport använde — se outstandingFor.
    const debt = this.outstandingFor(invoice)
    // debt.paid, INTE total − outstanding: outstanding är klampad till 0 vid
    // överbetalning, så subtraktionen hade visat ett för lågt betalt-belopp på
    // ett dokument som går till inkasso. Fångat av båda granskarna oberoende.
    const alreadyPaid = debt.paid
    const totalDue = debt.outstanding.toNumber()
    const today = new Date().toLocaleDateString('sv-SE')
    const leaseRef = invoice.lease
      ? `${invoice.lease.unit.property.name} – ${invoice.lease.unit.name} (${invoice.lease.unit.unitNumber})`
      : '–'

    const reminderRows = reminders
      .map((r) => {
        const label =
          r.type === 'REMINDER_FRIENDLY'
            ? 'Vänlig påminnelse'
            : r.type === 'REMINDER_FORMAL'
              ? 'Formell påminnelse'
              : 'Markerad redo för inkasso'
        return `<tr>
          <td>${r.sentAt.toLocaleDateString('sv-SE')}</td>
          <td>${label}</td>
          <td style="text-align:right">${formatSek(Number(r.feeAmount))}</td>
        </tr>`
      })
      .join('')

    const lineRows = invoice.lines
      .map(
        (l) => `<tr>
          <td>${escapeHtml(l.description)}</td>
          <td style="text-align:right">${Number(l.quantity).toLocaleString('sv-SE')}</td>
          <td style="text-align:right">${formatSek(Number(l.unitPrice))}</td>
          <td style="text-align:right">${formatSek(Number(l.total))}</td>
        </tr>`,
      )
      .join('')

    const org = invoice.organization
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)
    // Steg 3, PR 3e: dokumentet var HELT brand-blint (egen inline-HTML, ingen
    // logga, egen dokumentgrön #1a4a28). Hårdkodad #1a4a28 → orgens brandfärg
    // (invoiceColor) med delad DEFAULT_BRAND_COLOR som fallback. #1a4a28 låg
    // utanför branding-kartan och enas nu mot den gemensamma defaulten.
    const accent = org.invoiceColor ?? DEFAULT_BRAND_COLOR

    // Egen html/head/body + egen header/titel ersätts av den gemensamma brandade
    // shellen (logga, primär/sekundärfärg, typsnitt, titel). ALLT juridiskt och
    // ekonomiskt bindande innehåll — disclaimern (4 § lagen 1981:739), alla belopp
    // (kapital, påminnelseavgifter, total skuld), borgenär/gäldenär, förfallo-
    // datum och kontraktsreferens — är byte-för-byte oförändrat. Bara ramen brandas.
    const contentCss = `
  .docmeta { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
  .docref { text-align: right; }
  .docnum { font-size: 18px; font-weight: 700; }
  h2 { font-size: 14px; color: ${accent}; margin: 24px 0 8px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
  .meta { font-size: 11px; color: #4b5563; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; }
  .label { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; font-size: 11px; }
  th { background: #f3f4f6; color: #374151; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; }
  tfoot td { font-weight: 700; }
  .total-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 14px 16px; margin-top: 18px; display: flex; justify-content: space-between; align-items: center; }
  .total-box .amt { font-size: 22px; font-weight: 700; color: #b91c1c; }
  .legal { font-size: 10px; color: #6b7280; margin-top: 24px; line-height: 1.5; }`

    const contentHtml = `<style>${contentCss}</style>
  <div class="docmeta">
    <div class="meta">Genererat ${today} · Eveno fastighetssystem</div>
    <div class="docref">
      <div class="meta"><strong>Faktura</strong></div>
      <div class="docnum">${invoice.invoiceNumber}</div>
      <div class="meta">Förfallodatum ${invoice.dueDate.toLocaleDateString('sv-SE')}</div>
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <div class="label">Borgenär (fastighetsägare)</div>
      <strong>${escapeHtml(invoice.organization.name)}</strong><br>
      Org.nr: ${invoice.organization.orgNumber ?? '–'}<br>
      ${escapeHtml(invoice.organization.street ?? '')}<br>
      ${invoice.organization.postalCode ?? ''} ${escapeHtml(invoice.organization.city ?? '')}<br>
      ${invoice.organization.email ? `E-post: ${escapeHtml(invoice.organization.email)}` : ''}
    </div>
    <div class="box">
      <div class="label">Gäldenär (hyresgäst)</div>
      <strong>${escapeHtml(partyName)}</strong><br>
      ${
        partyPersonalNumber
          ? `Personnr: ${escapeHtml(partyPersonalNumber)}<br>`
          : party?.orgNumber
            ? `Org.nr: ${escapeHtml(party.orgNumber)}<br>`
            : ''
      }
      ${partyAddress}<br>
      ${party?.email ? `E-post: ${escapeHtml(party.email)}<br>` : ''}
      ${party?.phone ? `Telefon: ${escapeHtml(party.phone)}` : ''}
    </div>
  </div>

  <h2>Skuldspecifikation</h2>
  <table>
    <thead>
      <tr>
        <th>Beskrivning</th>
        <th style="text-align:right">Antal</th>
        <th style="text-align:right">À-pris</th>
        <th style="text-align:right">Summa</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <div class="total-box">
    <div>
      <div class="label">Kvarstående skuld</div>
      <div class="meta">Inkluderar påminnelseavgifter ${formatSek(totalFees)}</div>
      ${
        alreadyPaid.gt(0)
          ? `<div class="meta">Fakturabelopp ${formatSek(
              debt.total.toNumber(),
            )} − betalt ${formatSek(alreadyPaid.toNumber())}</div>`
          : ''
      }
    </div>
    <div class="amt">${formatSek(totalDue)}</div>
  </div>

  <h2>Påminnelsehistorik</h2>
  ${
    reminders.length === 0
      ? '<p class="meta">Inga påminnelser har skickats för denna faktura.</p>'
      : `<table>
          <thead>
            <tr>
              <th>Datum</th>
              <th>Typ</th>
              <th style="text-align:right">Avgift</th>
            </tr>
          </thead>
          <tbody>${reminderRows}</tbody>
        </table>`
  }

  <h2>Kontrakts- och fastighetsreferens</h2>
  <p class="meta">${escapeHtml(leaseRef)}</p>

  <p class="legal">
    Detta dokument är ett underlag för inkassoärende. Borgenären ansvarar för att
    skicka det vidare till sitt valda inkassobolag (t.ex. Visma Collectors, Intrum
    eller Lindorff). Eveno är ett fastighetssystem och bedriver INTE
    inkassoverksamhet. Påminnelseavgift utgår enligt 4 § lagen (1981:739) om
    ersättning för inkassokostnader.
  </p>`

    return buildBrandedPdfHtml({
      // hideFooter → shellen behöver bara namnet (för brandMark utan logga).
      // Borgenärens fullständiga uppgifter ligger i Borgenär-boxen ovan.
      org: { name: org.name },
      logoDataUrl,
      primaryColor: org.invoiceColor ?? null,
      secondaryColor: org.brandSecondaryColor ?? null,
      brandFont: org.brandFont ?? null,
      title: 'Inkassounderlag',
      contentHtml,
      // Footern DÖLJS medvetet. Den juristgranskade inkasso-disclaimern
      // (4 § lagen 1981:739 + "Eveno bedriver INTE inkassoverksamhet") är ett
      // BLOCKING-krav och MÅSTE vara dokumentets sista ord. En generisk
      // brand-footer (org-adress/bankgiro/kontakt) efter den vore strukturellt
      // fel och kunde dessutom antyda en betalningsväg (bankgiro) som motsäger
      // inkassoflödet — kravet ägs av inkassobolaget. Borgenärens identitet
      // finns redan i Borgenär-boxen, så inget går förlorat.
      hideFooter: true,
    })
  }
}

function formatSek(amount: number): string {
  return `${amount.toLocaleString('sv-SE', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} kr`
}
