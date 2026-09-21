import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import type { Prisma } from '@prisma/client'
import { isValidOcrNumber } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import {
  PdfStatementParserService,
  MAX_TX_AMOUNT,
  DEFAULT_MAX_BANK_TX_AMOUNT,
  type ParsedBankStatement,
  type ParsedTransaction,
} from './pdf-statement-parser.service'
import { ReconciliationService, type ImportAttemptInfo } from './reconciliation.service'
import { BankImportAttemptService } from './bank-import-attempt.service'
import { Förekomsträknare, hashaBytes, radIdentitetFil } from './bank-import-identity'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import {
  validateUploadedFile,
  DETECTED_PDF_TYPES,
  MAX_PDF_BYTES,
} from '../common/utils/file-validation'
import type { BankStatementImportStatus } from '@prisma/client'

export interface ImportCommitResult {
  importId: string
  created: number
  duplicates: number
  autoMatched: number
  unmatched: number
  /** #F034b — se `ImportAttemptInfo` i reconciliation.service.ts. */
  forsok?: ImportAttemptInfo
}

/**
 * Vad `GET /reconciliation/imports/:id` bär. Se noten på `getImport` för vad som
 * medvetet utelämnats och varför — kort: kontoutdragets INNEHÅLL
 * (`parsedData`/`originalParsedData`/`confirmedData`) och organisationens
 * `accountNumber` hör inte till en statusuppslagning.
 */
export interface BankStatementImportSummary {
  id: string
  status: BankStatementImportStatus
  fileName: string
  fileType: string
  fileSize: number
  bank: string | null
  periodStart: Date | null
  periodEnd: Date | null
  transactionCount: number
  matchedCount: number | null
  unmatchedCount: number | null
  errorMessage: string | null
  uploadedAt: Date
  confirmedAt: Date | null
}

@Injectable()
export class BankStatementImportService {
  private readonly logger = new Logger(BankStatementImportService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: PdfStatementParserService,
    private readonly reconciliation: ReconciliationService,
    // PR 4 (B) — en bekräftad PDF-import flyttar fram paymentDataThrough till
    // utdragets periodslut (eller senaste transaktionsdatum om periodslut saknas).
    private readonly freshness: PaymentFreshnessService,
    // #F034b — samma filnivåskydd som CSV/BgMax. Se noten på `confirmImport`
    // för vad som är avtryckets innehåll i den HÄR vägen.
    private readonly attempts: BankImportAttemptService,
  ) {}

  // ── Steg 1: ladda upp PDF, parse, spara som DRAFT (PARSED) ────────────
  async uploadAndParsePdf(
    fileBuffer: Buffer,
    fileName: string,
    organizationId: string,
    userId: string | null,
  ): Promise<{ id: string; status: string; parsed: ParsedBankStatement }> {
    await this.freshness.recordImportStarted(organizationId)
    // SECURITY (H3): verifiera att filen faktiskt är en PDF (magiska byten
    // %PDF) och inte överskrider taket innan vi skickar den till Claude som
    // document-block. Den klient-deklarerade filändelsen räcker inte.
    validateUploadedFile(fileBuffer, {
      allowedDetectedMimes: DETECTED_PDF_TYPES,
      maxBytes: MAX_PDF_BYTES,
    })

    const fileSize = fileBuffer.length

    // Skapa raden FÖRST (status=PARSING) så vi har en audit-trail även om
    // AI-tolkningen kraschar mid-flight. Vid fel uppdaterar vi till FAILED.
    const draft = await this.prisma.bankStatementImport.create({
      data: {
        organizationId,
        fileName,
        fileType: 'pdf',
        fileSize,
        status: 'PARSING',
        ...(userId ? { uploadedById: userId } : {}),
      },
    })

    const maxTxAmount = await this.resolveMaxTxAmount(organizationId)

    let parsed: ParsedBankStatement
    try {
      parsed = await this.parser.parse(fileBuffer, organizationId, userId, maxTxAmount)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.prisma.bankStatementImport.update({
        where: { id: draft.id },
        data: { status: 'FAILED', errorMessage: message },
      })
      throw err
    }

    // BFL 5 kap 11 §: bevara AI:ns råtolkning immutabelt i originalParsedData
    // (sätts EN gång här, rörs aldrig igen) parallellt med den redigerbara
    // preview-listan i parsedData. Identiska vid PARSED; divergerar om
    // operatören redigerar innan confirm.
    const transactionsJson = {
      transactions: parsed.transactions,
    } as unknown as Prisma.InputJsonValue
    const updated = await this.prisma.bankStatementImport.update({
      where: { id: draft.id },
      data: {
        status: 'PARSED',
        bank: parsed.bank,
        accountNumber: parsed.accountNumber,
        ...(parsed.periodStart ? { periodStart: new Date(parsed.periodStart) } : {}),
        ...(parsed.periodEnd ? { periodEnd: new Date(parsed.periodEnd) } : {}),
        originalParsedData: transactionsJson,
        parsedData: transactionsJson,
        transactionCount: parsed.transactions.length,
      },
    })

    return { id: updated.id, status: updated.status, parsed }
  }

