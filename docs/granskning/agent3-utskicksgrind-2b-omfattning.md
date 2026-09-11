# Agent 3, PR 2b — steg 1, omräknad budget före implementation

Datum: 2026-09-11. Byggordern höjer taket till **700** ändrade
produktionsrader mot `0973272d5eb8f6f8285ec8c98f039a47f6ec568b`.
Den historiska 400-radersbedömningen nedan är ersatt för steg 1.

Worktree verifierad: `/workspaces/eken-fran-mac-20260909/arbete/agent3-utskicksgrind-2b`.
Gren `codex/agent3-utskicksgrind-2b`; inledningsvis ren, HEAD
`6524b68f8111cd4567db9d53e4e509301b44c4fb`. GitHub #879 är ett öppet utkast
med bas `codex/agent3-utskicksgrind`, exakt godkänd 2a-HEAD ovan.
CLAUDE.md, 2a:s leveransrapport och befintliga kontrakt/facit är lästa.
Inga tillämpliga AGENTS.md hittades. Endast denna worktree används.

## Sammanhängande plan och radbudget

Tre nya tabeller: organisationsbunden principal; oföränderlig Dispatch som
förenar outbox, frysta resurser, provideridentitet och fullständiga byte;
append-only observationer för varje anropsrätt, kvitto, avvikelse och
stängning. Syntetisk betrodd rendering utan extern I/O sker i beslutets
ägda transaktion. Därmed behövs ingen separat efterföljande artefakttabell
eller Attempt-tabell: startens event bevarar t0 och attemptId är DB-unikt.
Detta är en förenklad lagring av hela steg 1, ingen ytterligare uppdelning.

| Del | Tillagda + borttagna, uppskattat |
| --- | ---: |
| NY SQL-migration: 3 tabeller/FK/CHECK, insert-/anropsvakter, komplett ersatt eventfunktion och historikskydd | 230–250 |
| Prisma: 3 modeller och relationer | 60–70 |
| Befintlig delivery-decisions.ts: återbruk av tx/slutkontroll, identitets- och tjänstegren, inklusive borttagna rader | 20 |
| Ny exekverare och portar: atomiskt beslut/Dispatch, publicering, start, fönster, 409, kvitton/UNKNOWN | 235–260 |
| Skrivsamordnare för dokument och charge-medlemmar | 30–40 |
| CI: literal 17 + 30 ID:n, genomförda positiva assertionstal, namngivna fel, inklusive borttagna gamla rader | 49–59 |
| **Summa** | **624–699** |

Bedömningen utgår från läsbar kod och explicit återbruk, inte hoptryckta
rader. Ny SQL-funktionskropp räknas helt; 2a:s migration ändras inte.
Detta är en planeringsuppskattning, inte en uppmätt diff eller matematisk
undre gräns. Den ryms precis; faktisk diff ska räknas under arbetet. Om
nödvändig sammanhängande lösning överstiger 700 stoppas arbetet och det
konkreta överskridandet rapporteras. Inga krav får gömmas i tester/docs.
Tester och dokumentation redovisas separat och undantas endast från taket.

## Tre självständiga förgranskningar

- `granska_db`: tre-tabellsplan 600–675 med äldre CI-antagande 25–35.
  Återbruk av 2a:s transaktion, snapshot, lås, originalposition och historik;
  komplett eventfunktion i ny migration. Inga behov av fem separata tabeller.
- `granska_provider`: nya providerkrav kostar 100–155 utöver äldre planens
  kärna. Fast t0, global retrybudget, sen kvittokorrelation och gränsen efter
  sista kontroll måste uttryckas. Den aritmetiken får inte summeras igen
  ovanpå den nya tre-tabellsplanen som redan inkluderar dem.
- `granska_facit`: CI behöver cirka 55 ändrade produktionsrader, inte gamla
  25–40. Literal 17 + 30 ID:n, rätt svit och positiva faktiska assertionstal.
  Detta ersätter DB-granskarens CI-antagande i den sammanräknade budgeten.

Fynden är införda i [kontrakt](agent3-utskicksgrind-2b-kontrakt.md) och
[fryst facit](agent3-utskicksgrind-2b-facit.md) före första SQL/kodändring.
Det är läsgranskning, inte genomförda beteendeprov.

## Steg 2, uppskattat men inte byggt

Verklig faktura-/avirendering måste ta fryst underlag och frysta resurser
utan levande DB-/lagringsuppslag, avlägsna tid/slump/filnamnsvariation och
köra samma rendererportkontrakt. Preliminärt **250–450 produktionsrader**
plus **250–500 testrader**; den verkliga resurs-/mallkedjan måste först
inventeras för en säkrare siffra. Syntetisk rendering i en kort tx bevisar
inte att Puppeteer ryms i 2a:s 5-sekundersgräns; steg 2 måste välja/verifiera
framställningsgräns utan att bryta den atomiska beviskedjan.

Inkoppling av producenter, workers, samtliga skrivare och dokumentutlämning,
äldre dokument samt produktionsmätning återstår separat. De ingår inte i
renderersiffran och byggs inte i steg 1. Allt förblir inaktivt.

