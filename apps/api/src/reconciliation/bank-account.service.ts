import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../common/prisma/prisma.service'

/**
 * BANKIMPORTENS MÅLKONTON (#F034c).
 *
 * Minsta nödvändiga: lista, skapa, och — det viktiga — LÖS UPP ett id till ett
 * konto som bevisligen tillhör organisationen.
 *
 * ── VARFÖR UPPLÖSNINGEN LIGGER HÄR OCH INTE I IMPORTVÄGARNA ─────────────────
 *
 * Tre filvägar behöver samma kontroll. Skrevs den tre gånger räckte det att en
 * av dem missade `organizationId` i sitt `where` för att ett konto från en
 * ANNAN organisation skulle kunna anges — och den vägen hade sett ut precis som
 * de två riktiga. En funktion, tre anropare.
 */
export interface BankkontoVy {
  id: string
  name: string
  accountNumber: string | null
  isActive: boolean
}

const VY = {
  id: true,
  name: true,
  accountNumber: true,
  isActive: true,
} as const satisfies Prisma.BankAccountSelect

@Injectable()
export class BankAccountService {
  constructor(private readonly prisma: PrismaService) {}

  /** Organisationens konton. Avvecklade ingår, märkta med `isActive: false`. */
  async list(organizationId: string): Promise<BankkontoVy[]> {
    return this.prisma.bankAccount.findMany({
      where: { organizationId },
      select: VY,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    })
  }

  async create(
    organizationId: string,
    input: { name: string; accountNumber?: string | undefined },
  ): Promise<BankkontoVy> {
    const name = input.name.trim()
    if (!name) throw new BadRequestException('Kontot måste ha ett namn.')
    try {
      return await this.prisma.bankAccount.create({
        data: {
          organizationId,
          name,
          ...(input.accountNumber?.trim() ? { accountNumber: input.accountNumber.trim() } : {}),
        },
        select: VY,
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Namnet är unikt per organisation MED AVSIKT: det är det operatören
        // väljer på, och två konton med samma namn gör valet till en gissning.
        throw new ConflictException(`Det finns redan ett konto som heter "${name}".`)
      }
      throw err
    }
  }

  /**
   * ENDA VÄGEN från ett klientlämnat konto-id till ett målkonto.
   *
   * ── VAD DEN GÖR, OCH VARFÖR VARJE LED FINNS ─────────────────────────────
   *
   * `organizationId` i `where` är tenant-gränsen. Utan den hade ett id från en
   * ANNAN organisation gett ett giltigt konto, och importen hade skrivit rader
   * mot det — alltså en tyst korsning mellan kunder.
   *
   * SAKNAT ID ÄR ETT EGET FEL, inte "ta första bästa". Att falla tillbaka på
   * något konto hade varit organisationen använd som om den vore ett bankkonto,
   * fast med ett extra steg. Felmeddelandet säger vad operatören ska göra.
   *
   * AVVECKLAT KONTO NEKAS. `isActive: false` betyder att kontot inte ska gå att
   * välja; historiken består, men nya rader hör inte hemma där.
   */
  async resolveTarget(organizationId: string, bankAccountId: unknown): Promise<BankkontoVy> {
    if (typeof bankAccountId !== 'string' || !bankAccountId.trim()) {
      const antal = await this.prisma.bankAccount.count({
        where: { organizationId, isActive: true },
      })
      throw new BadRequestException(
        antal === 0
          ? 'Organisationen har inget bankkonto upplagt. Lägg upp kontot importen gäller ' +
              'innan du importerar — ett kontoutdrag måste höra till ett namngivet konto.'
          : 'Välj vilket bankkonto importen gäller. Filen bär ingen säker kontoidentitet, ' +
              'så valet måste göras av dig.',
      )
    }
    const konto = await this.prisma.bankAccount.findFirst({
      where: { id: bankAccountId, organizationId },
      select: VY,
    })
    // SAMMA SVAR för "finns inte" och "tillhör någon annan". Att skilja dem åt
    // hade låtit en anropare räkna ut vilka konto-id som existerar i andra
    // organisationer.
    if (!konto) throw new NotFoundException('Bankkontot hittades inte.')
    if (!konto.isActive) {
      throw new BadRequestException(
        `Kontot "${konto.name}" är avvecklat och kan inte ta emot nya importer.`,
      )
    }
    return konto
  }

  /**
   * #F034c — KONTROLLERAR ett kontonummer filen råkar bära mot det VALDA kontot.
   *
   * ── RIKTNINGEN ÄR HELA POÄNGEN ──────────────────────────────────────────
   *
   * Filens kontonummer får aldrig VÄLJA konto, bara motsäga ett val. Skälet är
   * att ingen av de tre vägarna bär en identitet som duger som val:
   *
   *   CSV/XLSX   har inget kontonummer alls
   *   BgMax      bär mottagarens bankgiro i fastformatet — en betalningsadress,
   *              inte ett bankkonto, och flera bankgiron kan peka på samma konto
   *   PDF        har `accountNumber`, men AI-EXTRAHERAT ur utdraget och därmed
   *              inte en styrd måladress
   *
   * Att låta någon av dem välja hade betytt att en feltolkad siffra styr vilket
   * konto pengarna bokförs mot. Att låta dem KONTROLLERA kostar ingenting och
   * fångar det vanliga misstaget: operatören valde fel konto i väljaren.
   *
   * TYST VID OKÄNT. Saknar kontot ett `accountNumber`, eller bar filen inget,
   * finns inget att jämföra — och en jämförelse som inte kan göras får inte
   * rapporteras som godkänd. Returnerar `null` = ingen kontroll utförd.
   */
  jamforKontonummer(
    konto: BankkontoVy,
    filensKontonummer: string | null | undefined,
  ): { stammer: boolean; filens: string; kontots: string } | null {
    const filens = filensKontonummer?.replace(/[\s-]/g, '') ?? ''
    const kontots = konto.accountNumber?.replace(/[\s-]/g, '') ?? ''
    if (!filens || !kontots) return null
    return { stammer: filens === kontots, filens, kontots }
  }
}
