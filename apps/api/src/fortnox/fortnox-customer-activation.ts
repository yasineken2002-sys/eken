/**
 * KUNDSTART-001 §6, §10 F6, §11, §12: kontrollerad Fortnox-skrivning till ett KUNDföretag.
 *
 * Av som standard. Driftflaggan FORTNOX_CUSTOMER_WRITES=aktiverad (det enda giltiga
 * värdet; annat stoppar uppstart) är tillåten i produktion och står BREDVID testspärren
 * — testlistan `FORTNOX_TEST_WRITE_COMPANIES` och FORTNOX_TEST_VOUCHER_WRITES rörs inte,
 * och kundflaggan gör inte testlistans väg skrivbar (S-2).
 *
 * Sändning till ett kundföretag kräver, vid VARJE sändning (send() och skrivaren):
 *  - flaggan på;
 *  - exakt en ACTIVE `FortnoxCustomerActivation` för organisationen;
 *  - bindningen lika med aktuell anslutning: id, generation, databasnummer, orgnr (=
 *    Evenos), status ACTIVE och ingen återanslutning efter godkännandet;
 *  - utkastets räkenskapsår och serie lika med aktiveringens;
 *  - mappingSha (serie + dimensionsbeslut med tid + mappningar med id + år) oförändrad;
 *  - öppningspaketet fortfarande EXECUTED, det senaste, med brytdatum = organisationens
 *    och avstämning AVSTAMD eller AVGRANSAD;
 * Avvikelse → aktiveringen blir beständigt SUPERSEDED (send-vägen) och inget skickas.
 */
import { createHash } from 'crypto'
import type { ConfigService } from '@nestjs/config'
import type { Prisma } from '@prisma/client'
import { ogiltigforklaraAktiveringar } from '../kundstart/activation-invalidation'
import { brytdatumIso } from '../kundstart/cutover'
import type { FortnoxVoucherWriter } from './fortnox-voucher-writer'
import { normalizeOrgNumber } from './fortnox-connection.service'

export const FORTNOX_CUSTOMER_WRITES_VALUE = 'aktiverad'

export function fortnoxCustomerWritesOptIn(config: ConfigService): boolean {
  const raw = config.get<string>('FORTNOX_CUSTOMER_WRITES')
  if (raw === undefined || raw === '') return false
  if (raw !== FORTNOX_CUSTOMER_WRITES_VALUE)
    throw new Error('[fortnox] FORTNOX_CUSTOMER_WRITES har ogiltigt värde — fail-fast.')
  return true
}

/** Bindningen send() lämnar till skrivaren; skrivaren verifierar den själv mot databasen. */
export interface FortnoxCustomerBinding {
  organizationId: string
  activationId: string
  databaseNumber: number
  financialYearId: number
  voucherSeries: string
}

/** Samma organisationsnummer? Båda måste gå att normalisera — två okända är INTE lika. */
export function sammaOrgnr(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeOrgNumber(a)
  const y = normalizeOrgNumber(b)
  return x !== null && x === y
}

export async function mappningsSha(
  db: Prisma.TransactionClient,
  organizationId: string,
  financialYearId: number,
): Promise<string | null> {
  const conn = await db.fortnoxConnection.findUnique({
    where: { organizationId },
    select: { exportVoucherSeries: true, exportOmitDimensionsAt: true },
  })
  if (!conn) return null
  const mappningar = await db.fortnoxDimensionMapping.findMany({
    where: { organizationId },
    select: { id: true, dimensionType: true, code: true, propertyId: true, createdAt: true },
    orderBy: [{ dimensionType: 'asc' }, { code: 'asc' }],
  })
  const underlag = {
    serie: conn.exportVoucherSeries,
    utanDimensioner: conn.exportOmitDimensionsAt?.toISOString() ?? null,
    ar: financialYearId,
    mappningar: mappningar.map((m) => [
      m.id,
      m.dimensionType,
      m.code,
      m.propertyId,
      m.createdAt.toISOString(),
    ]),
  }
  return createHash('sha256').update(JSON.stringify(underlag), 'utf8').digest('hex')
}

export type Verifiering =
  | { ok: true; binding: FortnoxCustomerBinding }
  | { ok: false; skal: string; activationId: string | null }

/**
 * Prövar organisationens ACTIVE aktivering mot aktuellt läge. Ren läsning; `send()`
 * ogiltigförklarar beständigt vid nej (se `provaOchOgiltigforklara`).
 */
