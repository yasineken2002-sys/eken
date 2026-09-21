import { ConflictException, Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BankImportAttemptStatus } from '@prisma/client'

import { PrismaService } from '../common/prisma/prisma.service'
import {
  IMPORT_LEASE_TTL_MS,
  beräknaImportavtryck,
  type BankImportKind,
} from './bank-import-identity'

/**
 * FILNIVÅNS SAMTIDIGHETSSKYDD (#F034b).
 *
 * ── VAD BASEN GJORDE, OCH VAD DET KOSTADE ───────────────────────────────────
 *
 * Basen hade INGET filnivåskydd alls. Dedupen låg bara per rad, som
 * läs-sedan-skriv utan unikt index, och `reconciliation.service.ts` skrev ut
 * följden själv: "två PARALLELLA importer av samma fil kan fortfarande passera
 * båda". Mätt på basen `661e79e6` med överlappet tvingat av en barriär: en CSV
 * med EN inbetalningsrad, importerad två gånger samtidigt, gav **2**
 * BankTransaction-rader — och båda anropen svarade `imported: 1, duplicates: 0`.
 *
 * ── SKILJEDOMAREN ÄR DATABASEN, INTE PROCESSEN ──────────────────────────────
 *
 * `create` och fånga P2002 mot `@@unique([organizationId, fingerprint])`. En
 * mutex, ett `Map` eller ett `Set` i processminnet hade inte synts för en ANDRA
 * appinstans, och kravet är uttryckligen att skyddet ska hålla över den gränsen.
 *
 * ── ARRENDE, INTE LÅS ───────────────────────────────────────────────────────
 *
 * Ett lås som bara tas och släpps blir permanent upptaget när innehavaren dör.
 * Raden bär därför ett ARRENDE: `heartbeatAt` pulsas under körningen, och en
 * RUNNING-rad vars puls är äldre än `IMPORT_LEASE_TTL_MS` får övertas. Själva
 * övertagandet är en VILLKORAD `updateMany` på det gamla `heartbeatAt` — två
 * samtidiga övertaganden ger `count: 1` respektive `count: 0`, alltså exakt en
 * vinnare, utan något extra lås.
 *
 * ── DE FYRA LÄGENA OCH VAD DE BETYDER ───────────────────────────────────────
 *
 *   RUNNING + färsk puls   någon kör NU        → 409, inga rader, ingen täckning
 *   RUNNING + gammal puls  innehavaren är död  → överta och kör om
 *   SUCCEEDED              klar utan radfel    → spela upp det lagrade svaret
 *   PARTIAL / FAILED       ofullständig        → överta och kör om
 *
 * `PARTIAL` ÄR INTE `SUCCEEDED`, och det är inte en detalj. Ett halvt resultat
 * som spelas upp som ett klart cementerar felet: operatören ser "import klar",
 * rader saknas, och ingenting säger att något återstår.
 */

/** Vad som identifierar samma import. Se `KONTRAKT-IMPORTIDENTITET.md` §1. */
export interface Importavtryck {
  organizationId: string
  kind: BankImportKind
  fileName: string
  /** SHA-256 över filens råa bytes (PDF: över draftens id). */
  contentHash: string
  /** SHA-256 över mappning / bekräftat underlag. */
  mappingHash: string
}

/**
 * Vad körningen får veta om sitt eget anspråk.
 *
 * `övertagande` är INTE en detalj. En körning som TAR ÖVER ett fallet arrende
 * återupptar ett avbrutet arbete och får därför städa upp efter sig själv —
 * t.ex. plocka upp en PDF-draft som står kvar i `CONFIRMING`. En FÖRSTA körning
 * som möter samma halvfärdiga tillstånd möter någon ANNANS pågående arbete och
 * måste backa. Utan flaggan går de två inte att skilja åt, och koden hade
 * tvingats välja ett av felen: antingen låsa den avbrutna draften för alltid,
 * eller låta två samtidiga bekräftelser skriva bankrader från samma underlag.
 */
export interface Körkontext {
  /** Pulsar arrendet. Anropas med jämna mellanrum under långa loopar. */
  pulsa: () => Promise<void>
  /** `true` när körningen tog över ett fallet, partiellt eller misslyckat försök. */
  övertagande: boolean
}

/** Vad en körning rapporterar tillbaka om sig själv. */
export interface Körutfall<T> {
  resultat: T
  /**
   * `true` när körningen slutfördes men lämnade radfel eller inte kunde läsa
   * hela filen. Styr `PARTIAL` i stället för `SUCCEEDED`.
   */
  partiellt: boolean
}

