/**
 * "NY LEVERANTÖRSFAKTURA" — formulärets regler som rena funktioner.
 *
 * Vitest renderar ingenting (`environment: 'node'`), så reglerna bor utanför
 * komponenten för att gå att pröva. Knappens villkor och felmeddelandet kommer
 * från SAMMA funktion, så de kan inte säga olika saker.
 *
 * ── BELOPPET ÄR BRUTTO ──────────────────────────────────────────────────────
 *
 * Det som står på fakturan och det som ska lämna bankkontot. Momsen bryts UT ur
 * det (`momsAvBrutto`), den läggs inte till. Samma riktning som utgiftsvägen och
 * av samma skäl: den omvända tolkningen ger ett verifikat som balanserar men en
 * skuld på 2440 som är för liten — ett fel varken balansgrinden eller ett
 * radprov kan se.
 */

import { momsAvBrutto, tolkaBelopp } from './entry-balance'

export interface LeverantorsfakturaUtkast {
  supplierName: string
  invoiceNumber: string
  description: string
  invoiceDate: string
  dueDate: string
  expenseAccount: string
  amount: string
  vatRate: number
}

export interface Fakturabelopp {
  brutto: number
  moms: number
  netto: number
}

export function beraknaBelopp(utkast: LeverantorsfakturaUtkast): Fakturabelopp {
  const brutto = tolkaBelopp(utkast.amount)
  const moms = momsAvBrutto(brutto, utkast.vatRate)
  return { brutto, moms, netto: brutto - moms }
}

/**
 * Vad hindrar att fakturan registreras? `null` = inget.
 *
 * ORDNINGEN följer formuläret uppifrån och ner, så att den som fyller i får
 * felet om det fält hen är på väg till — inte om ett längre ner.
 */
export function fakturaFel(
  utkast: LeverantorsfakturaUtkast,
  kontoFinns: (nummer: number) => boolean,
): string | null {
  if (utkast.supplierName.trim().length < 2) return 'Ange leverantörens namn.'
  if (utkast.description.trim().length < 3) return 'Beskrivningen måste vara minst 3 tecken.'
  if (!utkast.invoiceDate) return 'Välj fakturadatum.'
  if (!utkast.dueDate) return 'Välj förfallodatum.'

  // FÖRFALLODATUM FÖRE FAKTURADATUM är inte bara ogiltigt — det är oftast en
  // felskrivning i det ena fältet, och meddelandet säger vilket förhållande som
  // brutits i stället för "ogiltigt datum".
  if (utkast.dueDate < utkast.invoiceDate) {
    return 'Förfallodatum kan inte ligga före fakturadatum.'
  }

  const { brutto } = beraknaBelopp(utkast)
  if (brutto <= 0) return 'Ange ett belopp större än noll.'

  const konto = Number(utkast.expenseAccount)
  if (!utkast.expenseAccount.trim()) return 'Välj ett kostnadskonto.'
  if (!Number.isFinite(konto) || !kontoFinns(konto)) {
    return `Konto ${utkast.expenseAccount} finns inte i kontoplanen.`
  }
  return null
}

/**
 * Är en öppen faktura förfallen? Speglar serverns `isOverdue`.
 *
 * Servern räknar också, och dess svar är det som gäller — listan får `overdue`
 * i svaret. Den här finns för att kunna färga en rad utan ett nytt anrop, och
 * MÅSTE därför ge samma svar: jämförelsen sker på datum, och en faktura som
 * förfaller i dag är inte försenad förrän i morgon.
 */
export function arForfallen(dueDate: string, status: string, idag: string): boolean {
  if (status !== 'OPEN') return false
  return dueDate < idag
}

/** Dagens datum som ÅÅÅÅ-MM-DD, för jämförelser mot `dueDate`. */
export function idagIso(nu: Date = new Date()): string {
  return nu.toISOString().slice(0, 10)
}

/**
 * Korsar makuleringen en RÄKENSKAPSÅRSGRÄNS?
 *
 * Rättelsen bokförs på den dag den görs, inte på fakturadagen — en avslutad
 * period får inte skrivas om. Konsekvensen är att en faktura som bokfördes i år
 * N och makuleras i år N+1 lämnar N:s resultat OFÖRÄNDRAT (kostnaden ligger
 * kvar) och sänker N+1:s kostnader i stället.
 *
 * För ett oväsentligt belopp är det branschpraxis och rätt. För ett VÄSENTLIGT
 * belopp kräver god redovisningssed rättelse mot balanserat resultat i stället,
 * vilket inte är något systemet kan avgöra åt någon — väsentlighet är en
 * bedömning. Därför en VARNING och inte en spärr: den som makulerar ska veta att
 * gränsen korsas, och sedan välja själv.
 *
 * Räkenskapsåret antas följa kalenderåret, vilket det gör för alla organisationer
 * systemet i dag kan uttrycka (jfr det öppna ärendet #729 om brutet och
 * förkortat första räkenskapsår).
 */
export function makuleringKorsarRakenskapsar(invoiceDate: string, idag: string): boolean {
  const fakturaAr = invoiceDate.slice(0, 4)
  const rattelseAr = idag.slice(0, 4)
  return Boolean(fakturaAr) && Boolean(rattelseAr) && fakturaAr !== rattelseAr
}
