import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import JSZip from 'jszip'
import { PrismaService } from '../common/prisma/prisma.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'
import { RentDebtService } from '../avisering/rent-debt.service'
import { buildBrandedPdfHtml, escapeHtml, getLogoDataUrl } from '../common/branding'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'

// Inkasso PR 4b — steg 3. Read-only export av INKASSO_READY-hyresavier till ett
// externt inkassobolag. SPEGLAR collections/CollectionExportService (faktura-
// baserad) men återanvänder den INTE — datan, kolumnerna och PDF-mallen är
// RentNotice-specifika.
//
// INV-C: exporten skapar INGA pengahändelser. Den rör ingen bokföring, ingen
// status-/kravstegsövergång — den genererar dokument och skriver en append-only
// audit-notering. Evenos ansvar slutar vid exportfilen; inkassobolaget driver
// kravet. Ingen kod för inkassokrav, förverkande eller avhysning finns här.

const RENT_COLLECTION_INCLUDE = {
  tenant: { select: SAFE_TENANT_SELECT },
  organization: true,
  lease: { include: { unit: { include: { property: true } } } },
  events: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.RentNoticeInclude

type RentNoticeWithCollectionData = Prisma.RentNoticeGetPayload<{
  include: typeof RENT_COLLECTION_INCLUDE
}>

// En räntedelperiod inom ETT kalenderhalvår, exakt formen RentInterestService
// skriver till INTEREST_ACCRUED-eventets payload (räntelagen 9 §).
interface InterestSegment {
  from: string
  to: string
  days: number
  referenceRatePercent: number
  effectiveRatePercent: number
  amount: number
}

// De ekonomiska posterna i kravet, härledda ur avin. interest är det KUMULATIVT
// bokförda räntebeloppet på avin (auktoritativ total); segments är hur den räntan
// räknats per halvår — aldrig ett dagviktat snitt.
interface CollectionFigures {
  capital: number
  reminderFee: number
  interest: number
  interestThrough: string | null
  totalClaim: number
  segments: InterestSegment[]
}

export interface RentCollectionExportResult {
  noticeId: string
  noticeNumber: string
  pdfKey: string
  csvKey: string
  pdfUrl: string
  csvUrl: string
}

@Injectable()
export class RentCollectionExportService {
  private readonly logger = new Logger(RentCollectionExportService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly storage: StorageService,
    private readonly pdfQueue: PdfQueue,
    // Bankavstämnings-härdning PR 2 — INV-D: exporten grindar på FAKTISK skuld
    // (outstanding) vid exportögonblicket, inte på collectionStage (en vy).
    private readonly rentDebt: RentDebtService,
  ) {}

  /**
   * Listar avier som passerat inkasso-ready-grinden (collectionStage
   * INKASSO_READY) — de som får exporteras. Org-scopad. Lättviktig projektion
   * (inga interna R2-/message-id-fält) för urvalslistan i UI:t.
   */
  async listReady(organizationId: string): Promise<unknown[]> {
    const candidates = await this.prisma.rentNotice.findMany({
      // status notIn PAID/CANCELLED är ett billigt DB-förfilter (fångar zombies
      // även i historisk data där stage inte nollställts). Den faktiska skuld-
      // grinden (outstanding > 0, ingen betalning efter ready) körs per rad nedan.
      where: {
        organizationId,
        collectionStage: 'INKASSO_READY',
        status: { notIn: ['PAID', 'CANCELLED'] },
      },
      select: {
        id: true,
        noticeNumber: true,
        ocrNumber: true,
        dueDate: true,
        status: true,
        collectionReadyAt: true,
        totalAmount: true,
        consumptionAmount: true,
        reminderFeeAmount: true,
        interestAccruedAmount: true,
        tenant: {
          select: { id: true, type: true, firstName: true, lastName: true, companyName: true },
        },
      },
      orderBy: { collectionReadyAt: 'desc' },
    })

    // INV-D: listan får ENDAST innehålla faktiskt exporterbara avier — annars
    // skulle UI:t erbjuda export av en reglerad fordran. Filtrera på samma grind
    // som exporten själv använder.
    const exportable = await Promise.all(
      candidates.map(async (n) => {
        const reason = await this.exportBlockReason({
          id: n.id,
          organizationId,
          noticeNumber: n.noticeNumber,
          status: n.status,
          collectionStage: 'INKASSO_READY',
          collectionReadyAt: n.collectionReadyAt,
        })
        return reason === null ? n : null
      }),
    )
    return exportable.filter((n) => n !== null)
  }

  /** Köar export för EN avi — PDF-renderingen sker i PdfWorker. */
  async enqueueExportForNotice(
    noticeId: string,
    organizationId: string,
  ): Promise<{ jobId: string }> {
    const jobId = await this.pdfQueue.enqueue({
      kind: 'rent-collections-export',
      organizationId,
      noticeId,
    })
    return { jobId }
  }

  /** Köar bulk-export (samlad ZIP) — hela bygget sker i PdfWorker i ett jobb. */
  async enqueueBulkExport(noticeIds: string[], organizationId: string): Promise<{ jobId: string }> {
    const jobId = await this.pdfQueue.enqueue({
      kind: 'rent-collections-bulk-export',
      organizationId,
      noticeIds,
    })
    return { jobId }
  }

  /**
   * Genererar inkassounderlag (PDF + CSV) för EN inkasso-redo avi och laddar upp
   * båda org-scopat. INV-C: ingen status-/kravstegsändring, ingen bokföring —
   * bara en append-only audit-notering om att underlaget skapats.
   */
  async exportForNotice(
    noticeId: string,
    organizationId: string,
  ): Promise<RentCollectionExportResult> {
    const notice = await this.loadNotice(noticeId, organizationId)
    await this.assertExportable(notice)

    const pdfBuffer = await this.pdf.generateFromHtml(await this.buildPdfHtml(notice))
    const csvBuffer = Buffer.from(this.buildCsv([notice]), 'utf8')

    const date = new Date().toISOString().slice(0, 10)
    const safe = notice.noticeNumber.replace(/[^\w-]/g, '_')
    const pdfKey = `rent-collections/${organizationId}/${date}/inkasso-${safe}.pdf`
    const csvKey = `rent-collections/${organizationId}/${date}/inkasso-${safe}.csv`

    const [pdfUrl, csvUrl] = await Promise.all([
      this.storage.uploadFile(pdfBuffer, pdfKey, 'application/pdf'),
      this.storage.uploadFile(csvBuffer, csvKey, 'text/csv'),
    ])

    // INV-C: read-only. Endast append-only audit-notering — ingen statusövergång,
    // ingen krona rörs. (NOTE_ADDED; ingen dedikerad export-händelsetyp behövs.)
    await this.prisma.rentNoticeEvent.create({
      data: {
        rentNoticeId: notice.id,
        type: 'NOTE_ADDED',
        actorType: 'SYSTEM',
        actorLabel: 'System',
        payload: { action: 'inkasso-export', pdfKey, csvKey },
      },
    })

    return {
      noticeId: notice.id,
      noticeNumber: notice.noticeNumber,
      pdfKey,
      csvKey,
      pdfUrl,
      csvUrl,
    }
  }

  /**
   * Skapar en samlad ZIP med inkassounderlag (PDF) + den lagrade påminnelse-
   * PDF:en per avi och en batch-CSV för alla. Många inkassobolag (Visma
   * Collectors, Intrum, Lindorff) tar emot batch-import som CSV.
   *
   * Den lagrade påminnelse-PDF:en (PR 4b₀) bifogas så dokumentkopian följer med i
   * överlämningen — best-effort: en R2-hicka loggas men fäller inte exporten
   * (grinden har redan verifierat att nyckeln finns). INV-C: read-only.
   */
  async exportBulk(
    noticeIds: string[],
    organizationId: string,
  ): Promise<{ zipKey: string; zipUrl: string; count: number }> {
    if (noticeIds.length === 0) throw new BadRequestException('Inga avier angivna')

    const notices = await Promise.all(noticeIds.map((id) => this.loadNotice(id, organizationId)))
    // INV-D: skuld-grinden körs per avi vid exportögonblicket (inte bara
    // collectionStage). En enda icke-exporterbar avi (reglerad, zombie, betalning
    // efter ready) fäller hela bulken med konkreta skäl — inget inkasso-artefakt
    // får produceras för en avi vars faktiska skuld är 0.
    const blocked = (
      await Promise.all(
        notices.map(async (n) => {
          const reason = await this.exportBlockReason(n)
          return reason ? reason : null
        }),
      )
    ).filter((r): r is string => r !== null)
    if (blocked.length > 0) {
      throw new BadRequestException(`Kan inte exportera: ${blocked.join('; ')}`)
    }

    const zip = new JSZip()
    for (const notice of notices) {
      const safe = notice.noticeNumber.replace(/[^\w-]/g, '_')
      const pdfBuffer = await this.pdf.generateFromHtml(await this.buildPdfHtml(notice))
      zip.file(`${safe}/inkasso-underlag-${safe}.pdf`, pdfBuffer)

      if (notice.reminderPdfStorageKey) {
        try {
          const reminderPdf = await this.storage.getFileBuffer(notice.reminderPdfStorageKey)
          zip.file(`${safe}/paminnelse-${safe}.pdf`, reminderPdf)
        } catch (err) {
          this.logger.warn(
            `Kunde inte bifoga påminnelse-PDF för avi ${notice.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
    zip.file('inkasso-rent-batch.csv', this.buildCsv(notices))

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    const date = new Date().toISOString().slice(0, 10)
    const zipKey = `rent-collections/${organizationId}/${date}/inkasso-rent-batch-${Date.now()}.zip`
    const zipUrl = await this.storage.uploadFile(zipBuffer, zipKey, 'application/zip')

    // INV-C: read-only. Append-only audit-notering per avi, ingen statusändring.
    await this.prisma.$transaction(async (tx) => {
      for (const n of notices) {
        await tx.rentNoticeEvent.create({
          data: {
            rentNoticeId: n.id,
            type: 'NOTE_ADDED',
            actorType: 'SYSTEM',
            actorLabel: 'System',
            payload: { action: 'inkasso-export-bulk', zipKey },
          },
        })
      }
    })

    return { zipKey, zipUrl, count: notices.length }
  }

  // ── Privata hjälpare ─────────────────────────────────────────────────────

  private async loadNotice(
    noticeId: string,
    organizationId: string,
  ): Promise<RentNoticeWithCollectionData> {
    // Tenant-isolation: org verifieras i WHERE innan avins egen logg (events)
    // läses via relationen — ett läckt noticeId kan aldrig nå en annan orgs avi.
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      include: RENT_COLLECTION_INCLUDE,
    })
    if (!notice) throw new NotFoundException(`Hyresavi ${noticeId} hittades inte`)
    return notice
  }

  /**
   * Bankavstämnings-härdning PR 2 — INV-D: exportgrinden frågar FAKTISK skuld vid
   * exportögonblicket. collectionStage är en vy, aldrig sanning om skuld. En avi
   * får exporteras som inkassokrav ENDAST om allt nedan gäller — annars returneras
   * ett skäl (null = exporterbar). Gemensam för assert (kastar) och listReady
   * (filtrerar), så UI-listan och exporten alltid är överens.
   *
   *   1. status är inte PAID/CANCELLED (reglerad/avbruten är inget krav).
   *   2. collectionStage = INKASSO_READY (grinden uppströms har körts).
   *   3. outstanding > 0 — TOTAL-residualen (kapital+förbrukning+avgift+ränta −
   *      betalt) inklusive ränta, eftersom inkassobolaget driver HELA fordran.
   *   4. ingen betalning registrerad EFTER att ärendet blev INKASSO_READY — en ny
   *      betalning (även del) innebär att läget ändrats och måste granskas på nytt.
   *
   * En betald-men-INKASSO_READY-avi (zombie) faller på (1) och (3) och kan ALDRIG
   * exporteras. Org-scopas via avins organizationId (rentDebt.outstanding +
   * payment-frågan filtrerar båda på org/avin).
   */
  private async exportBlockReason(notice: {
    id: string
    organizationId: string
    noticeNumber: string
    status: string
    collectionStage: string
    collectionReadyAt: Date | null
  }): Promise<string | null> {
    if (notice.status === 'PAID' || notice.status === 'CANCELLED') {
      return `Avi ${notice.noticeNumber} är ${notice.status === 'PAID' ? 'betald' : 'avbruten'} och kan inte exporteras som inkassokrav`
    }
    if (notice.collectionStage !== 'INKASSO_READY') {
      return `Avi ${notice.noticeNumber} är inte inkasso-redo (kravsteg ${notice.collectionStage}) — kör inkasso-ready-grinden först`
    }

    const debt = await this.rentDebt.outstanding(notice.id, notice.organizationId)
    if (debt.outstanding <= 0) {
      return `Avi ${notice.noticeNumber} har ingen utestående skuld (reglerad) — kan inte exporteras som inkassokrav`
    }

    if (notice.collectionReadyAt) {
      const newerPayment = await this.prisma.rentNoticePayment.findFirst({
        where: { rentNoticeId: notice.id, createdAt: { gt: notice.collectionReadyAt } },
        select: { id: true },
      })
      if (newerPayment) {
        return `Avi ${notice.noticeNumber} har en betalning registrerad efter att den blev inkasso-redo — granska på nytt innan export`
      }
    }

    return null
  }

  /** Kastar om avin inte får exporteras (INV-D). Annars no-op. */
  private async assertExportable(notice: RentNoticeWithCollectionData): Promise<void> {
    const reason = await this.exportBlockReason(notice)
    if (reason) throw new BadRequestException(reason)
  }

  /**
   * Härleder kravets ekonomiska poster. interest = avins KUMULATIVT bokförda
   * dröjsmålsränta (interestAccruedAmount) — den auktoritativa totalen. segments
   * hämtas ur den SENASTE INTEREST_ACCRUED-händelsen (slutkristalliseringen vid
   * inkasso-redo) och visar hur räntan räknats per halvår. Vi litar på den
   * bokförda totalen även om en öresrest skulle skilja mot Σ segment.
   */
  private figures(notice: RentNoticeWithCollectionData): CollectionFigures {
    const capital = Number(notice.totalAmount) + Number(notice.consumptionAmount)
    const reminderFee = Number(notice.reminderFeeAmount)
    const interest = Number(notice.interestAccruedAmount)
    const totalClaim = round2(capital + reminderFee + interest)

    const interestEvent = [...notice.events].reverse().find((e) => e.type === 'INTEREST_ACCRUED')
    const segments = readSegments(interestEvent?.payload)
    const interestThrough = notice.interestAccruedThrough
      ? notice.interestAccruedThrough.toISOString().slice(0, 10)
      : null

    return { capital, reminderFee, interest, interestThrough, totalClaim, segments }
  }

  private buildCsv(notices: RentNoticeWithCollectionData[]): string {
    const headers = [
      'avinummer',
      'ocr',
      'forfallodatum',
      'kapital',
      'paminnelseavgift',
      'drojsmalsranta',
      'ranta_tom_datum',
      'rantesegment',
      'total_skuld',
      'organisationsnummer_borgenar',
      'borgenar_namn',
      'borgenar_adress',
      'galdenar_namn',
      'galdenar_personnummer',
      'galdenar_orgnummer',
      'galdenar_email',
      'galdenar_telefon',
      'galdenar_adress',
      'kontraktsreferens',
      'inkasso_redo_datum',
      'paminnelse_levererad_datum',
      'inkassobolag',
    ]
    const rows = notices.map((notice) => {
      const f = this.figures(notice)
      const t = notice.tenant
      const o = notice.organization
      const partyName =
        t.type === 'INDIVIDUAL'
          ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
          : (t.companyName ?? '')
      const leaseRef = `${notice.lease.unit.property.name} / ${notice.lease.unit.name}`
      const deliveredAt = this.deliveredAt(notice)
      return [
        notice.noticeNumber,
        notice.ocrNumber,
        notice.dueDate.toISOString().slice(0, 10),
        f.capital.toFixed(2),
        f.reminderFee.toFixed(2),
        f.interest.toFixed(2),
        f.interestThrough ?? '',
        encodeSegments(f.segments),
        f.totalClaim.toFixed(2),
        o.orgNumber ?? '',
        o.name,
        `${o.street}, ${o.postalCode} ${o.city}`.trim(),
        partyName,
        t.personalNumber ?? '',
        t.orgNumber ?? '',
        t.email ?? '',
        t.phone ?? '',
        `${t.street ?? ''}, ${t.postalCode ?? ''} ${t.city ?? ''}`.trim(),
        leaseRef,
        notice.collectionReadyAt ? notice.collectionReadyAt.toISOString().slice(0, 10) : '',
        deliveredAt ?? '',
        o.collectionAgencyName ?? '',
      ]
    })
    return [headers, ...rows].map((r) => r.map((c) => csvCell(c)).join(',')).join('\n')
  }

  private async buildPdfHtml(notice: RentNoticeWithCollectionData): Promise<string> {
    const f = this.figures(notice)
    const t = notice.tenant
    const o = notice.organization
    const partyName =
      t.type === 'INDIVIDUAL'
        ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
        : (t.companyName ?? '–')
    // Escapa adressdelarna (säkerhetsgranskning MEDIUM): råa DB-värden får aldrig
    // injiceras oescapade i PDF-HTML:en — ett <style>/<img> i en adress kan annars
    // manipulera det fysiska inkassodokumentet (dölja belopp, falskt bankgiro).
    const partyAddress = [
      t.street ? escapeHtml(t.street) : null,
      [t.postalCode ? escapeHtml(t.postalCode) : null, t.city ? escapeHtml(t.city) : null]
        .filter(Boolean)
        .join(' '),
    ]
      .filter((part) => part && part.trim())
      .join('<br>')
    const today = new Date().toLocaleDateString('sv-SE')
    const leaseRef = `${notice.lease.unit.property.name} – ${notice.lease.unit.name} (${notice.lease.unit.unitNumber})`
    const deliveredAt = this.deliveredAt(notice)

    // Räntan som en EGEN rad med per-halvår-specifikation (räntelagen 9 §).
    const interestRows =
      f.segments.length > 0
        ? f.segments
            .map(
              (s) => `<tr>
          <td>${s.from} – ${s.to}</td>
          <td style="text-align:right">${s.days}</td>
          <td style="text-align:right">${s.effectiveRatePercent.toFixed(2)} %</td>
          <td style="text-align:right">${formatSek(s.amount)}</td>
        </tr>`,
            )
            .join('')
        : `<tr><td colspan="4" class="meta">Ingen dröjsmålsränta har kristalliserats.</td></tr>`

    const org = notice.organization
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)
    // Steg 3, PR 3e-ii: hårdkodad dokumentgrön #1a4a28 → orgens brandfärg
    // (invoiceColor) med delad DEFAULT_BRAND_COLOR som fallback — enas mot samma
    // default som det faktura-baserade inkassounderlaget (#126).
    const accent = org.invoiceColor ?? DEFAULT_BRAND_COLOR

    // Egen html/head/body + egen header/titel ersätts av den gemensamma brandade
    // shellen. ALLT bindande innehåll — den juristkrävda disclaimern (inkassolagen
    // 1974:182 5 §, räntelagen 1975:635, lag 1981:739), den PERIOD-SEGMENTERADE
    // dröjsmålsräntan (varje segment + auktoritativ total), kapital, avgift, OCR,
    // datum och borgenär/gäldenär — är byte-för-byte oförändrat. Bara ramen brandas.
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
      <div class="meta"><strong>Hyresavi</strong></div>
      <div class="docnum">${escapeHtml(notice.noticeNumber)}</div>
      <div class="meta">Förfallodatum ${notice.dueDate.toLocaleDateString('sv-SE')}</div>
      <div class="meta">OCR ${escapeHtml(notice.ocrNumber)}</div>
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <div class="label">Borgenär (fastighetsägare)</div>
      <strong>${escapeHtml(o.name)}</strong><br>
      Org.nr: ${escapeHtml(o.orgNumber ?? '–')}<br>
      ${escapeHtml(o.street)}<br>
      ${escapeHtml(o.postalCode)} ${escapeHtml(o.city)}<br>
      ${o.email ? `E-post: ${escapeHtml(o.email)}` : ''}
    </div>
    <div class="box">
      <div class="label">Gäldenär (hyresgäst)</div>
      <strong>${escapeHtml(partyName)}</strong><br>
      ${
        t.personalNumber
          ? `Personnr: ${escapeHtml(t.personalNumber)}<br>`
          : t.orgNumber
            ? `Org.nr: ${escapeHtml(t.orgNumber)}<br>`
            : ''
      }
      ${partyAddress}<br>
      ${t.email ? `E-post: ${escapeHtml(t.email)}<br>` : ''}
      ${t.phone ? `Telefon: ${escapeHtml(t.phone)}` : ''}
    </div>
  </div>

  <h2>Skuldspecifikation</h2>
  <table>
    <thead>
      <tr><th>Post</th><th style="text-align:right">Belopp</th></tr>
    </thead>
    <tbody>
      <tr><td>Kapital (hyra och förbrukning)</td><td style="text-align:right">${formatSek(f.capital)}</td></tr>
      <tr><td>Påminnelseavgift</td><td style="text-align:right">${formatSek(f.reminderFee)}</td></tr>
      <tr><td>Dröjsmålsränta${f.interestThrough ? ` (t.o.m. ${f.interestThrough})` : ''}</td><td style="text-align:right">${formatSek(f.interest)}</td></tr>
    </tbody>
  </table>

  <h2>Dröjsmålsränta per period (räntelagen 6 §, 9 §)</h2>
  <table>
    <thead>
      <tr>
        <th>Period</th>
        <th style="text-align:right">Dagar</th>
        <th style="text-align:right">Räntesats</th>
        <th style="text-align:right">Belopp</th>
      </tr>
    </thead>
    <tbody>${interestRows}</tbody>
  </table>
  <p class="meta">
    Dröjsmålsräntan är referensräntan + 8 procentenheter och beräknas på det
    obetalda kapitalet från dagen efter förfallodagen. Vid halvårsskifte
    delas perioden så varje del bär sitt halvårs referensränta.
  </p>

  <div class="total-box">
    <div>
      <div class="label">Total skuld att driva in</div>
      <div class="meta">Kapital + påminnelseavgift + dröjsmålsränta</div>
    </div>
    <div class="amt">${formatSek(f.totalClaim)}</div>
  </div>

  <h2>Krav- och leveranshistorik</h2>
  <p class="meta">
    Avi utfärdad och skickad: ${notice.sentAt ? notice.sentAt.toLocaleDateString('sv-SE') : '–'}<br>
    Påminnelse skickad: ${notice.remindedAt ? notice.remindedAt.toLocaleDateString('sv-SE') : '–'}<br>
    Påminnelse levererad (verifierad): ${deliveredAt ?? '–'}<br>
    Markerad inkasso-redo: ${notice.collectionReadyAt ? notice.collectionReadyAt.toLocaleDateString('sv-SE') : '–'}<br>
    Lagrad påminnelsekopia: ${notice.reminderPdfStorageKey ? 'bifogad' : '–'}
  </p>

  <h2>Kontrakts- och fastighetsreferens</h2>
  <p class="meta">${escapeHtml(leaseRef)}</p>

  <p class="legal">
    Detta dokument är ett underlag för inkassoärende. Borgenären ansvarar för att
    skicka det vidare till sitt valda inkassobolag (t.ex. Visma Collectors, Intrum
    eller Lindorff). Påminnelseavgift (60 kr) utgår enligt lag (1981:739) om
    ersättning för inkassokostnader. Dröjsmålsränta beräknas enligt räntelagen
    (1975:635) 6 § (referensränta + 8 procentenheter) och redovisas per period
    enligt 9 §. <strong>Inkassobolaget ansvarar för att utfärda formellt
    inkassokrav enligt inkassolagen (1974:182) 5 § med skälig betalningstid innan
    betalningsföreläggande eller talan väcks.</strong> Eveno är ett
    fastighetssystem, bedriver INTE inkassoverksamhet och har inte tillstånd enligt
    inkassolagen.
  </p>`

    return buildBrandedPdfHtml({
      // hideFooter → shellen behöver bara namnet (brandMark utan logga).
      // Borgenärens fullständiga uppgifter ligger i Borgenär-boxen ovan.
      org: { name: org.name },
      logoDataUrl,
      primaryColor: org.invoiceColor ?? null,
      secondaryColor: org.brandSecondaryColor ?? null,
      brandFont: org.brandFont ?? null,
      title: 'Inkassounderlag – hyresfordran',
      contentHtml,
      // Footern DÖLJS (samma val + motivering som #126). Den juristkrävda
      // disclaimern (inkassolagen 1974:182 5 §, räntelagen, lag 1981:739 +
      // "Eveno bedriver INTE inkassoverksamhet") är ett BLOCKING-krav och MÅSTE
      // vara dokumentets sista ord. En generisk brand-footer efter den vore
      // strukturellt fel — och detta dokument visar medvetet INGET bankgiro
      // (betalningsvägen ägs av inkassobolaget). Borgenärens identitet finns
      // redan i Borgenär-boxen, så inget går förlorat.
      hideFooter: true,
    })
  }

  // Datum då påminnelsen verifierat levererades (Resend-webhook → EMAIL_DELIVERED).
  private deliveredAt(notice: RentNoticeWithCollectionData): string | null {
    const ev = notice.events.find((e) => e.type === 'EMAIL_DELIVERED')
    return ev ? ev.createdAt.toISOString().slice(0, 10) : null
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Läser segments[] ur en INTEREST_ACCRUED-payload med körtidskontroll (payloaden
// är ostrukturerad Json). Returnerar [] om formen inte stämmer.
function readSegments(payload: unknown): InterestSegment[] {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as { segments?: unknown }).segments
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      from: String(s.from ?? ''),
      to: String(s.to ?? ''),
      days: Number(s.days ?? 0),
      referenceRatePercent: Number(s.referenceRatePercent ?? 0),
      effectiveRatePercent: Number(s.effectiveRatePercent ?? 0),
      amount: Number(s.amount ?? 0),
    }))
}

// Kompakt, maskinläsbar kodning av räntesegmenten för CSV-kolumnen — en rad per
// halvår: "2026-01-01..2026-06-30:181d:10.00%:123.45 | 2026-07-01..2026-07-14:14d:10.50%:9.99".
function encodeSegments(segments: InterestSegment[]): string {
  return segments
    .map(
      (s) =>
        `${s.from}..${s.to}:${s.days}d:${s.effectiveRatePercent.toFixed(2)}%:${s.amount.toFixed(2)}`,
    )
    .join(' | ')
}

function formatSek(amount: number): string {
  return `${amount.toLocaleString('sv-SE', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} kr`
}

function csvCell(value: string): string {
  // CSV formula-injection (säkerhetsgranskning MEDIUM): ett gäldenärsnamn/adress
  // som börjar på = + - @ (eller tab/CR) körs som formel när inkassobolaget
  // öppnar filen i Excel/Calc. Neutralisera med ett inledande apostrof — fältet
  // är gäldenärs-/användarkontrollerat och hamnar i en fil som öppnas externt.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  const needsEscape = /[",\n]/.test(guarded)
  if (!needsEscape) return guarded
  return `"${guarded.replace(/"/g, '""')}"`
}