export interface Importkvittens<T> {
  resultat: T
  /** `true` när svaret kommer från en TIDIGARE lyckad körning, inte en ny. */
  replayed: boolean
  /** RUNNING sätts aldrig här — kvittensen returneras först när körningen är klar. */
  status: Extract<BankImportAttemptStatus, 'SUCCEEDED' | 'PARTIAL'>
  /** Hur många gånger avtrycket har körts, övertaganden inräknade. */
  försöksnummer: number
  /** När det avtryck svaret gäller kördes. */
  kördesAt: Date
}

/** Kastas när ett annat, levande försök redan håller arrendet. */
export class ImportPågårError extends ConflictException {
  constructor(
    readonly startadAt: Date,
    readonly försöksnummer: number,
  ) {
    super({
      code: 'IMPORT_PAGAR',
      message:
        'Samma fil importeras redan just nu. Vänta tills den pågående importen är klar — ' +
        'inga rader har skapats av det här försöket.',
      startadAt: startadAt.toISOString(),
      // ASCII-nyckel med flit: fältnamnet går över tråden till klienter, och
      // `försöksnummer` hade varit ett icke-ASCII-namn i ett JSON-kontrakt.
      // Svenskan hör hemma i TEXTEN, inte i nycklarna. Speglar `forsokNr` i
      // `ImportAttemptInfo`.
      forsokNr: försöksnummer,
    })
  }
}