---

## Historisk bedömning vid 400-radersstoppet (6524b68f)

# Agent 3, PR 2b — omfattningsbedömning och budgetstopp

Datum: 2026-09-11. **Stopp före implementation enligt beställd gräns cirka
400 ändrade produktionsrader. Detta är inte färdig 2b.**

## Verifierad bas och isolering

Worktrees och grenar kontrollerades före skapandet. Ny egen arbetsyta:
`/workspaces/eken-fran-mac-20260909/arbete/agent3-utskicksgrind-2b`.
Ny gren: `codex/agent3-utskicksgrind-2b`. Den skapades direkt från
`0973272d5eb8f6f8285ec8c98f039a47f6ec568b`.

GitHubs metadata för #878 kontrollerades också: samma exakta HEAD, öppen PR,
gren `codex/agent3-utskicksgrind`. Den grenen är bas för det nya utkastet.
Ingen tidigare PR för den nya grenen hittades vid kontrollen.
De frysta grenarna, deras PR:er och andra arbetsytor har inte ändrats.

Tillämplig CLAUDE.md och de fyra beställda granskningsdokumenten lästes,
liksom 2a:s implementation, migration, Prisma-modeller och DB-spec. Inga
AGENTS.md hittades i kontrollerade föräldrar eller worktree. `rg` saknas;
sökningar gjordes med git grep, git ls-files, grep och riktade läsningar.
Tre separata granskare arbetade enbart läsande enligt ordern.

## Konkret budget före implementation

2a:s historiska preliminära uppskattning 250–350 rader för 2b var ett
planeringsspår. Den faktiska godkända implementationen och den nu preciserade
ordern kräver följande arbete. Tabellen uppskattar läsbar kod i befintlig
stil; den är ingen uppmätt diff eller matematisk undre gräns.

| Del och avgränsning | Tillagda | Borttagna | Summa |
| --- | ---: | ---: | ---: |
| Ny SQL: outbox, oföränderlig artefakt, konfliktspår, FK och försegling | 85–115 | 0 | 85–115 |
| Prisma: motsvarande modeller/relationer och principalfält | 45–60 | 0 | 45–60 |
| Ny SQL: vidareutvecklad eventfunktion med tjänsteprincipal och startbindning | 95–125 | 0 | 95–125 |
| Befintlig TS: aktörstyper, auktorisering och ägd starttransaktion | 40–60 | 10–20 | 50–80 |
| Ny TS: atomiskt beslut/outbox, publicering, artefaktport/verifiering, worker, kvitto och återstart | 150–200 | 0 | 150–200 |
| Ny TS: intern skrivsamordnare med beständig SENDING/UNKNOWN-kontroll | 40–60 | 0 | 40–60 |
| CI: explicit 17-ID-krav, namngivna fel och obligatoriska nya 2b-prov | 20–30 | 5–10 | 25–40 |
| **Summa kärna** | **475–650** | **15–30** | **490–680** |

SQL-ersättningen ska ligga i en NY migration; hela dess nya funktionskropp
räknas. Gammal migration får inte skrivas om. Prisma är separat från SQL,
befintliga TS-ändringar separat från den nya exekveraren, och CI räknas
konservativt som produktion. Tester och dokumentation ingår inte i tabellen.

Kärnan omfattar en betrodd framställningsport och byteverifiering, men INTE
anpassningen av verklig faktura-/avirendering till helt frysta resurser.
Den kostnaden tillkommer innan hela beställda artefaktkedjan kan bevisas.
Den skjuts inte tyst till 2c för att få 2b att se mindre ut. Även kärnans
lägsta planeringsvärde passerar redan 400 med cirka 90 rader.

Ingen kod har komprimerats, flyttats till tester eller gömts i dynamisk
SQL-textpatchning för att få ned radantalet. Inget större undantag antas av
att 2a fick 650 rader. Därför stoppades bygget före första produktionsändring.

## Kodbelägg för arbetet

Hänvisningarna avser den frysta basen och är oförändrade i detta utkast.

| Befintlig punkt | Konsekvens för 2b |
| --- | --- |
| `apps/api/src/consumption/delivery-decisions.ts:189` | `decide(command, tx)` kan återanvändas för atomisk outbox. |
| Samma fil `:73` | Alla nya tx-ägare måste köra slutkontrollen efter sina sista skrivningar. |
| Samma fil `:109`, `:248` | Varje övergång kräver människa; workerprincipal saknas. |
| Samma fil `:240`, `:254` | Startbehörighet följer ägd commit; snapshotfel kastas och lämnar inget beständigt konfliktspår. |
| `apps/api/prisma/migrations/20260911120000_delivery_decisions/migration.sql:194`, `:200` | Eventfunktionen kräver aktiv User; ny läsbar funktionsdefinition behövs för tjänst. |
| Samma SQL `:107`, `:121` | Snapshoten säger UNVERIFIED och binder lagringsnyckel, inte resursbyte. |
| Samma SQL `:157` | Beständig SENDING/UNKNOWN-reservation finns och ska återanvändas. |
| `apps/api/prisma/schema.prisma:7144` | Beslutets ID är utskicks-ID; outbox och bytebindning saknas. |
| `apps/api/src/invoices/pdf.service.ts:135`, `:155` | Nuvarande renderer läser aktuellt dokument och aktuell logotyp. |
| `.github/workflows/ci.yml:161` | Obligatoriska mängden är bara 2a-01 till 2a-14. |
| `apps/api/src/consumption/delivery-decisions.db.spec.ts:1284` | 2a-17 finns, men kan försvinna utan att den nuvarande ID-kontrollen reagerar. |

