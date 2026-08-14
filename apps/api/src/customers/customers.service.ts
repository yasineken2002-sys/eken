import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { normalizeEmail } from '../common/utils/normalize-email'
import { CreateCustomerDto } from './dto/create-customer.dto'
import { UpdateCustomerDto } from './dto/update-customer.dto'

/** Personnummer-kolumnerna får aldrig serialiseras — se mapCustomer. */
const CUSTOMER_PN_KEYS = ['personalNumberEnc', 'personalNumberHash'] as const

type CustomerPnKey = (typeof CUSTOMER_PN_KEYS)[number]

/**
 * Säkert Prisma-SELECT för kunddata som lämnar backend.
 *
 * Motsvarigheten till `SAFE_TENANT_SELECT` i tenants.service.ts. Den fanns för
 * hyresgästen sedan en tidigare audit; kunden fick aldrig sin, och därför
 * fortsatte `include: { customer: true }` att dra med `personalNumberEnc` och
 * `personalNumberHash` — invarianten på rad 9 i den här filen gällde alltså
 * bara `mapCustomer`, inte varje ställe en Customer inkluderas (#284).
 *
 * INNEHÅLLER ALLA icke-känsliga kolumner men ALDRIG de två personnummer-
 * kolumnerna.
 *
 * ── Varför inte, korrekt formulerat ──────────────────────────────────────────
 *
 * Här stod tidigare att "den som har hashen kan verifiera en GISSNING genom att
 * hasha ett misstänkt personnummer och jämföra". Det är FEL: `blindIndex` är
 * HMAC-SHA256 med `SIGNING_PII_PEPPER` (signing-crypto.service.ts), och utan
 * peppern går gissningen inte att beräkna. Premissen ledde till rätt slutsats av
 * fel skäl, och ett fel skäl överlever tills någon väger det mot en kostnad.
 *
 * De tre skäl som faktiskt bär:
 *
 * 1. HASHEN ÄR EN KORRELATIONSNYCKEL. Samma hash = samma person, över tabeller
 *    OCH över organisationer. En läcka möjliggör länkning och avanonymisering
 *    utan att någonting knäcks — det räcker att jämföra hashar med varandra.
 *
 * 2. SKYDDET ÄR VILLKORAT AV EN HEMLIGHET SOM BOR NÅGON ANNANSTANS. Läcker
 *    `SIGNING_PII_PEPPER` blir varje REDAN LAGRAD hash gissningsbar, retroaktivt
 *    — inte bara framtida. En läckt hash är alltså inte ofarlig, den är
 *    villkorat ofarlig, och villkoret ligger utanför den här filen.
 *
 * 3. PEPPERN DELAS MEDVETET MED SignatureEvidence, så att en BankID-identitet kan
 *    matchas mot rätt part utan att någon rad dekrypteras. Sprängradien spänner
 *    därmed två delsystem. Signeringsmodulen är inert i produktion i dag
 *    (SIGNING_ENABLED=false) men är avsedd att tändas.
 *
 * ── Rotationsvägen: kravet är dokumenterat, mekanismen finns inte ────────────
 *
 * docs/accounting-fix-status.md beskriver vad rotation KRÄVER — varje
 * `personalNumberHash` måste räknas om, och det går bara från dekrypterad
 * klartext, så den gamla NYCKELN behövs även vid ren pepper-rotation. Något
 * migreringsskript finns inte (#459), och ett "rotera secrets"-svep utan ett
 * sådant förstör datan tyst. Läs #459 innan någon rör variablerna.
 *
 * Chiffertexten (`personalNumberEnc`) är AES-256-GCM och oanvändbar utan
 * `SIGNING_PII_KEY`. Även den hålls utanför: en select som bär den bjuder in
 * nästa yta att dekryptera "eftersom fältet ändå är där".
 *
 * Behöver du fler icke-känsliga fält: LÄGG TILL dem här. Behöver du
 * personnumret: välj `personalNumberEnc` explicit och dekryptera vid
 * användningstillfället, som inkassoexporten gör. Använd aldrig rå
 * `include: { customer: true }`.
 */
