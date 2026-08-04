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
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { UserRole } from '@prisma/client'
import { assertMayActOnCollections } from '../common/authz/collections-authz'

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
  }
}>

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
      try {
        await this.claimForExport(
          inv.id,
          organizationId,
          inv.invoiceNumber,
          inv.status,
          'Skickad till inkasso (bulk)',
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
   */
  async markSentToCollection(
    invoiceId: string,
    organizationId: string,
    note?: string,
    actorRole?: UserRole,
    actorId?: string,
  ): Promise<{ id: string; status: 'SENT_TO_COLLECTION' }> {
    assertMayActOnCollections(actorRole, 'markera som skickad till inkasso')
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status === 'PAID' || invoice.status === 'VOID') {
      throw new BadRequestException('Fakturan är redan avslutad')
    }

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'SENT_TO_COLLECTION',
        sentToCollectionAt: new Date(),
        remindersPaused: true,
        remindersPausedAt: new Date(),
        remindersPausedReason: note ?? 'Skickad till externt inkassobolag',
      },
    })
    // Av de fem grindade handlingarna är detta den ENDA som är en genuint
    // manuell användarhandling — export/bulk-export körs av workern och loggas
    // som SYSTEM. Den skrev tidigare actorType USER men lämnade actorId tomt,
    // så loggen sa "en människa gjorde detta" utan att säga vem. Det är precis
    // den fråga som ställs först om en hyresgäst bestrider en
    // inkassoöverlämning. actorId trådas därför in från den inloggade aktören.
    await this.prisma.invoiceEvent.create({
      data: {
        invoiceId: invoice.id,
        type: 'DEBT_COLLECTION',
        actorType: 'USER',
        ...(actorId ? { actorId } : {}),
        actorLabel: 'Manuell markering',
        payload: note ? { note } : {},
      },
    })

    return { id: invoice.id, status: 'SENT_TO_COLLECTION' }
  }

  // ── Privata hjälpare ─────────────────────────────────────────────────────

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
   * OBS: metoden validerar INTE övergången mot `INVOICE_TRANSITIONS`. Att
   * exporten kan skriva SENT_TO_COLLECTION från t.ex. SENT eller PARTIAL — som
   * statusmaskinen bara tillåter från OVERDUE — är ett separat fel som inte
   * kräver samtidighet, och det hör till #307:s PR 2.
   */
  private async claimForExport(
    invoiceId: string,
    organizationId: string,
    invoiceNumber: string,
    currentStatus: string,
    reason: string,
  ): Promise<{ alreadyClaimed: boolean }> {
    if (currentStatus === 'PAID' || currentStatus === 'VOID') {
      throw new BadRequestException(
        'Kan inte skapa inkassounderlag för betald eller makulerad faktura',
      )
    }
    // Redan överlämnad: ingen ny statusövergång, ingen ny händelse. Anroparen
    // får ändå generera om underlaget (t.ex. efter ett avbrutet R2-anrop).
    if (currentStatus === 'SENT_TO_COLLECTION') return { alreadyClaimed: true }

    await this.prisma.$transaction(async (tx) => {
      const now = new Date()
      const claim = await tx.invoice.updateMany({
        // Guarden läser databasens NUVARANDE status, inte den som lästes innan.
        // Hann fakturan bli betald eller makulerad uppdateras noll rader.
        where: {
          id: invoiceId,
          organizationId,
          status: { notIn: ['PAID', 'VOID', 'SENT_TO_COLLECTION'] },
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
      },
    })
    if (!invoice) throw new NotFoundException(`Faktura ${invoiceId} hittades inte`)
    return invoice
  }

  private buildCsv(invoices: InvoiceWithCollectionData[]): string {
    const headers = [
      'fakturanummer',
      'forfallodatum',
      'totalbelopp',
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
        Number(inv.total).toFixed(2),
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
    const totalDue = Number(invoice.total)
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
    // ekonomiskt bindande innehåll — disclaimern (lag 1981:739), alla belopp
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
      <div class="label">Total skuld</div>
      <div class="meta">Inkluderar påminnelseavgifter ${formatSek(totalFees)}</div>
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
    inkassoverksamhet. Påminnelseavgift utgår enligt lag (1981:739) om ersättning
    för inkassokostnader.
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
      // (lag 1981:739 + "Eveno bedriver INTE inkassoverksamhet") är ett
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

function csvCell(value: string): string {
  const needsEscape = /[",\n]/.test(value)
  if (!needsEscape) return value
  return `"${value.replace(/"/g, '""')}"`
}
