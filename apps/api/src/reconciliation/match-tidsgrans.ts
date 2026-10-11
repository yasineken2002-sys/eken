import { Prisma } from '@prisma/client'

/**
 * G20 (FORTNOX-100, BYGGLEDARE-EFFEKT-015): känner igen att matchningens interaktiva
 * transaktion överskred sin tidsgräns (`PAYMENT_TX_LIMITS`) eller inte hann starta.
 * Prisma rullar då tillbaka HELA transaktionen — ingen allokering, inget verifikat, ingen
 * statusändring består (bevisat i avi-failed-betalbar.db.spec.ts med en verklig timeout).
 * Bankraden är redan lagrad (före matchningen) och står kvar OMATCHAD och synlig.
 *
 * Ingen blind omkörning görs här: utfallet är känt (inget skrevs), och en uttrycklig
 * matchning efteråt går samma låsta väg en gång. Tidsgränsen ändras inte.
 */
export function ärMatchningsTidsgräns(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /Transaction already closed|expired transaction|Unable to start a transaction in the given time/i.test(
    msg,
  )
}

/** Kundens text: vad som hände, att inget bokfördes, och vad som rättar det. */
export function tidsgränsText(rad: { radnr?: number; belopp: string; ocr: string | null }): string {
  return (
    `${rad.radnr ? `Rad ${rad.radnr}: ` : ''}Betalningen på ${rad.belopp} kr${rad.ocr ? ` (OCR ${rad.ocr})` : ''} ` +
    'importerades men kunde inte matchas automatiskt — systemet var upptaget och matchningen avbröts ' +
    'innan något bokfördes. Raden står omatchad: kör "Matcha alla" eller matcha den manuellt.'
  )
}
