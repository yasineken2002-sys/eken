# Agent 2 — överskott: inventering och nästa teststeg

Undersökt 2026-09-09 mot lokal commit
`ca29554ae4033b9546d3fb42687a7ad2a8414fdb` (#869 ovanpå #868).
Arbetsgren: `codex/agent2-overskott-inventering`.

## Slutsats

Det finns betalningsallokeringar, skuldberäkning, visning av överbetalda belopp
och bokföringsbyggstenar. Det finns inte en färdig, separat tillgodoreskontra
för dessa tio betalningars överskott i det undersökta schemat och flödena.
Att identifiera avin eller visa `overpaid` räcker därför inte för att kalla
betalningen färdighanterad.

Detta är en lokal kodinventering och en testspecifikation, utan produktionsändring.
Startfilen, den gemensamma överlämningen, CLAUDE.md och referensrapporten är lästa.
Git-status var ren. Ingen aktuell GitHub-/driftstatus har verifierats.
`apps/api/src/reconciliation/**` har varken lästs eller ändrats i undersökningen;
uppgifterna om dess tidigare utfall kommer från de bevarade rapporterna.
Mac-kopior och `/workspaces/eken-codex` har inte använts.

## Tre skilda frågor

| Fråga | Vad som måste styrka svaret | Vad som inte räcker |
| --- | --- | --- |
| Identifierad betalning | Bankrad, organisation, utpekad avi, hyresgäst/avtal och samstämmiga referenser | Köplacering eller enbart beloppslikhet |
| Reglerad avi | Allokering mot aktuell betalbar skuld, motsvarande verifikat och omläst skuld | Identifierad avi eller bankstatus `MATCHED` ensam |
| Kvarvarande tillgodobelopp | Beständigt belopp med ägare, ursprungsbetalning, bokföringsspår och händelsehistorik | `overpaid`, negativ kundfordran eller ett fritextmeddelande |

## Vad som redan finns

Sökvägar och radnummer avser ovanstående commit; kodkommentarer om äldre PR:er
har inte behandlats som bevis för dagens bankbeteende.

| Byggsten | Belägg | Begränsning för överskott |
| --- | --- | --- |
| Importerad bankrad och ursprung | `apps/api/prisma/schema.prisma:2516`, `BankTransaction`: belopp, datum, referens, rawOcr, externalId, dedupKey, organisation och aktör | Statusen är endast UNMATCHED/MATCHED/IGNORED (`:245`); ingen separat identifierings-/tillgodostatus eller tillgodorelation |
| Allokering av bankbetalning till avi | `schema.prisma:5231`, `RentNoticePayment`: bankTransactionId, rentNoticeId, amount, paidAt; unik kombination bankrad/avi | Modellen representerar pengar på en avi, inte en kvarvarande skuld till betalaren. Saknar egen organizationId; organisationsbindning måste följas via relationerna |
| Skuld och överbetalt belopp | `apps/api/src/avisering/rent-debt.service.ts:209`, `computeRentDebt`; `:347`, `rentNoticeOutstanding`; `apps/api/src/invoices/invoice-debt.ts:88`, `computeInvoiceDebt` | Härledda belopp från redan registrerade allokeringar. Ett helt ofördelat banköverskott syns inte automatiskt där |
| Visning av överbetalning | `apps/web/src/features/invoices/InvoicesPage.tsx:288`; `packages/shared/src/types/index.ts:300` | Fakturavyn anger uttryckligen att beloppet inte är bokfört som kundtillgodohavande |
| Spärr mot manuell överbetalning | `apps/api/src/common/payments/payment-within-debt.ts:52`, `assertPaymentWithinDebt` | Avvisar belopp över restskuld. Ger ingen separat överskottsbokning |
| Betalningsverifikat för avi | `apps/api/src/accounting/accounting.service.ts:3711`, `createJournalEntryForRentNoticePayment` | Bokar det inskickade beloppet 1930 debet/1510 kredit; ingen uppdelning till tillgodokonto. Att skicka hela 9 800 kr är inte en lösning |
| Gemensam verifikatskrivare | `accounting.service.ts:435`, `createNumberedEntry`; `schema.prisma:2092`, `JournalEntry` | Balansgrind, org-bunden idempotens, verifikationsnummer, periodkontroll och stöd för yttre transaktion är byggstenar. De bevisar inte ett nytt överskottsflöde |
| Reversering | `accounting.service.ts:3878`, `reverseJournalEntryForPayment`; `JournalEntry.reversalOfEntryId` | Betalningsreversering finns; automatisk reversering och operatörens länkade rättelse har olika spår. Hela kedjan med tillgodo måste utformas och provas |
| Krediteringar | `schema.prisma:1743` och `:5303`; `apps/api/src/avisering/rent-notice-credit.service.ts:147` | Betald faktura respektive betald/delbetald avi är uttryckligen avgränsade från tillgodohantering. Koden hänvisar till kontobeslut #505/#535; ärendenas aktuella status har inte hämtats |
| Deposition | `schema.prisma:5876`, `Deposit`; `accounting.service.ts:3930` | Eget ändamål, ett avtal med unik deposition och befintligt 2890-flöde. Detta är inte en generell behållare för återkommande hyresöverskott |

**Räntan gör skillnad:** `computeRentDebt.overpaid` mäter mot hela kravet,
inklusive ränta. `rentNoticeOutstanding.overpaid` mäter mot OCR-beloppet efter
kreditering (`rent-debt.service.ts:457`). `ocrOutstanding = 0` kan därför
samexistera med kvarvarande ränta. Ett nytt tillgodosaldo får inte härledas
blint ur något av dessa två visningsfält. Vad betalningen ska reglera måste
vara uttryckligt beslutat och testas även med avgifter, ränta och kreditering.

## De tio bevarade fallen

`betalning-57-0` till och med `betalning-57-9`, avsedda avier `avi-57-0`
till och med `avi-57-9`, gäller **en syntetisk hyresgäst över tio månader**
(oktober 2025–juli 2026), inte tio oberoende kunder.

Kontrollerat från hashverifierat originalunderlag: varje bankrad har ett
entydigt uttryckligt avinummer, samstämmigt OCR och fullnamn i detta material.
Varje betalning är 980 000 öre, varje angiven avi 977 500 öre, differens
2 500 öre. Totalt 9 800 000 = 9 775 000 + 25 000 öre.

Detta är beloppsinventering, inte utförd reglering. Originalfacit har tomma
allokeringar och `granskningKravsAvUnderlaget = true` för alla tio och bevaras.
Den sparade simuleringen anger `OVERSKOTT_KRAVER_HANTERING` för tio rader
i båda ordningarna. Resultatet ligger kvar på **1 970 korrekta automatiska,
noll felaktiga och 30 granskning** (98,5 %). Målet högst 20 är inte uppnått.

## Vad som saknas före produktionsbygge

1. Ett dokumenterat beslut om när den uttryckligen angivna avin får regleras
   och överskottet hållas separat, inklusive rätt ägare, avgifter/ränta,
   krediterade eller redan betalda avier. Återbetalning och användning på annan
   avi behöver egna beslut; ingen sådan användning antas här.
2. Fastställd kontohantering. Testspecifikationen väljer inget BAS-konto och
   behandlar inte depositionens konto som ett redan godkänt kundtillgodokonto.
3. Beständig tillgodoreskontra med org-/ägarbindning, ursprungsbankrad,
   belopp, tillhörande verifikat, aktör, beslut/policyversion och spårbara
   händelser för rättelse, framtida användning och återbetalning.
4. Atomisk hantering av allokering, avi, tillgodo, verifikat och bankstatus.
   Låsning, idempotens, återimport, återförsök och avmatchning måste omfatta
   hela effekten. Unik bankrad/avi hindrar inte ensam dubbelt tillgodo.
5. Gemensam läsning och redovisning av de tre frågorna ovan. Ett kvarvarande
   belopp måste vara synligt och avstämbart även sedan avin reglerats.
   Varken köstatus eller ett generiskt manuellt verifikat ger den domänkopplingen.

## Nästa teststeg — separat, fristående kontraktsprov

Nästa bygge bör vara ett kostnadsfritt Python-prov med standardbiblioteket,
utan produktionsimporter, nätverk eller databas. Det är **förberett här som
specifikation, inte implementerat eller kört**. Bevara befintlig policy,
baseline, facit och samtliga 2 000 fall oförändrade. Lägg ett nytt versionerat
förväntningskontrakt bredvid dem före första experimentkörningen.

Prova två lägen: (A) ingen beslutad överskottshantering, med oförändrat stopp;
(B) uttryckligen hypotetisk testpolicy som tillåter reglering av angiven avi
och separat bevarande av resten. B är inget kund- eller produktionsbeslut.
Ingen överföring till andra avier tillåts i något läge.

För varje rad ska provet redovisa källbankrad, org, identifierad avi/ägare och
identitetsunderlag, skuld före/efter, allokerat belopp, ofördelat belopp,
simulerat tillgodo med ursprung/händelse-id, journalrader, policyversion och
granskningsbehov var för sig. Facit och scenariotyp används först i utvärderingen.
Använd symboliska kontoroller i simuleringen; tillgodokontot är inte fastställt.

| Förhandsbestämt prov | Förväntat utfall |
| --- | --- |
| De tio originalfallen, läge A | Samma tio stopp, noll allokering/tillgodo/journal; hela bankbeloppet ofördelat |
| De tio originalfallen, hypotetiskt läge B | Per rad 977 500 öre till enbart angiven avi, 2 500 öre separat simulerat tillgodo; ingen annan avi ändras |
| Hela serien i B | Tio separata ursprungsposter, totalt 25 000 öre kvar på samma ägare; nästa månads betalning får inte automatiskt förbruka äldre tillgodo |
| Alla 2 000 i båda ordningarna | Jämför varje rad, allokering, ägare, skuld och tillgodo; tidigare 1 970 korrekta beslut bevaras. De tio utan identifierare och tio konflikterna förblir granskning |
| Samma logiska betalnings-id igen respektive två legitima olika id | En effekt vid återspel, två vid två betalningar. Samma belopp/ägare får inte ensamt vara dedupliceringsnyckel |
| Avmatchning och ommatchning | Spårbar motåtgärd för både allokering och tillgodo; ingen dubbel återbetalning eller återanvändning av reverserat verifikat |
| +1 öre, +100 öre, +101 öre och +2 500 öre | Exakt uppdelning i B, inget absorberat överskott; A behåller stopp. Negativa/noll/flerdecimaliga belopp avvisas |
| Redan delbetald avi | Uppdelning mot aktuell rest, inte ursprungsbeloppet |
| Redan betald, krediterad eller annullerad avi; ränta/avgifter; flera avtal; främmande org | Eget kompletterande material: behåll granskning när testpolicyn inte uttryckligen täcker fallet; inga gissade kvittningar |
| Medvetet felaktiga resultat i separata minneskopior | Utvärderingen ska falla för tappat öre, fel ägare, flytt till annan avi, dubbelt tillgodo och köplacering som framgång |

Obligatoriska invarianten vid första mottagandet är
`bankbelopp = aviallokeringar + separat tillgodo + ofördelat belopp`, i heltalsören.
I ett fullständigt B-utfall är ofördelat noll. Simulerade journalrader ska
samtidigt visa hela bankbeloppet en gång, reglerad fordran exakt motsvarande
allokeringen och tillgododelen separat. Efter rättelse/användning/återbetalning
ska händelsekedjans nettobelopp stämma; ingen gammal händelse skrivs över.

Redovisa två bedömningar sida vid sida: originalfacit och det nya hypotetiska
kontraktet. Nytt beteende för de tio är en avvikelse från originalfacit, inte
en retroaktiv förbättring av #869. Att B eventuellt ger tio fullständiga
simulerade uppdelningar får inte rapporteras som tio nya produktionsmatchningar.

Efter detta återstår riktig Postgres-verifiering av atomisk rollback vid fel
mellan varje skrivning, samtidiga anspråk, org-isolering, importdeduplicering,
stängd period/saknat konto samt rättelse och ommatchning. En minnessimulering
kan inte bevisa de egenskaperna. Produktionsintegration i bankvägen kräver
separat uppdrag; nuvarande förbud mot reconciliation-ändringar gäller fortsatt.

## Utförd kontroll i denna undersökning

- Befintliga Python-kontrollprov: **28/28 passerade**, ny körning i Codespaces.
- SHA-256 kontrollerad för uppackad ursprungsfixture, grundresultat AGENT_PA
  och sparad referensrapport mot respektive manifest.
- Separat läsande kontroll: **10/10** överbetalningar har ovanstående belopp,
  entydigt avinummer, samstämmigt OCR/namn och oförändrat granskningsfacit.
- Sparad referensrapport läst i båda ordningarna: 1 970/0/30. Ingen ny full
  återspelskörning eller ny överskottssimulering påstås.
- Cirka 2,2 GB ledigt. `pgrep -af '[j]est|[t]sc'` gav inga träffar.
  Inga installationer, Jest-/TypeScript-körningar, databas- eller modellanrop.

Detta dokument ändrar inga originaldata och ger inget belägg för 99,98 % i drift.
