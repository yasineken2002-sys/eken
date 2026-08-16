import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

/**
 * EN regel, ETT ställe: en manuellt registrerad betalning får aldrig överstiga
 * restskulden.
 *
 * ── VARFÖR DEN BRÖTS UT ──────────────────────────────────────────────────────
 *
 * Regeln fanns bara på fakturans manuella väg (`markAsPaidManually`). Avins
 * manuella väg (`AviseringService.markAsPaid`) saknade den helt: en operatör
 * kunde registrera 20 000 kr på en 10 000-kronorsavi, hela beloppet allokerades
 * och bokfördes `1930 D / 1510 K`, och kundfordran gick MINUS 10 000.
 *
 * Att kopiera spärren dit hade gett samma regel på två ställen — och två kopior
 * av en regel divergerar. Det är inte en farhåga utan mätt historik i den här
 * kodbasen: `TENANT_CREDENTIAL_KEYS` fanns i två kopior som drev isär, och
 * ingen bevakning jämförde dem förrän månader senare.
 *
 * Därför en assertion som BÅDA manuella vägarna anropar.
 *
 * ── VARFÖR BANKVÄGEN INTE ANVÄNDER DEN (mätt, inte antaget) ──────────────────
 *
 * Bankvägens motsvarighet (`applyMatchToRentNotice`) prövades kontroll för
 * kontroll mot den här. Två av tre kontroller var samma regel i olika ord —
 * men den tredje skiljer sig PÅ RIKTIGT:
 *
 * | Kontroll        | Bankvägen                       | Manuell väg        |
 * |-----------------|---------------------------------|--------------------|
 * | restskuld ≤ 0   | `return false` → 400 hos anropar | kastar här         |
 * | belopp ≤ 0      | avvisas vid INGEST (NON_POSITIVE)| kastar här         |
 * | överbetalning   | `> restskuld + 1,00 kr`         | `> restskuld`      |
 *
 * Bankvägen har en TOLERANS på en krona och absorberar en differens inom den
 * (allokerar restskulden, inte det inbetalda beloppet). Det är rimligt för ett
 * belopp som är ett MÄTT FAKTUM ur en bankfil — öresavrundning är verklig och
 * operatören kan inte ändra den.
 *
 * Ett manuellt inskrivet belopp är något annat: det är ett PÅSTÅENDE en människa
 * knappat in och kan rätta. Att tyst absorbera 50 öre där döljer ett skrivfel i
 * stället för att fråga. Regeln är alltså inte samma regel, och de hålls isär
 * med flit. Bankvägens klassificerare är dessutom trevägs (full/partiell/över),
 * inte en assertion — annan form, annan uppgift.
 *
 * ── ICKE KONFIGURERBAR ───────────────────────────────────────────────────────
 *
 * In: belopp och restskuld. Ut: kastar eller inte. Inga flaggor, ingen tolerans
 * att skruva på, inget subjekt att skicka in — meddelandena byggs ur talen och
 * nämner därför varken "faktura" eller "avi". En hjälpare som blir generell nog
 * att passa alla anropare slutar säga något bestämt (#463).
 */
export function assertPaymentWithinDebt(amount: Prisma.Decimal, outstanding: Prisma.Decimal): void {
  // Ordningen speglar fakturavägens: skulden först (mest specifika beskedet),
  // sedan beloppet, sist relationen mellan dem.
  if (outstanding.lte(0)) {
    throw new BadRequestException('Skulden är redan fullt reglerad')
  }
  if (amount.lte(0)) {
    throw new BadRequestException('Betalningsbeloppet måste vara större än noll')
  }
  // ÖVERBETALNING AVVISAS. Att tyst acceptera mer än restskulden skulle skapa en
  // kundkredit som systemet inte har någon modell för; att klampa beloppet skulle
  // bokföra mindre än vad som faktiskt kommit in. Båda är sämre än att säga ifrån.
  //
  // Följden är dock ett verkligt gap, inte en avslutad fråga: en hyresgäst som
  // betalar 10 000,50 kr på en 10 000-kronorsskuld avvisas av BÅDA vägarna, och
  // pengarna har ingenstans att ta vägen. Se förskottsärendet.
  if (amount.gt(outstanding)) {
    throw new BadRequestException(
      `Beloppet ${amount.toFixed(2)} kr överstiger restskulden ${outstanding.toFixed(2)} kr — ` +
        'överbetalning hanteras inte',
    )
  }
}