export async function provaAktivering(
  db: Prisma.TransactionClient,
  organizationId: string,
  utkast: { financialYearId: number; voucherSeries: string; transactionDate?: string } | null,
): Promise<Verifiering> {
  const aktiva = await db.fortnoxCustomerActivation.findMany({
    where: { organizationId, status: 'ACTIVE' },
  })
  if (aktiva.length === 0)
    return {
      ok: false,
      skal: 'Ingen aktiv kundaktivering för Fortnox-skrivning.',
      activationId: null,
    }
  if (aktiva.length > 1)
    return {
      ok: false,
      skal: 'Fler än en aktiv kundaktivering — ingen sändning.',
      activationId: null,
    }
  const a = aktiva[0]!
  const nej = (skal: string): Verifiering => ({ ok: false, skal, activationId: a.id })

  const conn = await db.fortnoxConnection.findUnique({ where: { organizationId } })
  if (!conn || conn.status !== 'ACTIVE') return nej('Fortnox-anslutningen är inte aktiv.')
  if (conn.id !== a.connectionId)
    return nej('Fortnox-anslutningen är en annan än vid godkännandet.')
  if (conn.generation !== a.connectionGeneration)
    return nej('Fortnox-anslutningens generation har ändrats (återanslutning).')
  if (conn.connectedAt > a.approvedAt)
    return nej('Fortnox har anslutits på nytt efter godkännandet — ny prövning krävs.')
  if (conn.fortnoxDatabaseNumber !== a.fortnoxDatabaseNumber)
    return nej('Fortnox-företaget (databasnummer) är ett annat än vid godkännandet.')
  if (!sammaOrgnr(conn.fortnoxOrgNumber, a.fortnoxOrgNumber))
    return nej('Fortnox-företagets organisationsnummer har ändrats.')
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { orgNumber: true, billingCutoverDate: true },
  })
  if (!org || !sammaOrgnr(org.orgNumber, a.fortnoxOrgNumber))
    return nej('Evenos organisationsnummer är inte lika med Fortnox-företagets.')
  if (conn.exportVoucherSeries !== a.voucherSeries)
    return nej('Verifikatserien har ändrats sedan godkännandet.')
  if (utkast) {
    if (utkast.financialYearId !== a.financialYearId)
      return nej(
        `Utkastet gäller räkenskapsår ${utkast.financialYearId}, aktiveringen år ${a.financialYearId}.`,
      )
    if (utkast.voucherSeries !== a.voucherSeries)
      return nej(
        `Utkastet har serie ${utkast.voucherSeries}, aktiveringen serie ${a.voucherSeries}.`,
      )
    // K-B7: exportgränsen. Saknat eller ogiltigt datum är inget "efter".
    const b = org.billingCutoverDate ? brytdatumIso(org.billingCutoverDate) : null
    if (
      !b ||
      typeof utkast.transactionDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(utkast.transactionDate)
    )
      return nej('Utkastet saknar verifierbart verifikatsdatum — exportgränsen kan inte prövas.')
    if (utkast.transactionDate < b)
      return nej(
        `Utkastet är daterat ${utkast.transactionDate}, före brytdatum ${b} — exporteras aldrig.`,
      )
  }
  const sha = await mappningsSha(db, organizationId, a.financialYearId)
  if (sha !== a.mappingSha256)
    return nej('Kontomappning, dimensionsbeslut eller serie har ändrats sedan godkännandet.')

  const paket = await db.openingPackage.findFirst({
    where: { id: a.openingPackageId, organizationId },
    select: { status: true, cutoverDate: true, reconciliationStatus: true, executedAt: true },
  })
  if (!paket || paket.status !== 'EXECUTED') return nej('Öppningspaketet är inte verkställt.')
  const senare = await db.openingPackage.count({
    where: {
      organizationId,
      status: 'EXECUTED',
      executedAt: { gt: paket.executedAt ?? new Date(0) },
    },
  })
  if (senare > 0) return nej('Ett senare öppningspaket har verkställts — ny prövning krävs.')
  if (!org.billingCutoverDate || org.billingCutoverDate.getTime() !== paket.cutoverDate.getTime())
    return nej('Brytdatumet har ändrats sedan godkännandet.')
  if (paket.reconciliationStatus !== 'AVSTAMD' && paket.reconciliationStatus !== 'AVGRANSAD')
    return nej('Startavstämningen är inte AVSTÄMD eller AVGRÄNSAD.')

  return {
    ok: true,
    binding: {
      organizationId,
      activationId: a.id,
      databaseNumber: a.fortnoxDatabaseNumber,
      financialYearId: a.financialYearId,
      voucherSeries: a.voucherSeries,
    },
  }
}