@Injectable()
export class BankImportAttemptService {
  private readonly logger = new Logger(BankImportAttemptService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kör `körning` HÖGST EN GÅNG per avtryck.
   *
   * `körning` får en `pulsa`-callback som ska anropas med jämna mellanrum under
   * långa loopar. Utan puls faller arrendet efter `IMPORT_LEASE_TTL_MS` och en
   * långsam men LEVANDE import kan övertas mitt i sig själv.
   */
  async körEnGång<T>(
    avtryck: Importavtryck,
    körning: (ctx: Körkontext) => Promise<Körutfall<T>>,
  ): Promise<Importkvittens<T>> {
    const fingerprint = beräknaImportavtryck({
      organizationId: avtryck.organizationId,
      // Målet är organisationen. Se noten i bank-import-identity.ts — det är en
      // redovisad gräns i datamodellen, inte ett val som gjorts här.
      mål: avtryck.organizationId,
      kind: avtryck.kind,
      contentHash: avtryck.contentHash,
      mappingHash: avtryck.mappingHash,
    })

    const anspråk = await this.taAnspråk(avtryck, fingerprint)
    if (anspråk.sortering === 'uppspelning') {
      return {
        resultat: anspråk.resultat as T,
        replayed: true,
        status: 'SUCCEEDED',
        försöksnummer: anspråk.försöksnummer,
        kördesAt: anspråk.kördesAt,
      }
    }

    const attemptId = anspråk.attemptId
    const pulsa = async (): Promise<void> => {
      // En puls som inte går igenom får ALDRIG fälla importen. Tappas arrendet
      // är det i värsta fall ett övertagande — och radnivåns unika index gör
      // ett övertagande ofarligt för bankraderna.
      try {
        await this.prisma.bankImportAttempt.update({
          where: { id: attemptId },
          data: { heartbeatAt: new Date() },
        })
      } catch (err) {
        this.logger.warn(
          `Arrendets puls kunde inte skrivas för import ${attemptId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    let utfall: Körutfall<T>
    try {
      utfall = await körning({ pulsa, övertagande: anspråk.övertagande })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // FAILED, inte borttagen rad. Att radera anspråket hade gjort försöket
      // osynligt — och ett upprepat fel på samma fil är precis det en operatör
      // behöver kunna se att det HAR hänt förut.
      await this.prisma.bankImportAttempt
        .update({
          where: { id: attemptId },
          data: { status: 'FAILED', finishedAt: new Date(), errorMessage: message.slice(0, 2000) },
        })
        .catch(() => undefined)
      throw err
    }

    const status: 'SUCCEEDED' | 'PARTIAL' = utfall.partiellt ? 'PARTIAL' : 'SUCCEEDED'
    const klar = await this.prisma.bankImportAttempt.update({
      where: { id: attemptId },
      data: {
        status,
        finishedAt: new Date(),
        errorMessage: null,
        // BARA ett SUCCEEDED-resultat spelas upp igen, men vi lagrar även
        // PARTIAL:s utfall: det är kvittensen på vad som faktiskt hände, och
        // den behövs för att kunna visa "delvis misslyckad" med siffror.
        resultJson: utfall.resultat as unknown as Prisma.InputJsonValue,
      },
      select: { attempt: true, startedAt: true },
    })

    return {
      resultat: utfall.resultat,
      replayed: false,
      status,
      försöksnummer: klar.attempt,
      kördesAt: klar.startedAt,
    }
  }

  // ── Anspråket ─────────────────────────────────────────────────────────────

  private async taAnspråk(
    avtryck: Importavtryck,
    fingerprint: string,
  ): Promise<
    | { sortering: 'kör'; attemptId: string; övertagande: boolean }
    | { sortering: 'uppspelning'; resultat: unknown; försöksnummer: number; kördesAt: Date }
  > {
    try {
      const skapad = await this.prisma.bankImportAttempt.create({
        data: {
          organizationId: avtryck.organizationId,
          fingerprint,
          kind: avtryck.kind,
          fileName: avtryck.fileName,
          contentHash: avtryck.contentHash,
          mappingHash: avtryck.mappingHash,
          status: 'RUNNING',
        },
        select: { id: true },
      })
      return { sortering: 'kör', attemptId: skapad.id, övertagande: false }
    } catch (err) {
      if (!ärUniktVillkorsfel(err)) throw err
      // Någon annan hann före. Vad som gäller avgörs av DERAS rad, inte av vår.
    }

    const befintlig = await this.prisma.bankImportAttempt.findUnique({
      where: {
        organizationId_fingerprint: { organizationId: avtryck.organizationId, fingerprint },
      },
      select: {
        id: true,
        status: true,
        attempt: true,
        startedAt: true,
        heartbeatAt: true,
        resultJson: true,
      },
    })
    if (!befintlig) {
      // Raden fanns vid `create` men inte nu. Enda kända vägen dit är en
      // manuell radering mellan de två frågorna. Vi gissar inte — vi säger att
      // det är upptaget, vilket är den säkra riktningen (inga rader skrivs).
      throw new ImportPågårError(new Date(), 0)
    }

    if (befintlig.status === 'SUCCEEDED') {
      return {
        sortering: 'uppspelning',
        resultat: befintlig.resultJson,
        försöksnummer: befintlig.attempt,
        kördesAt: befintlig.startedAt,
      }
    }

    if (befintlig.status === 'RUNNING') {
      const ålder = Date.now() - befintlig.heartbeatAt.getTime()
      if (ålder < IMPORT_LEASE_TTL_MS) {
        throw new ImportPågårError(befintlig.startedAt, befintlig.attempt)
      }
    }

    // PARTIAL, FAILED eller ett RUNNING vars arrende har fallit → överta.
    //
    // VILLKORET PÅ `heartbeatAt` OCH `status` ÄR HELA MEKANIKEN. Två samtidiga
    // övertaganden läser samma rad och skickar samma villkor; Postgres låter
    // exakt ett av dem träffa. Förloraren får `count: 0` och ska INTE köra.
    const övertagen = await this.prisma.bankImportAttempt.updateMany({
      where: { id: befintlig.id, status: befintlig.status, heartbeatAt: befintlig.heartbeatAt },
      data: {
        status: 'RUNNING',
        attempt: { increment: 1 },
        startedAt: new Date(),
        heartbeatAt: new Date(),
        finishedAt: null,
        errorMessage: null,
      },
    })
    if (övertagen.count !== 1) {
      throw new ImportPågårError(befintlig.startedAt, befintlig.attempt)
    }

    this.logger.log(
      `Importförsök övertaget: org=${avtryck.organizationId} kind=${avtryck.kind} ` +
        `fil=${avtryck.fileName} tidigare=${befintlig.status} försök=${befintlig.attempt + 1}`,
    )
    return { sortering: 'kör', attemptId: befintlig.id, övertagande: true }
  }
}

/**
 * P2002 = unikt villkor brutet. Avgränsat till felkoden och inte till ett
 * index-NAMN: den enda unika nyckeln på `BankImportAttempt` är
 * `(organizationId, fingerprint)`, så ett P2002 härifrån kan inte komma från
 * något annat villkor. Läggs en andra unik nyckel till på modellen måste den
 * här avgränsningen skärpas — det står här för att den läsaren ska se det.
 */
function ärUniktVillkorsfel(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}