export const SAFE_CUSTOMER_SELECT = {
  id: true,
  organizationId: true,
  type: true,
  firstName: true,
  lastName: true,
  companyName: true,
  orgNumber: true,
  contactPerson: true,
  email: true,
  phone: true,
  street: true,
  city: true,
  postalCode: true,
  country: true,
  reference: true,
  notes: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pn: PersonalNumberService,
  ) {}

  /**
   * Byter ut chiffertext + blind-index mot personnumret i svaret.
   * Enda stället kunder dekrypteras för operatörs-API:t; alla läsvägar nedan
   * går igenom den här.
   *
   * `avslöja` styr om klartexten faktiskt hämtas fram. Fältet finns kvar i
   * svaret oavsett — bara alltid tomt när det är falskt — så svarets FORM är
   * densamma för varje anropare. Att ta bort nyckeln hade brutit typkontrakt i
   * onödan; nu ser den som visar fältet "–" i stället för att krascha.
   */
  private mapCustomer<T extends { personalNumberEnc: string | null }>(
    customer: T,
    avslöja: boolean,
  ): Omit<T, CustomerPnKey> & { personalNumber: string | null } {
    const rest = { ...customer } as Record<string, unknown>
    const personalNumber = avslöja ? this.pn.reveal(customer.personalNumberEnc) : null
    for (const key of CUSTOMER_PN_KEYS) delete rest[key]
    return { ...rest, personalNumber } as Omit<T, CustomerPnKey> & { personalNumber: string | null }
  }

  async findAll(
    organizationId: string,
    filters?: { search?: string; type?: 'INDIVIDUAL' | 'COMPANY'; isActive?: boolean },
  ) {
    const where: Prisma.CustomerWhereInput = {
      organizationId,
      ...(filters?.type ? { type: filters.type } : {}),
      ...(filters?.isActive != null ? { isActive: filters.isActive } : {}),
      ...(filters?.search
        ? {
            OR: [
              { firstName: { contains: filters.search, mode: 'insensitive' } },
              { lastName: { contains: filters.search, mode: 'insensitive' } },
              { companyName: { contains: filters.search, mode: 'insensitive' } },
              { email: { contains: filters.search, mode: 'insensitive' } },
              { orgNumber: { contains: filters.search } },
            ],
          }
        : {}),
    }

    const customers = await this.prisma.customer.findMany({
      where,
      include: {
        _count: { select: { invoices: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    // LISTAN BÄR INTE PERSONNUMMER (dataminimering, 2026-08-02 — #280).
    //
    // `GET /customers` saknar rollgrind (R1: läsning är öppen för alla roller)
    // och listan dekrypterade varje rad. Ett enda anrop lämnade ut samtliga
    // privatkunders personnummer, till vem som helst med ett konto.
    //
    // Rätt svar är inte att stänga listan för läsande roller — det bryter R1:s
    // beslut och löser fel problem — utan att listan slutar bära uppgiften. Man
    // navigerar en kundlista på namn och kundnummer, inte på personnummer.
    // Detaljvyn (`findOne`) avslöjar det fortfarande: en uppslagning av EN kund
    // är ett berättigat behov, en lista över ALLA är det inte.
    //
    // Samma beslut och samma form som hyresgästlistan (#281). Två listor med
    // samma sorts persondata ska behandlas lika.
    return customers.map((c) => this.mapCustomer(c, false))
  }

  async findOne(id: string, organizationId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, organizationId },
      include: {
        invoices: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { lines: true },
        },
        _count: { select: { invoices: true } },
      },
    })
    if (!customer) throw new NotFoundException('Kunden hittades inte')
    return this.mapCustomer(customer, true)
  }

  async create(dto: CreateCustomerDto, organizationId: string) {
    if (dto.type === 'INDIVIDUAL' && (!dto.firstName?.trim() || !dto.lastName?.trim())) {
      throw new BadRequestException('Förnamn och efternamn krävs för privatperson')
    }
    if (dto.type === 'COMPANY' && !dto.companyName?.trim()) {
      throw new BadRequestException('Företagsnamn krävs för företag')
    }

    const created = await this.prisma.customer.create({
      data: {
        organizationId,
        type: dto.type,
        ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
        ...(dto.lastName != null ? { lastName: dto.lastName } : {}),
        ...this.pn.protect(dto.personalNumber),
        ...(dto.companyName != null ? { companyName: dto.companyName } : {}),
        ...(dto.orgNumber != null ? { orgNumber: dto.orgNumber } : {}),
        ...(dto.contactPerson != null ? { contactPerson: dto.contactPerson } : {}),
        ...(dto.email != null ? { email: normalizeEmail(dto.email) } : {}),
        ...(dto.phone != null ? { phone: dto.phone } : {}),
        ...(dto.street != null ? { street: dto.street } : {}),
        ...(dto.city != null ? { city: dto.city } : {}),
        ...(dto.postalCode != null ? { postalCode: dto.postalCode } : {}),
        ...(dto.country != null ? { country: dto.country } : {}),
        ...(dto.reference != null ? { reference: dto.reference } : {}),
        ...(dto.notes != null ? { notes: dto.notes } : {}),
      },
    })
    return this.mapCustomer(created, true)
  }

  async update(id: string, dto: UpdateCustomerDto, organizationId: string) {
    const existing = await this.prisma.customer.findFirst({ where: { id, organizationId } })
    if (!existing) throw new NotFoundException('Kunden hittades inte')

    const updated = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.type != null ? { type: dto.type } : {}),
        ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
        ...(dto.lastName != null ? { lastName: dto.lastName } : {}),
        ...this.pn.protect(dto.personalNumber),
        ...(dto.companyName != null ? { companyName: dto.companyName } : {}),
        ...(dto.orgNumber != null ? { orgNumber: dto.orgNumber } : {}),
        ...(dto.contactPerson != null ? { contactPerson: dto.contactPerson } : {}),
        ...(dto.email != null ? { email: normalizeEmail(dto.email) } : {}),
        ...(dto.phone != null ? { phone: dto.phone } : {}),
        ...(dto.street != null ? { street: dto.street } : {}),
        ...(dto.city != null ? { city: dto.city } : {}),
        ...(dto.postalCode != null ? { postalCode: dto.postalCode } : {}),
        ...(dto.country != null ? { country: dto.country } : {}),
        ...(dto.reference != null ? { reference: dto.reference } : {}),
        ...(dto.notes != null ? { notes: dto.notes } : {}),
        ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
      },
    })
    return this.mapCustomer(updated, true)
  }

  /**
   * Soft delete: sätter isActive=false. Behåller historik så fakturor som
   * pekar på kunden förblir intakta. Faktiska radering sker bara om kunden
   * saknar fakturor helt.
   */
  async remove(id: string, organizationId: string): Promise<{ archived: boolean }> {
    const existing = await this.prisma.customer.findFirst({
      where: { id, organizationId },
      include: { _count: { select: { invoices: true } } },
    })
    if (!existing) throw new NotFoundException('Kunden hittades inte')

    if (existing._count.invoices === 0) {
      await this.prisma.customer.delete({ where: { id } })
      return { archived: false }
    }

    await this.prisma.customer.update({
      where: { id },
      data: { isActive: false },
    })
    return { archived: true }
  }
}