  // ── Hämta DRAFT (för granskningsvyn) ────────────────────────────────────
  /**
   * MINIMAL PROJEKTION — och en not om varför den är just minimal.
   *
   * Endpointen har NOLL frontend-anropare. Mätt i web, admin och portal: PDF-
   * flödet använder svaret från `uploadAndParsePdf` direkt och går sedan till
   * `confirm`; ingen väg återhämtar utkastet. Svaret projiceras därför till det
   * endpointen logiskt lovar — "hämta en DRAFT för granskning" — och inte till
   * allt raden råkar bära.
   *
   * UTELÄMNAT, med skälet:
   *   accountNumber        organisationens kontonummer. Oläst: förhandsgransknings-
   *                        modalen tar sitt accountNumber ur `draft.parsed`
   *                        (ParsedBankStatement från AI-tolkningen), inte ur den
   *                        här kolumnen. De två har samma namn, vilket är precis
   *                        hur ett sådant fält överlever en dataminimering.
   *   parsedData           hela det tolkade kontoutdraget: betalarnamn, belopp,
   *                        OCR. Förhandsgranskningen får det ur uppladdningssvaret.
   *   originalParsedData   AI:ns råtolkning, bevarad för BFL-behandlingshistorik.
   *   confirmedData        listan som faktiskt commitades. Räkenskapsinformation.
   *
   * Att lägga tillbaka något av dem ska vara ett BESLUT, inte en återställning av
   * något någon tror fanns. Mätningen ovan är underlaget.
   */
  async getImport(id: string, organizationId: string): Promise<BankStatementImportSummary> {
    const row = await this.prisma.bankStatementImport.findFirst({
      where: { id, organizationId },
    })
    if (!row) throw new NotFoundException('Importen hittades inte')
    // Handprojicering, inte bara en typ: en deklarerad returtyp ensam hade låtit
    // fälten gå över tråden och bara dolt dem för TypeScript.
    return {
      id: row.id,
      status: row.status,
      fileName: row.fileName,
      fileType: row.fileType,
      fileSize: row.fileSize,
      bank: row.bank,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      transactionCount: row.transactionCount,
      matchedCount: row.matchedCount,
      unmatchedCount: row.unmatchedCount,
      errorMessage: row.errorMessage,
      uploadedAt: row.uploadedAt,
      confirmedAt: row.confirmedAt,
    }
  }

