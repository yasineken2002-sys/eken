import { ConflictException, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'

// Standardserie för automatverifikat enligt SIE4-konventionen (SIE Gruppen 4B).
// "A" = automatiskt genererade poster (fakturering, betalning, hyresavi, m.m.).
// Reserverat för framtiden: "M" för manuella justeringsposter.
export const DEFAULT_VER_SERIES = 'A'

export interface AllocatedVerifikationsnummer {
  series: string
  verNumber: number
  fiscalYear: number
}

/**
 * Tilldelar verifikationsnummer i en obruten, race-säker nummerserie per
 * organisation, räkenskapsår och serie (Bokföringslagen 5 kap 6 §).
 *
 * Mönstret är detsamma som ContractNumberSequence: en UPSERT med atomär
 * increment pekar Postgres mot row-locket på den specifika sekvensraden — två
 * samtidiga verifikationer i samma (org, år, serie) hamnar i kö istället för
 * att dela ut samma nummer. Eftersom allokeringen sker inuti SAMMA transaktion
 * som JournalEntry skapas blir serien dessutom gap-free: rullas posten tillbaka
 * återställs även increment:en.
 */
@Injectable()
export class VerifikationsnummerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Härleds vilket räkenskapsår ett datum tillhör utifrån räkenskapsårets
   * startmånad (1–12). Vid kalenderår (startmånad 1) blir det alltid datumets
   * kalenderår. Vid brutet räkenskapsår (t.ex. maj–april, startmånad 5) hör en
   * post före startmånaden till föregående kalenderårs räkenskapsår.
   */
  static fiscalYearFor(date: Date, fiscalYearStartMonth: number): number {
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1 // 1–12
    return month < fiscalYearStartMonth ? year - 1 : year
  }

  /**
   * Allokerar nästa verifikationsnummer. MÅSTE anropas med en transaktions-
   * klient (`tx`) som även skapar JournalEntry — annars går gap-free-garantin
   * förlorad (en rollback ska kunna återställa sekvensökningen).
   *
   * Vägrar tilldela nummer om postens datum ligger i en stängd bokförings-
   * period (ClosedAccountingPeriod) — ett stängt räkenskapsår får inte öppnas
   * implicit av en efterhandsbokförd post. Kastar ConflictException.
   */
  async allocate(
    client: Prisma.TransactionClient,
    organizationId: string,
    date: Date,
    series: string = DEFAULT_VER_SERIES,
  ): Promise<AllocatedVerifikationsnummer> {
    const org = await client.organization.findUnique({
      where: { id: organizationId },
      select: { fiscalYearStartMonth: true },
    })
    const startMonth = org?.fiscalYearStartMonth ?? 1
    const fiscalYear = VerifikationsnummerService.fiscalYearFor(date, startMonth)

    // ClosedAccountingPeriod är nyckelad på kalenderår + kalendermånad.
    const calYear = date.getUTCFullYear()
    const calMonth = date.getUTCMonth() + 1
    const closed = await client.closedAccountingPeriod.findUnique({
      where: {
        organizationId_year_month: { organizationId, year: calYear, month: calMonth },
      },
      select: { id: true },
    })
    if (closed) {
      throw new ConflictException(
        `Bokföringsperioden ${calYear}-${String(calMonth).padStart(2, '0')} är stängd — ny verifikation kan inte skapas`,
      )
    }

    const row = await client.journalEntrySequence.upsert({
      where: {
        organizationId_fiscalYear_series: { organizationId, fiscalYear, series },
      },
      create: { organizationId, fiscalYear, series, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    })

    return { series, verNumber: row.lastNumber, fiscalYear }
  }
}
