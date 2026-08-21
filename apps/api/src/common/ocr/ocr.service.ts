import { Injectable } from '@nestjs/common'
import {
  generateOcrNumber as generateOcrFromSequence,
  luhnChecksum,
  isValidOcrNumber,
} from '@eken/shared'
import { PrismaService } from '../prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../../common/prisma/transaction-limits'

/**
 * Antal siffror i löpnumret före kontrollsiffran.
 *
 * ── VARFÖR TIO, OCH VARFÖR INGET ORG-PREFIX (H1) ─────────────────────────────
 *
 * Tidigare byggdes OCR:et som `pad4(orgPrefix) + pad6(tenantSequence) + Luhn`,
 * där prefixet var `(första fyra hex ur org-UUID mod 9000) + 1000`. Prefixet såg
 * ut att identifiera organisationen men GARANTERADE ingenting: hinken rymde 9000
 * värden, och vid 112 organisationer var risken 50 % att minst två delade
 * prefix. Delade de prefix fick deras tenant #1 identiskt OCR.
 *
 * Med `@@unique([organizationId, ocrNumber])` behövs inget prefix: två
 * organisationer FÅR dela nummer, eftersom uppslaget alltid bär organisationen.
 * Prefixet är därför BORTTAGET i stället för behållet som dekoration — ett fält
 * som ser ut att betyda något men inte gör det är sämre än inget fält, för nästa
 * läsare ärver tron.
 *
 * Tio siffror + kontrollsiffra ger elva totalt, exakt samma längd som de nummer
 * som redan delats ut. Gamla och nya OCR är alltså omöjliga att skilja åt på
 * formen, och alla ligger inom bankgirostandardens 4–25 siffror.
 *
 * INGENTING FÅR HÄRLEDA ORGANISATION UR ETT OCR-NUMMER. Numret är en nyckel
 * inom en organisation, inte en global identitet.
 */
const TENANT_OCR_SEQUENCE_DIGITS = 10

/** `pad10(löpnummer) + Luhn` — elva siffror, ingen inbäddad betydelse. */
export function formatTenantOcr(sequence: number): string {
  const base = String(sequence).padStart(TENANT_OCR_SEQUENCE_DIGITS, '0')
  return `${base}${luhnChecksum(base)}`
}

@Injectable()
export class OcrService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Genererar Luhn-validerat OCR från en fakturasekvens (t.ex. 1, 2, ...).
   * Wrappar shared-paketets generateOcrNumber så InvoicesService kan injecta
   * OcrService utan att importera shared direkt.
   */
  generateForInvoiceSequence(sequence: number): string {
    return generateOcrFromSequence(sequence)
  }

  /** Delegerar till `@eken/shared` — 4–25 siffror med giltig Luhn-kontrollsiffra. */
  validateOcrNumber(ocr: string): boolean {
    return isValidOcrNumber(ocr)
  }

  /**
   * Tilldelar hyresgästen ett OCR-nummer, eller returnerar det befintliga.
   *
   * ── VAD DEN ERSÄTTER ─────────────────────────────────────────────────────
   *
   * `tenant.count({ where: { organizationId, ocrNumber: { not: null } } }) + 1`
   * utanför varje transaktion. Två fel:
   *
   *   • RACE — två samtidiga tilldelningar läste samma count och byggde samma
   *     nummer. Med den gamla globala unikheten kastade den andra P2002.
   *   • ÅTERANVÄNDNING — count sjönk när en hyresgäst raderades, så nästa
   *     tilldelning kunde få ett nummer som redan varit i omlopp. En sen
   *     betalning med det gamla OCR:et hade då matchat FEL hyresgäst.
   *
   * En sekvens löser båda: den räknar uppåt oberoende av hur många rader som
   * finns, så ett nummer delas ut exakt en gång per organisation.
   *
   * ── RADLÅSET PÅ HYRESGÄSTEN ÄR INTE VALFRITT (mätt) ──────────────────────
   *
   * Sekvensens lås serialiserar ALLOKERINGEN, men inte BESLUTET att allokera.
   * Utan `FOR UPDATE` på hyresgästen läser två samtidiga anrop båda
   * `ocrNumber = null` (READ COMMITTED visar inte den andres ocommittade
   * skrivning), båda konsumerar var sitt sekvensnummer, och sista skrivningen
   * vinner. Bevisriggen mätte exakt det innan låset lades till:
   *
   *     samma hyresgäst, två parallella anrop → 00000000019 och 00000000028
   *
   * Ett bränt nummer är i sig ofarligt, men beteendet är inte idempotent: samma
   * hyresgäst kunde få olika OCR beroende på vem som committade sist. Med låset
   * blockerar det andra anropet tills det första är klart, läser om, ser numret
   * och returnerar det.
   *
   * Låsordningen är Tenant → TenantOcrSequence. Ingen annan väg tar lås på
   * sekvensraden, så cykeln som beskrivs i `applyMatchToRentNotice` kan inte
   * uppstå här.
   */
  async assignOcrToTenant(tenantId: string, orgId: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} AND "organizationId" = ${orgId} FOR UPDATE`

      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { ocrNumber: true },
      })
      if (tenant?.ocrNumber) return tenant.ocrNumber

      // Atomär increment under radlås på organisationens sekvensrad — samma
      // mönster som verifikationsnumren och avinumren.
      const row = await tx.tenantOcrSequence.upsert({
        where: { organizationId: orgId },
        create: { organizationId: orgId, lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
        select: { lastNumber: true },
      })
      const ocr = formatTenantOcr(row.lastNumber)

      await tx.tenant.update({ where: { id: tenantId }, data: { ocrNumber: ocr } })
      return ocr
    }, PRISMA_DEFAULT_TX_LIMITS)
  }
}
