/**
 * NULL-SVEPET — det som gör "okänt" omöjligt att vara ett tyst normaltillstånd.
 *
 * ── PROBLEMET DEN LÖSER ─────────────────────────────────────────────────────
 *
 * `actorKind` är nullbar, och NULL betyder OKÄNT. Det gör ett TOTALT HAVERI
 * omöjligt att skilja från gammalt data: kopplas `actorStampExtension` bort
 * eller slutar en gräns sättas får varje ny rad NULL, och NULL är ett giltigt
 * värde. Sviten är grön, typerna stämmer, ingenting kastar.
 *
 * ── INSTRUMENTET: EN BRYTPUNKT, INTE EN RÄKNARE ─────────────────────────────
 *
 * Rader skapade FÖRE migrationen är legitimt NULL. Rader skapade EFTER den med
 * NULL är precis läckan:
 *
 *     actorKind IS NULL AND createdAt > AKTORSKOLUMNENS_BRYTPUNKT
 *
 * Raderna ÄR mätningen. Det finns ingen räknare att glömma att öka, inget som
 * kan gå ur synk med verkligheten, och ingen ny skrivväg att underhålla — till
 * skillnad från en metrik, som hade varit ännu en mekanism någon kan koppla
 * bort tyst.
 *
 * ── TABELLMÄNGDEN HÄRLEDS UR EXTENSIONEN ────────────────────────────────────
 *
 * `STÄMPLADE_MODELLER` kommer ur Prismas DMMF. Svepet mäter alltså exakt de
 * tabeller som stämplas — en egen lista hade kunnat mäta fel mängd utan att
 * något föll, och en modell som får kolumnen i morgon sveps utan att någon rör
 * den här filen.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Att stämpeln är RÄTT. Ett svep som räknar NULL kan inte se att en cron
 * stämplas HUMAN — det ägs av `actor-stamp.db.spec.ts`, som kör de tre
 * gränserna mot riktig Postgres. Svepet svarar bara på om NÅGON aktör sattes.
 *
 * Den kan heller inte se rader vars tabell saknar `createdAt`; det är därför
 * `Account` fick en i samma migration i stället för att falla ur mängden.
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import * as Sentry from '@sentry/nestjs'

import { CronErrorSink } from '../cron/cron-error-sink'
import { PrismaService } from '../prisma/prisma.service'
import { STÄMPLADE_MODELLER } from '../prisma/actor-stamp-extension'
import { runCronSafely } from '../cron/cron-safety'
import { AKTORSKOLUMNENS_BRYTPUNKT } from './actor.context'

export interface OstämpladTabell {
  tabell: string
  antal: number
}

@Injectable()
export class ActorNullSweepService {
  private readonly logger = new Logger(ActorNullSweepService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronErrors: CronErrorSink,
  ) {}

  /**
   * Räknar rader skapade efter brytpunkten som saknar aktör, per tabell.
   *
   * Rå SQL med citerade identifierare: tabellnamnen kommer ur DMMF, alltså ur
   * schemat och aldrig ur indata. En dynamisk `prisma[modell]`-uppslagning hade
   * krävt en `any`-kedja för samma resultat.
   */
  async mät(): Promise<OstämpladTabell[]> {
    const ut: OstämpladTabell[] = []
    for (const modell of [...STÄMPLADE_MODELLER].sort()) {
      const rader = await this.prisma.$queryRawUnsafe<{ antal: bigint }[]>(
        `SELECT count(*)::bigint AS antal FROM "${modell}" WHERE "actorKind" IS NULL AND "createdAt" > $1`,
        AKTORSKOLUMNENS_BRYTPUNKT,
      )
      const antal = Number(rader[0]?.antal ?? 0)
      if (antal > 0) ut.push({ tabell: modell, antal })
    }
    return ut
  }

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async sveep(): Promise<void> {
    // KLASSIFICERING: B — jobbet SKRIVER ingenting. `mät()` gör bara
    // `SELECT count(*)`, och två samtidiga körningar kan därför inte kollidera:
    // det finns ingen rad att tävla om. Larmet kan dubbleras, vilket är en
    // dubblett i Sentry och inte ett datafel.
    //
    // Sänkan är inkopplad: ett fel HÄR är ett fel i det instrument som ska
    // upptäcka andra fel, och det är den sortens tystnad som varar längst.
    await runCronSafely(
      'actor-null-sweep',
      async () => {
        const träffar = await this.mät()
        if (träffar.length === 0) {
          this.logger.log(
            `[actor-null-sweep] 0 ostämplade rader i ${STÄMPLADE_MODELLER.size} tabeller`,
          )
          return
        }
        const summa = träffar.reduce((s, t) => s + t.antal, 0)
        // Sentry, inte bara loggen: den lokala loggen försvinner med containern,
        // och det här är precis den sortens fel som inte märks förrän någon
        // frågar historiken om ett år.
        this.logger.error(
          `[actor-null-sweep] ${summa} rader utan aktör efter brytpunkten: ` +
            träffar.map((t) => `${t.tabell}=${t.antal}`).join(' '),
        )
        Sentry.captureException(
          new Error(`Aktörsstämplingen missade ${summa} rader (se serverlogg för tabeller)`),
          { tags: { sweep: 'actor-null' }, level: 'warning' },
        )
      },
      { logger: this.logger, sink: this.cronErrors },
    )
  }
}