/** send()-vägen: ett nej ogiltigförklarar aktiveringen beständigt (A→B→A väcker den inte). */
export async function provaOchOgiltigforklara(
  db: Prisma.TransactionClient,
  organizationId: string,
  utkast: { financialYearId: number; voucherSeries: string; transactionDate: string },
): Promise<Verifiering> {
  const v = await provaAktivering(db, organizationId, utkast)
  if (!v.ok && v.activationId) {
    // Bara materiella ändringar av bindningen ogiltigförklarar — inte ett utkast för ett
    // annat år/serie (då står aktiveringen kvar, men just det utkastet skickas inte).
    if (!/^Utkastet /.test(v.skal)) await ogiltigforklaraAktiveringar(db, organizationId, v.skal)
  }
  return v
}

/** Skrivarens egen kontroll (försvar på djupet): bindningen från send() måste stämma i DB. */
export async function skrivarensKontroll(
  db: Prisma.TransactionClient,
  b: FortnoxCustomerBinding,
  // Ur skrivarens EGEN payload (Voucher.TransactionDate), inte ur anroparens bindning.
  transactionDate: string,
): Promise<boolean> {
  const v = await provaAktivering(db, b.organizationId, {
    financialYearId: b.financialYearId,
    voucherSeries: b.voucherSeries,
    transactionDate,
  })
  return (
    v.ok &&
    v.binding.activationId === b.activationId &&
    v.binding.databaseNumber === b.databaseNumber
  )
}

export function konsekvenstext(x: {
  foretag: string
  orgnr: string
  databasnummer: number
  ar: { id: number; fran: string; till: string }
  serie: string
  mappingSha: string
  brytdatum: Date
  paketId: string
  nollOppning: boolean
  avstamning: { status: string; texter: string[] }
}): string {
  return [
    `Kundaktivering av Fortnox-skrivning för ${x.foretag} (orgnr ${x.orgnr}, Fortnox-databas ${x.databasnummer}).`,
    `Eveno får skicka sina egna verifikat till räkenskapsår ${x.ar.id} (${x.ar.fran}–${x.ar.till}), serie ${x.serie}, och BARA verifikat daterade på eller efter brytdatum ${brytdatumIso(x.brytdatum)}.`,
    `Exportgräns: ett verifikat daterat före ${brytdatumIso(x.brytdatum)} — till exempel en förskottsbetalning eller en deposition som registrerats före brytdatum — blockeras och exporteras aldrig; det stäms av manuellt i Fortnox.`,
    `Kontomappning, dimensionsbeslut och serie är låsta med sha ${x.mappingSha.slice(0, 16)}…; varje ändring, återanslutning, nytt brytdatum eller nytt öppningspaket upphäver aktiveringen och kräver ett nytt godkännande.`,
    x.nollOppning
      ? `Underlag: nollöppning (paket ${x.paketId.slice(0, 8)}) — Fortnox visar 0 på 1510 och 2890 per brytdatum.`
      : `Underlag: öppningspaket ${x.paketId.slice(0, 8)}; startavstämning ${x.avstamning.status}.`,
    ...x.avstamning.texter,
    'Öppningen bokförs inte i Eveno och exporteras aldrig; Fortnox IB och Evenos öppningskomponent är samma belopp ur två källor.',
    'Återkallelse stoppar nya sändningar och köade rader. En sändning som redan pågår fullföljs eller blir okänd för avstämning; ett verifikat som redan skrivits i Fortnox tas inte bort av en återkallelse.',
  ].join('\n')
}

/**
 * KUNDSTART G-F5: samma regel för status, AI-ögonblicksbild och sändning — testvägen,
 * eller kundvägen med flagga och en giltig aktivering. Ren läsning.
 */
export async function sendingEnabledFor(
  prisma: Prisma.TransactionClient,
  writer: FortnoxVoucherWriter | null | undefined,
  organizationId: string,
): Promise<boolean> {
  if (!writer?.capable) return false
  const conn = await prisma.fortnoxConnection.findUnique({
    where: { organizationId },
    select: { status: true, fortnoxDatabaseNumber: true },
  })
  if (!conn || conn.status !== 'ACTIVE') return false
  if (!writer.requiresCustomerActivation(conn.fortnoxDatabaseNumber))
    return writer.allowsCompany(conn.fortnoxDatabaseNumber)
  if (!writer.customerWritesEnabled) return false
  const v = await provaAktivering(prisma, organizationId, null)
  return v.ok && writer.allowsCompany(conn.fortnoxDatabaseNumber, v.binding)
}
