import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

/**
 * INNEHÅLLET KAN INTE IDENTIFIERA EN MANUELL BETALNING. Läs det här stycket
 * innan du bygger en idempotensnyckel för den här vägen.
 *
 * ── VARFÖR DET INTE FINNS NÅGON NYCKEL, OCH INTE SKA FINNAS ─────────────────
 *
 * En nämnare måste kunna skilja två LEGITIMA upprepningar åt. Två manuella
 * delbetalningar på samma faktura, med samma belopp, samma dag, är i domänen
 * IDENTISKA — en hyresgäst som betalar av en skuld i två lika stora poster har
 * gjort två saker som ingenting i datan skiljer åt.
 *
 * Den närliggande idén är att lägga till en identitet: en extern
 * betalningsreferens eller en idempotensnyckel som kolumn på `InvoicePayment`.
 * Det är fel, och skälet är inte teknisk kostnad. Att införa ett fält som
 * domänen inte har är att FABRICERA en skillnad mellan två betalningar som
 * faktiskt är lika — kolumnen blir ett påstående ingen kan belägga, och den som
 * läser den tror att den betyder något.
 *
 * Notera också att bankraden inte kan bära nyckeln här: `markAsPaidManually` är
 * just vägen för betalningar som INTE har någon bankrad — kontant, swish, en
 * avstämning gjord för hand. Raden som skrivs (`invoiceId`, `amount`, `paidAt`,
 * `source: 'MANUAL'`) är hela händelsen, och `bankTransactionId` är NULL.
 *
 * Kodbasen hade redan dragit halva slutsatsen: #290 flyttade verifikatets
 * idempotensnyckel från fakturan till ALLOKERINGEN, av exakt det här skälet —
 * en nyckel på fakturan gör att en andra delbetalning aldrig bokförs.
 * Allokeringen ÄR händelsen. Den saknar bara en identitet, och ska fortsätta
 * sakna den.
 *
 * ── VAD DEN HÄR SPÄRREN ÄR I STÄLLET ────────────────────────────────────────
 *
 * Ett kort TIDSFÖNSTER mot OAVSIKTLIGA dubbletter. Den påstår ingenting om
 * identitet: den säger "två likadana registreringar så här tätt är nästan
 * säkert samma handling två gånger, och det ska en människa få veta".
 *
 * Den är därför inte tyst. Ett tyst hopp hade varit att gissa i den farliga
 * riktningen — en verklig andra betalning som försvinner lämnar restskulden fel
 * i huvudboken, och felet upptäcks först vid en avstämning. Spärren KASTAR, med
 * beloppet och tidpunkten i texten, så att den som vet bättre kan agera.
 *
 * ── TALET, HÄRLETT UR MÄTNINGAR ─────────────────────────────────────────────
 *
 * Fönstret ska täcka ett OMFÖRSÖK och aldrig en verklig andra handling. De två
 * gränserna, mätta 2026-09-02:
 *
 *   markAsPaidManually, projicerat värsta fall     830 ms   (#488, transaction-limits.ts)
 *   transaktionens tak                               8 s    (samma fil — hårt tak)
 *   AiToolExecution.durationMs i prod         p50 9 ms · p95 51 ms · max 51 ms   (n=11)
 *   gap mellan två verktygsanrop i SAMMA
 *   konversation, prod                        p50 0 s · p95 29 s · max 29 s      (n=7)
 *
 * Den sista raden är den som dimensionerar: ett omförsök är ett nytt modellvarv
 * eller en ny fråga från operatören, och det är det som tar tid — inte
 * databasarbetet, som är millisekunder.
 *
 * 120 s är ~4x det uppmätta största gapet och ~15x transaktionens tak. Det
 * ligger i "sekunder till minuter", inte i timmar.
 *
 * ⚠️ OCH VAD TALET INTE ÄR: ett bevis. Underlaget är TUNT (n=7 gap, n=11
 * körningar) — prod har låg trafik. Undre gränsen är dessutom inte hård: en snabb
 * operatör KAN registrera två likadana delposter inom två minuter. Det är just
 * därför spärren rapporterar i stället för att kasta bort, och därför posten
 * står kvar som KRÄVER_MÄNNISKA i `effect-idempotency.ts`. Ändras talet: mät om
 * gapet mot en större datamängd och skriv siffran här, med datum och n.
 */
export const DUPLICATE_MANUAL_PAYMENT_WINDOW_MS = 120_000

/** Minsta delmängd av Prisma-klienten spärren behöver — så den kan matas i ett prov. */
export interface DuplicateWindowClient {
  invoicePayment: {
    findFirst(
      args: unknown,
    ): Promise<{ id: string; amount: Prisma.Decimal; createdAt: Date } | null>
  }
}

/**
 * Kastar om en IDENTISK manuell betalning registrerades inom fönstret.
 *
 * ANROPAS INNANFÖR TRANSAKTIONEN OCH EFTER RADLÅSET. Det är skillnaden mellan
 * en spärr och en förhoppning: `markAsPaidManually` tar redan `FOR UPDATE` på
 * fakturan, så två samtidiga registreringar serialiseras och den andra ser den
 * förstas rad. Läggs kontrollen utanför låset är den en läsning före en
 * skrivning, och två samtidiga anrop passerar båda — samma defekt som #597.
 *
 * BARA `source: 'MANUAL'`. En bankmatchad rad bär `bankTransactionId`, som har
 * ett eget unikt index och därmed en riktig nyckel; den behöver inget fönster
 * och ska inte blockera en manuell registrering.
 */
export async function assertNoRecentIdenticalManualPayment(
  client: DuplicateWindowClient,
  args: { invoiceId: string; amount: Prisma.Decimal; nu?: Date },
): Promise<void> {
  const nu = args.nu ?? new Date()
  const senaste = await client.invoicePayment.findFirst({
    where: {
      invoiceId: args.invoiceId,
      amount: args.amount,
      source: 'MANUAL',
      createdAt: { gt: new Date(nu.getTime() - DUPLICATE_MANUAL_PAYMENT_WINDOW_MS) },
    },
    // `createdAt`, inte `paidAt`: fönstret handlar om när betalningen
    // REGISTRERADES, inte när den påstås ha skett. En bakdaterad betalning har
    // ett gammalt `paidAt` och ska inte falla utanför fönstret av det skälet.
    orderBy: { createdAt: 'desc' },
    select: { id: true, amount: true, createdAt: true },
  })
  if (!senaste) return

  const sekunder = Math.max(1, Math.round((nu.getTime() - senaste.createdAt.getTime()) / 1000))
  throw new ConflictException(
    `En betalning på ${senaste.amount.toString()} kr registrerades på den här fakturan ` +
      `för ${sekunder} sekunder sedan. Ingen ny betalning har bokförts.\n\n` +
      'Var det ett omförsök är fakturan redan uppdaterad — ladda om sidan. Är det en ' +
      'VERKLIG andra betalning på samma belopp: vänta någon minut och registrera den ' +
      'igen, eller registrera den från fakturavyn.',
  )
}