## Oberoende granskning och bemötta invändningar

- `granska_transaktion_2b`: egen helhetsbedömning **465–630** rader. Påpekade
  att rollback av startfelet även tar bort ett konfliktspår i samma tx, att
  skrivspärr måste överleva sessionen och att sent kvitto efter UNKNOWN inte
  ger tjänsten mänsklig utredningsrätt. Detta har gjorts uttryckligt i kontraktet.
- `granska_bindning_2b`: egen helhetsbedömning **505–695** rader, före faktisk
  rendereranpassning. Påpekade skillnaden mellan hash av godtyckliga byte och
  betrodd framställning ur beslutad snapshot, samt att en mänsklig actorId
  inte kan lånas av workern. Slutläsningen fångade även resursbyte mellan
  beslut och framställning: infrysning måste bindas senast i beslutets commit.
  Kontrakt och facit preciserades; själva kontraktsutökningen är fortfarande
  olöst. Kostnaderna och bevisgränserna redovisas.
- `granska_facit_2b`: bekräftade att borttaget 2a-17 inte fångas av nuvarande
  obligatoriska mängd och att PR måste finnas för CI, eftersom push-triggern
  bara gäller main. Skilde faktiska blockerande DB-sessioner från enbart
  parallella Promise-anrop. Det oberoende facit anger båda beviskraven.

Granskarna pekade även ut sista fönstret efter vunnen start men före externt
anrop: DB-token kan inte återkalla en pausad process där. Kontraktet lovar
inte detta; osäkerhet och skrivspärr kvarstår tills korrelerad slutlighet
och vid negativt utfall även upphörd gammal sändförmåga är belagda.

Detta är läsgranskning och designrättningar, inte körda beteendeprov.
Kvarstående beroenden är konkret tjänsteautentisering, betrodd rendering
från frysta resurser, providerfinalitet/fencing och senare samordnad
inkoppling av äldre producenter, workers, skrivare och utlämningsvägar.
Inget av detta är godkänt eller byggt som 2c här.

## Leverans- och verifieringsstatus vid stoppet

Endast tre dokument tillkommer: denna bedömning,
[exekveringskontraktet](agent3-utskicksgrind-2b-kontrakt.md) och
[fryst oberoende facit](agent3-utskicksgrind-2b-facit.md).
**Produktion 0 tillagda + 0 borttagna rader; tester 0 + 0; migrationer 0 nya
eller ändrade.** Exakt dokumentationsdiff, slutlig HEAD, PR-/CI-länkar och
arbetskopiestatus redovisas i PR-beskrivningen och slutrapporten.

Inga lokala Jest-/typecheckjobb, nya testdatabaser eller DB-körningar har
startats. Två DB-körningar, radantal, lokal beteendemutation och röd/återställd
grön CI-kanariefågel är **inte utförda**. CI-ratchetens identifierade fel är
inte rättat efter budgetstoppet. En eventuell vanlig CI-körning för detta
dokumentationsutkast verifierar endast befintlig kod, aldrig färdig 2b.

Ingen produktionsväg har kopplats in, inga flaggor aktiverats, inga riktiga
utskick eller betalda API-anrop gjorts. Ingen merge, reset, rebase, amend,
force-push eller driftsättning. Endast den egna nya grenen får pushas.

## Separat produktionsmätning

**Ej påbörjad: orderns villkor ”efter färdig 2b” är inte uppfyllt.**
Ingen produktionsanslutning eller godkänd läsåtkomst har verifierats i denna
omgång och inga databasfrågor har körts. Inga antal lämnas för A eller B;
lokala data, CI-databasen eken_dev och uppskattningar ersätter inte mätningen.

Den senare läsuppgiftens definition står kvar: A är alla Invoice plus alla
RentNotice. B räknar fakturor med minst en ConsumptionCharge.invoiceId och
avier med minst en RentNoticeLine.consumptionChargeId, varje dokument en gång.
Organisation, dokumenttyp/status och UTILITY får inte ersätta relationerna.
Mätningen kräver verifierad produktionsidentitet, befintlig godkänd
läsåtkomst, verifierat schema och en konsekvent skrivskyddad snapshot med
tidsgränser. Ingen migration eller delivery_charge_ids-funktion installeras.
Ingen backfill, undantagsväg eller verksamhetsslutsats följer av ett litet tal.