  // ── Steg 2: användaren bekräftar → commit BankTransaction-rader ──────
  // Tar emot eventuellt redigerad lista av transaktioner från klienten.
  // Vi ersätter parsedData med den slutgiltiga listan så audit-trailen
  // speglar vad som faktiskt skrevs.
  async confirmImport(
    id: string,
    organizationId: string,
    userId: string | null,
    edited?: unknown[],
  ): Promise<ImportCommitResult> {
    const draft = await this.prisma.bankStatementImport.findFirst({
      where: { id, organizationId },
    })
    if (!draft) throw new NotFoundException('Importen hittades inte')
    await this.freshness.recordImportStarted(organizationId)
    // ── VARFÖR `CONFIRMED` INTE AVVISAS HÄR (#F034b) ───────────────────────
    //
    // Basen kastade "redan bekräftad" direkt på en CONFIRMED draft. Det svaret
    // är rätt för en bekräftelse med ett NYTT underlag — men fel för en
    // UPPREPNING av exakt samma bekräftelse, som kan uppstå av ett omtryck, ett
    // nätverksavbrott eller en klient som skickar om. Där ska operatören få se
    // vad som faktiskt hände, inte ett felmeddelande om sitt eget lyckade
    // arbete.
    //
    // Frågan kan därför bara avgöras EFTER att avtrycket är räknat, och den
    // avgörs på två ställen med två olika svar:
    //
    //   samma avtryck  → `körEnGång` spelar upp den lagrade kvittensen
    //   annat avtryck  → körningen startar, draft-anspråket nedan nekar, och
    //                    DÄR kastas "redan bekräftad"
    //
    // CANCELLED, FAILED och PARSING avvisas fortfarande direkt: för dem finns
    // ingen lyckad körning att spela upp och ingen väg framåt.
    if (
      draft.status !== 'PARSED' &&
      draft.status !== 'CONFIRMING' &&
      draft.status !== 'CONFIRMED'
    ) {
      throw new BadRequestException(
        `Importen är i status ${draft.status} och kan inte bekräftas — bara PARSED-importer.`,
      )
    }

    const maxTxAmount = await this.resolveMaxTxAmount(organizationId)
    const finalTx: ParsedTransaction[] = Array.isArray(edited)
      ? this.sanitizeEdited(edited, maxTxAmount)
      : this.extractFromDraft(draft.parsedData, maxTxAmount)

    // ── FILNIVÅNS AVTRYCK (#F034b) ─────────────────────────────────────────
    //
    // `contentHash` är draftens id, INTE PDF:ens bytes. Det är BEKRÄFTELSEN som
    // skriver bankrader; uppladdningen skapar bara ett utkast. Laddas samma PDF
    // upp två gånger får den två draft-id:n och alltså två avtryck — det är en
    // ärvd egenskap av att AI-tolkningen är icke-deterministisk, inte något det
    // här skyddet kan eller ska dölja.
    //
    // `mappingHash` är det KANONISERADE BEKRÄFTADE UNDERLAGET, efter
    // `sanitizeEdited`. Det är exakt den lista operatören godkände. Ändras
    // listan ändras avtrycket, och bekräftelsen körs om i stället för att tyst
    // få det gamla lyckade svaret (krav 6).
    const kvittens = await this.attempts.körEnGång<ImportCommitResult>(
      {
        organizationId,
        kind: 'PDF_CONFIRM',
        fileName: draft.fileName,
        contentHash: hashaBytes(Buffer.from(draft.id, 'utf8')),
        mappingHash: hashaBytes(
          Buffer.from(
            JSON.stringify(
              finalTx.map((t) => [t.date, t.description, t.ocr ?? '', t.amount, t.isIncoming]),
            ),
            'utf8',
          ),
        ),
      },
      ({ övertagande }) => this.körPdfConfirm(draft, organizationId, userId, finalTx, övertagande),
    )
    return {
      ...kvittens.resultat,
      forsok: {
        status: kvittens.status === 'PARTIAL' ? 'DELVIS' : 'KLAR',
        replayed: kvittens.replayed,
        forsokNr: kvittens.försöksnummer,
        kordesAt: kvittens.kördesAt.toISOString(),
      },
    }
  }

  /**
   * Commiten. Körs av `attempts.körEnGång` — högst en gång per avtryck.
   *
   * ── ANSPRÅKET PÅ DRAFTEN, OCH VARFÖR DET INTE RÄCKER MED AVTRYCKET ───────
   *
   * Avtrycket bär den bekräftade LISTAN. Två bekräftelser av samma draft med
   * OLIKA listor är därför två olika avtryck, och filnivåskyddet släpper med
   * rätta igenom båda — de är inte samma import. Utan ett anspråk på själva
   * DRAFTEN hade de två då kunnat skriva bankrader från samma underlag
   * samtidigt.
   *
   * Anspråket är en status-guardad `updateMany` PARSED → CONFIRMING. Dess
   * `count` är svaret: exakt en kan ta en draft som står i PARSED.
   */
  private async körPdfConfirm(
    draft: {
      id: string
      fileName: string
      periodEnd: Date | null
      status: BankStatementImportStatus
    },
    organizationId: string,
    userId: string | null,
    finalTx: ParsedTransaction[],
    övertagande: boolean,
  ): Promise<{ resultat: ImportCommitResult; partiellt: boolean }> {
    const id = draft.id
    const anspråk = await this.prisma.bankStatementImport.updateMany({
      where: { id, organizationId, status: 'PARSED' },
      data: { status: 'CONFIRMING' },
    })
    if (anspråk.count !== 1) {
      const nu = await this.prisma.bankStatementImport.findFirst({
        where: { id, organizationId },
        select: { status: true },
      })
      if (nu?.status === 'CONFIRMED') {
        // Draften är färdigbekräftad, och det här avtrycket är ett ANNAT
        // underlag än det som bekräftades (samma underlag hade spelats upp av
        // `körEnGång` och aldrig nått hit). Ett nytt underlag mot en redan
        // bekräftad import är inte en upprepning — det är en andra bokföring.
        throw new BadRequestException('Importen är redan bekräftad och kan inte bekräftas igen.')
      }
      if (nu?.status !== 'CONFIRMING') {
        throw new BadRequestException(
          `Importen är i status ${nu?.status ?? 'okänd'} och kan inte bekräftas — bara PARSED-importer.`,
        )
      }
      // ── CONFIRMING: TVÅ HELT OLIKA SITUATIONER MED SAMMA UTSEENDE ───────
      //
      // (a) VI återupptar vår EGEN avbrutna commit. Arrendet på importförsöket
      //     hade fallit, vi tog över det, och draften står kvar där processen
      //     dog. Att neka här hade låst draften för alltid.
      //
      // (b) NÅGON ANNAN bekräftar just nu, med ett ANNAT underlag. Två olika
      //     listor ger två olika avtryck, så filnivåskyddet släpper med rätta
      //     igenom båda — och utan den här grenen hade båda skrivit bankrader
      //     från samma draft. Det är en andra bokföring, inte en upprepning.
      //
      // `övertagande` är det enda som skiljer dem åt, och det kommer från
      // importförsökets rad: bara ett övertagande av ett FALLET arrende får
      // plocka upp en CONFIRMING-draft.
      if (!övertagande) {
        throw new ConflictException({
          code: 'BEKRAFTELSE_PAGAR',
          message:
            'Importen bekräftas redan just nu av ett annat försök. ' +
            'Vänta tills det är klart — inga rader har skapats av det här försöket.',
        })
      }
    }

    // ── SLÄPP DRAFTEN OM KÖRNINGEN KASTAR ──────────────────────────────────
    //
    // Utan det här hade varje avbrutet commit lämnat draften i `CONFIRMING`,
    // och nästa försök hade fått vänta ut importförsökets hela arrende (15 min)
    // innan det ens fick plocka upp den. Ett fel som går att rätta direkt ska
    // inte kosta ett arrende.
    //
    // Släppet är status-GUARDAT på `CONFIRMING`: har någon annan hunnit ta
    // draften vidare rör vi den inte. Och det får aldrig maskera det
    // ursprungliga felet — därför `.catch(() => undefined)` och `throw err`.
    try {
      return await this.skrivPdfCommit(draft, organizationId, userId, finalTx)
    } catch (err) {
      await this.prisma.bankStatementImport
        .updateMany({
          where: { id, organizationId, status: 'CONFIRMING' },
          data: { status: 'PARSED' },
        })
        .catch(() => undefined)
      throw err
    }
  }

  /** Själva commiten. Anropas först när draft-anspråket är taget. */
  private async skrivPdfCommit(
    draft: { id: string; fileName: string; periodEnd: Date | null },
    organizationId: string,
    userId: string | null,
    finalTx: ParsedTransaction[],
  ): Promise<{ resultat: ImportCommitResult; partiellt: boolean }> {
    const id = draft.id
    // Endast inbetalningar (positiva belopp) ska skapa BankTransactions —
    // samma som CSV/BgMax-flödena. Uttag/avgifter visas i preview men
    // commitas inte (de matchas inte mot fakturor/avier).
    const incoming = finalTx.filter((t) => t.amount > 0)

    let created = 0
    let duplicates = 0
    let autoMatched = 0
    let unmatched = 0
    // #F034b — matchfel räknas separat från `unmatched`. `unmatched` är ett
    // FÖRVÄNTAT utfall (väntar på manuell matchning); ett matchfel är ett fel.
    // Slås de ihop kan ett driftfel inte skilja ut sig, och körningen hade
    // rapporterats som KLAR.
    let matchFel = 0
    // #F034b — förekomstnummer per radidentitet INOM DEN HÄR bekräftade listan.
    const förekomster = new Förekomsträknare()

    for (const t of incoming) {
      const amountDecimal = new Decimal(t.amount.toFixed(2))
      const date = new Date(t.date)

      // Delad ingest-kärna (samma pipeline som CSV/BgMax): fält-dedup identisk med
      // CSV-importen (org, date, description, amount, reference) → create →
      // matchTransaction.
      //
      // `reference` ingår av samma SKADESKÄL som i CSV-importen: utan den räknades
      // två hyresgästers lika stora inbetalningar samma dag som EN, och den andras
      // pengar nådde aldrig databasen. Fältet är det som faktiskt lagras på raden
      // nedan (`reference: t.ocr`), så nyckeln frågar efter exakt det värde den
      // själv skriver — och `|| null` gör "ingen OCR" till ett eget värde i
      // stället för en joker.
      //
      // ── MEN CSV:S HÅLLBARHETSARGUMENT GÄLLER INTE HÄR. LÄS INTE IN DET. ──────
      //
      // I CSV-vägen motiveras `reference` med att kolumnen lagras ORDAGRANT och
      // aldrig räknas om av någon kodversion. Det är sant där. Det är INTE sant
      // här: värdet som skrivs är `t.ocr`, och `t.ocr` har passerat
      // `sanitizeEdited` nedan, som nollställer ett OCR som inte är Luhn-giltigt.
      // PDF-vägens `reference` är alltså ett SANERAT värde, inte ett rått.
      //
      // Saneringen är YNGRE än skrivningen. `reference: t.ocr` kom med `93f2765e`
      // (2026-05-28); Luhn-filtret i `sanitizeEdited` kom med `e57ff7bb`
      // (2026-05-31). En `BankTransaction` som PDF-vägen skrev i det fönstret kan
      // alltså bära ett `reference` som dagens sanering skulle nollställa.
      //
      // KONKRET FORM PÅ RISKEN: en sådan rad bär t.ex. `reference = '20260601'`.
      // Laddas samma PDF upp och bekräftas i dag blir `t.ocr` null, dedupen frågar
      // `reference: null`, den lagrade raden svarar inte — och en ANDRA bankrad
      // skapas för samma betalning, med allokering och bokföring.
      //
      // DETTA ÄR INTE MÄTT. Ingen produktionspopulation är räknad och ingen
      // verklig historisk återimport är körd. Fönstrets längd säger ingenting om
      // hur många rader som ligger i det, och antalet är okänt — inte litet.
      //
      // ÄRVD BEGRÄNSNING DÄRUTÖVER: PDF-vägens tolkning är AI-buren och
      // icke-deterministisk (`schema.prisma` vid `originalParsedData`). Laddas
      // samma PDF upp igen och AI:n läser ett annat OCR blir det en ny rad — men
      // det gällde redan `description`, som låg i nyckeln före den här ändringen.
      // #F034b — samma fält som `dedup` nedan, i den form det partiella unika
      // indexet kan bära. SAMMA NAMNRYMD som CSV-vägen med flit: de två vägarna
      // dedupar redan mot varandra i dag (identisk fältuppsättning mot samma
      // tabell), och att namnrymda på filväg hade tagit bort det skyddet ur
      // indexet.
      const identityKey = radIdentitetFil({
        date,
        description: t.description,
        amount: amountDecimal,
        reference: t.ocr || null,
      })

      const outcome = await this.reconciliation.ingestFromFile(organizationId, {
        dedup: {
          date,
          description: t.description,
          amount: amountDecimal,
          reference: t.ocr || null,
        },
        identity: { key: identityKey, seq: förekomster.nästa(identityKey) },
        data: {
          date,
          description: t.description,
          amount: amountDecimal,
          ...(t.ocr ? { rawOcr: t.ocr, reference: t.ocr } : {}),
        },
        crossSource: { date, amount: amountDecimal, ...(t.ocr ? { ocr: t.ocr } : {}) },
      })
      if (outcome.duplicate) {
        duplicates++
        continue
      }
      created++

      if (outcome.matchError) {
        // Matchning kan kasta vid kantfall (t.ex. korrupt journal-state).
        // Vi backar inte — transaktionen ligger kvar som UNMATCHED och
        // operatören får hantera manuellt.
        this.logger.error(
          `matchTransaction failed för tx=${outcome.transactionId}: ${outcome.matchError.message}`,
        )
        matchFel++
        unmatched++
      } else if (outcome.matched) {
        autoMatched++
      } else {
        unmatched++
      }
    }

    // BFL 5 kap 11 §: skriv den bekräftade listan till confirmedData (immutabel,
    // sätts EN gång här) — INTE över parsedData. originalParsedData (AI:ns
    // råtolkning) och parsedData (granskat preview-tillstånd) lämnas orörda så att
    // hela behandlingshistoriken AI → granskning → commit kan rekonstrueras.
    await this.prisma.bankStatementImport.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        ...(userId ? { confirmedById: userId } : {}),
        confirmedData: { transactions: finalTx } as unknown as Prisma.InputJsonValue,
        transactionCount: finalTx.length,
        matchedCount: autoMatched,
        unmatchedCount: unmatched + duplicates,
      },
    })

    // PR 4 (B) — täckningsdatum = AI-extraherat periodslut (mest exakt: utdraget
    // täcker hela perioden även dagar utan inbetalning) annars senaste commitade
    // transaktionsdatum. Penganeutral sidoeffekt; får aldrig fälla bekräftelsen.
    const coverage =
      draft.periodEnd ??
      finalTx.reduce<Date | null>((max, t) => {
        const d = new Date(t.date)
        return !isNaN(d.getTime()) && (!max || d > max) ? d : max
      }, null)
    if (coverage) {
      try {
        await this.freshness.recordPaymentDataThrough(organizationId, coverage)
      } catch (err) {
        this.logger.error(
          `paymentDataThrough kunde inte uppdateras efter PDF-import ${id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // PARTIELLT när matchningen kastade för minst en rad. Raden ÄR lagrad och
    // ligger som UNMATCHED — policyn är oförändrad — men körningen lämnade ett
    // fel efter sig och får därför inte spelas upp som ett klart resultat.
    return {
      resultat: { importId: id, created, duplicates, autoMatched, unmatched },
      partiellt: matchFel > 0,
    }
  }

  async cancelImport(id: string, organizationId: string): Promise<void> {
    const draft = await this.prisma.bankStatementImport.findFirst({
      where: { id, organizationId },
    })
    if (!draft) throw new NotFoundException('Importen hittades inte')
    if (draft.status === 'CONFIRMED') {
      throw new ForbiddenException('En bekräftad import kan inte avbrytas.')
    }
    // #F034b — CONFIRMING är ett NYTT läge, och utan den här raden hade det
    // öppnat en lucka som inte fanns på basen: en avbrytning mitt i en pågående
    // commit hade satt CANCELLED, commiten hade sedan skrivit CONFIRMED över
    // den, och bankraderna hade legat under en import operatören tror är
    // avbruten. Avbrytningen är inte förbjuden — den är för TIDIG.
    if (draft.status === 'CONFIRMING') {
      throw new ConflictException({
        code: 'BEKRAFTELSE_PAGAR',
        message:
          'Importen bekräftas just nu och kan inte avbrytas mitt i. ' +
          'Vänta tills bekräftelsen är klar.',
      })
    }
    // Status-GUARDAT: avbrytningen får bara träffa den draft vi faktiskt läste.
    // Hann en bekräftelse ta den mellan läsningen och skrivningen ska vi inte
    // skriva över dess läge — `count: 0` betyder att någon annan hann före.
    const avbruten = await this.prisma.bankStatementImport.updateMany({
      where: { id, organizationId, status: draft.status },
      data: { status: 'CANCELLED' },
    })
    if (avbruten.count !== 1) {
      throw new ConflictException({
        code: 'BEKRAFTELSE_PAGAR',
        message:
          'Importens läge ändrades precis av ett annat försök och den kunde inte avbrytas. ' +
          'Ladda om och försök igen.',
      })
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  // Per-org beloppsrimlighetsgräns (#36). Default 5 MSEK via schema; clampas
  // alltid till absolut tak (MAX_TX_AMOUNT, 50 MSEK) som defense-in-depth även
  // om ett orimligt värde skulle ligga i DB. Saknas orgen används defaulten.
  private async resolveMaxTxAmount(organizationId: string): Promise<number> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { maxBankTxAmount: true },
    })
    const configured = org ? Number(org.maxBankTxAmount) : DEFAULT_MAX_BANK_TX_AMOUNT
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MAX_BANK_TX_AMOUNT
    return Math.min(configured, MAX_TX_AMOUNT)
  }

  private extractFromDraft(
    parsedData: Prisma.JsonValue | null,
    maxTxAmount: number = DEFAULT_MAX_BANK_TX_AMOUNT,
  ): ParsedTransaction[] {
    if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData)) return []
    const obj = parsedData as Record<string, unknown>
    if (!Array.isArray(obj.transactions)) return []
    return this.sanitizeEdited(obj.transactions as unknown[], maxTxAmount)
  }

  // Saneras både för icke-redigerade drafts (via extractFromDraft) och för
  // klientskickade redigerade transaktioner vid confirm. SECURITY (RISK 2):
  // detta är den FAKTISKA skrivvägen till BankTransaction — den måste tillämpa
  // SAMMA OCR-Luhn- och beloppsskydd som parserns validate(), annars kan en
  // MANAGER+ kringgå parser-skyddet genom att skicka en fabricerad OCR/belopp
  // i confirm-bodyn → fabricerad betalning bokförs (BFL 5 kap 6–7 §§).
  private sanitizeEdited(
    edited: unknown[],
    maxTxAmount: number = DEFAULT_MAX_BANK_TX_AMOUNT,
  ): ParsedTransaction[] {
    const out: ParsedTransaction[] = []
    let strippedOcr = 0
    let flaggedAmounts = 0
    for (const raw of edited) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const date = typeof r.date === 'string' ? r.date.trim() : ''
      const description = typeof r.description === 'string' ? r.description.trim() : ''
      const amountRaw = r.amount
      const amount = typeof amountRaw === 'number' ? amountRaw : parseFloat(String(amountRaw))
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      if (!Number.isFinite(amount)) continue
      if (Math.abs(amount) > maxTxAmount) {
        flaggedAmounts++
        continue
      }
      // OCR måste vara Luhn-mod10-giltig — annars nollställs den så den aldrig
      // auto-matchar en avi. Samma kontroll som i parserns validate().
      const ocrVal = r.ocr
      let ocr: string | null = null
      if (typeof ocrVal === 'string' && ocrVal.trim().length > 0) {
        const candidate = ocrVal.trim()
        if (isValidOcrNumber(candidate)) ocr = candidate
        else strippedOcr++
      }
      const isIncoming = typeof r.isIncoming === 'boolean' ? r.isIncoming : amount > 0
      out.push({ date, description: description.slice(0, 120), ocr, amount, isIncoming })
    }
    if (strippedOcr || flaggedAmounts) {
      this.logger.warn(
        `[PDF-import] confirm sanering: ${strippedOcr} ogiltiga OCR nollställda, ` +
          `${flaggedAmounts} orimliga belopp avvisade.`,
      )
    }
    return out
  }
}
