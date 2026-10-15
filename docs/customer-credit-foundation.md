# Kundtillgodo – mottagning, automatisk användning och beständigt aviutskick

Arbetet utgår från `main` på `9c17daec`, i grenen
`codex/agent2-kundtillgodo`. Tjänsten är registrerad i bankimportens modul,
bakom en organisationspolicy som är **avstängd som standard**. Ingen policy
aktiveras av migrationerna och inget nytt aktiverings-API införs. Historiska
bankallokeringar ändras inte.

Den här etappen innehåller datamodell, transaktionell bankmottagning och
automatisk användning av tillgodo vid nästa ordinarie avisering. Användningen
och avins fastställda innehåll sparas i samma databastransaktion. PDF, mejlkö
och leverantörskvitto hanteras därefter med ett beständigt utskicksunderlag
och återhämtning. **Kopplingen är byggd men fortfarande avstängd i kunddata.**

Etappen innehåller inga nya matchningsprocent och ingen ny körning av 2 000
betalningar. Experimentet i
[#869](https://github.com/yasineken2002-sys/eken/pull/869) är separat evidens från
syntetiska data och en tidigare prototyp; det bevisar inte denna integration.

## Vad kärnan gör

- **Sparar en skuld till hyresgästen.** En entydig överbetalning binds till
  organisation, hyresgäst, avtal, källavi, banktransaktion, betalningsallokering
  och verifikat. Tillgängligt tillgodo härleds från ursprungsbeloppet minus
  bokförda användningar. Unika nycklar, databaslås och saldokontroll hindrar
  dubbel användning.
- **Bevarar källunderlaget.** `sourceProofHash` binder de kontrollerade
  bankuppgifterna och källallokeringen. Mottagningsreplay och användning måste
  stämma med underlaget. Belopp och levande källverifikat kontrolleras; att
  enbart ett verifikat finns är inte tillräckligt.
- **Skiljer mottagning från användning.** Mottaget överskott bokförs som bank
  mot en uttryckligen vald skuld. Användning minskar skulden och hyresfordran
  utan en andra bankinbetalning och utan ändrad hyresintäkt eller moms.
  Verifikat och tillgodohändelse skrivs i samma transaktion. Kontovalet är
  ännu inte ett godkänt produktionsbeslut.
- **Visar rätt betalningsbelopp.** Hyra 9 775 kr och använt tillgodo 25 kr ger
  9 750 kr i PDF, OCR-rad och mejl samt raden ”Tillgodo använt”. Endast
  allokeringar med källan `CUSTOMER_CREDIT` avräknas här. Originalavins
  befintliga hantering av historiska bankbetalningar och manuella betalningar
  ändras inte. `rentNoticePayableTotal` ändras inte globalt.

Mottagning och användning ingår även i hyresgästens befintliga historik,
med ursprunglig tidpunkt, belopp, aktörsslag och pekare till respektive
oföränderlig rad. Både organisation och hyresgäst avgränsar läsningen.

Kundtillgodo ingår i den befintliga spärren mot hårdradering av en hyresgäst;
beskedet hänvisar till avidentifiering. Dev-verktygets uttryckliga helradering
har uppdaterad FK-ordning för de nya tabellerna. Det ändrar inte produktens
bevarandepolicy och verktyget har inte körts för att radera tillgodounderlaget.

## Automatisk användning och fastställt aviunderlag

`prepareNoticeForSend` återanvänder först en befintlig reservation. Det gäller
även om avin nu är `PAID` eller policyn har stängts av: ett tidigare bokfört
avdrag får inte försvinna eller göras en gång till. Utan reservation och utan
aktiv policy används det befintliga aviflödet. Depositioner och historiska
öppningsavier omfattas inte av den nya automatiska tillgodoanvändningen.

Ett automatiskt tillgodoavdrag kräver en ännu oskickad ordinarie `EVENO`-hyresavi
före förfallodagen. Utan tillgängligt tillgodo får en oförändrad avi även
fastställas efter förfall, med 0 kr avdrag och hela beloppet. Den får inte
redan ha betalningar, kreditnotor,
påminnelseavgift, upplupen ränta, inkassosteg eller kundförlust. Saknas säkra
förutsättningar avbryts förberedelsen; den faller inte vidare till ett
betalningsmejl med ett gissat belopp. Befintliga krav på färska bankdata,
känd aktör, period, källbevis och hantering av äldre skuld gäller fortsatt.

Efter färskhetsgrinden låses avtalet, alla berörda bankrader, alla berörda
avier och tillgodoposter i bestämd ordning. Saldo läses om under lås.
Tillgodo från tidigare perioder används i ordningen mottagningstid och id,
aldrig mer än avins skuld. Alla avdrag, betalningsallokeringar, verifikat och
en `RentNoticeSend` skrivs i **samma transaktion**, med samma tillämpningstid.
Underlagets schema, mottagarhash och båda beloppen måste stämma innan commit.
Ett fel i underlaget rullar också tillbaka ekonomin och verifikationsnumren.
Inget PDF-, Redis- eller mejlanrop görs inne i den transaktionen.

Även en godkänd avi med **0 kr tillgodo** får en reservation när policyn är
aktiv. Annars skulle ett äldre jobb kunna skicka fullbeloppet samtidigt som
ett annat jobb räknar av ett nytillkommet tillgodo. Reservationsnyckeln är
unik per avi. Originalets HTML, mottagare, betalningsbelopp och använt tillgodo
är därefter oföränderliga, även genom direkta databasuppdateringar. Nya
tillgodoavdrag på samma avi avvisas. Senare betalningar påverkar saldot men
skriver inte om det redan fastställda originalet. Mejlet förklarar detta och
hänvisar till aktuellt saldo i portalen: ett fastställt belopp på 975 kr kan
exempelvis ha 475 kr kvar efter en senare delbetalning på 500 kr.

Ett äldre mejljobb tar också ett utskicksanspråk under **samma avilås** precis
före leverantörsanropet. Har den gamla vägen redan tagit anspråket får den
nya vägen inte boka tillgodo. Har den nya reservationen hunnit först får det
gamla jobbet inte skicka sitt gamla belopp. Samma äldre jobb kan återförsöka
sitt eget anspråk; ett annat jobb får inte ta över ett okänt utfall.

## PDF, mejl och återhämtning

PDF renderas från den sparade HTML-versionen efter commit. Färdig mejl-HTML,
text, avsändare, mottagare och PDF-byte sparas tillsammans som `mailPayload`
före första mejlköningen. Om två renderare konkurrerar får bara en payload
sparas; båda läser och använder vinnaren. Omförsök skickar samma sparade byte
med samma leverantörsnyckel. Ett PDF-fel lämnar reservationen kvar så att
renderingen kan göras om utan ett nytt avdrag. Nedladdning använder den
sparade PDF:en när den finns, annars det fastställda HTML-underlaget.

När tillgodot täcker hela avin är avin fortsatt `PAID`, men informationsmejlet
ska ändå skickas. Underlaget visar **0 kr att betala** och att tillgodot
reglerat avin. Betalkupong, OCR-betalningsuppmaning och dröjsmålsvarning
utelämnas. Att vara `PAID` är alltså inte samma sak som att informationen
har skickats. En avi som i stället hunnit betalas på annat sätt får inget nytt
betalningsmejl från denna reservation.

`queuedAt` betyder att ett mejljobb köats. `dispatchStartedAt` betyder att
ett leverantörsförsök påbörjats. Först ett sparat leverantörs-id ger
`acceptedAt` och `sentAt`; en helt kreditbetald avi behåller status `PAID`.
**Leverantörens acceptans är inte bevis på leverans till hyresgästens inkorg.**
Leverans och studs hör fortsatt till leverantörens separata händelser.
Kvittensfel återförsöks med samma sparade innehåll och nyckel; ett redan sparat
identiskt kvitto blir en tom omkörning, medan två olika kvitton avvisas.

Resend dokumenterar ett **24-timmarsfönster** för idempotensnycklar. Vår
konsument stoppar därför nya försök när ett påbörjat men okvitterat utskick
är minst **23 timmar** gammalt. Den timmens marginal är ett lokalt
säkerhetsval. Ett sådant utfall kräver kontroll av leverantörskvittot; systemet
byter inte nyckel och chansar med ett nytt mejl. Se
[Resends dokumentation om idempotensnycklar](https://resend.com/docs/dashboard/emails/idempotency-keys),
kontrollerad 2026-10-15. Flödet ger ingen obegränsad garanti om exakt en extern
leverans: databasen och mejlleverantören delar ingen transaktion.

`NoticeDispatchRecoveryScheduler` söker **var femtonde minut** efter
reservationer utan leverantörskvitto, tidigast femton minuter efter
förberedelsen. Varje pass tar högst **100** rader. Ett atomiskt anspråk på
`recoveryAttempts` och förfallen `recoveryAfter` bestämmer vilken process som
får köa. Anspråket sparas före Redis-anropet, med nästa försök tidigast efter
**1 timme, 4 timmar och därefter 24 timmar**. Därmed försvinner inte en
reservation om processen dör mellan databasen och kön, och ett permanent fel
tar inte samma första hundra platser varje kvart.

Återhämtningen köar ett nytt PDF-jobb som läser samma reservation; den skapar
inget nytt tillgodo. Även helt kreditbetalda informationsavier omfattas.
Organisationens status, mejlspärr, anonymisering och avistatus kontrolleras
igen. Organisationsstatus kontrolleras också i den ekonomiska transaktionen;
mejlspärren återläses efter konsumentens avilås, så en gammal förkontroll
inte ensam kan godkänna ett utskick. Upprepade fel rapporteras via cron-felhanteringen. Ett gammalt eller
numera spärrat leverantörsförsök med okänt utfall ger ett larm och **inget nytt
utskick**; kontrollen återkommer med dygnspaus. Ett fullt batchurval loggas så
att kvarvarande kö inte misstolkas som färdigbehandlad. Schema och återhämtning
aktiverar ingen kundpolicy.

## Skydd vid senare ändringar och personuppgifter

- **Kreditnota:** en ny kreditnota avvisas under avilås medan den fastställda
  reservationen saknar leverantörskvitto. Det skyddar även en reservation
  med 0 kr tillgodo, som annars saknar betalningsrader att upptäcka.
- **Förbrukning och extra avgifter:** nya sådana rader får inte läggas på en
  avi som redan har ett fastställt underlag. De måste hanteras genom en
  annan korrekt debitering, inte genom att ändra originalets betalningsbelopp.
- **Annullering och verifikaträttelse:** kontrollen av betalningar och
  tillgodokopplingar görs under det gemensamma avilåset, respektive banklåset
  för källbetalningen. En samtidig tillgodoanvändning får inte döljas av en
  gammal förläsning. Osammanhängande annullering eller rättelse av tillgodots
  käll-/användningsverifikat avvisas.
- **Ränta:** kundtillgodo behandlas som betalning på dess faktiska
  tillämpningsdag. Ränteperioden delas vid den dagen så att avdraget varken
  ignoreras för senare dagar eller sänker kapitalet retroaktivt. Övriga
  betalningskällors räntepolicy ändras inte här.

Det sparade originalet innehåller personuppgifter, bland annat namn, adress
och betalningsinstruktion. Det bevaras med räkenskapsunderlaget enligt
projektets befintliga avidentifieringspolicy. Oföränderligheten innebär inte
att den historiska mejladressen får användas igen: förberedelse, producent,
konsument och återhämtning kontrollerar avidentifiering före nya utskick.
Ett redan påbörjat externt anrop kan inte återkallas genom en senare lokal
statusändring; ett okänt utfall behöver då följas upp.

Hyresgästens GDPR-export omfattar nu den egna avins sparade HTML-original,
historisk mottagare, belopp och förberedelse-/kö-/acceptanstider. Urvalet går
via just den hyresgästens avier och en uttrycklig fältlista. Interna jobb-id:n,
leverantörsnycklar och hela mejlpayloaden exporteras inte. Exportfältet heter
`providerAcceptedAt`, inte levererad. Befintliga generella GDPR-inventarier
täcker inte alla personuppgifter i JSON-kolumner; därför finns särskilda prov
för denna export och spärren efter avidentifiering.

## Bankimportens mottagning

Efter användarens uttryckliga godkännande ändras `reconciliation` bara i denna
arbetskopia. Med aktiv policy, känd aktör och konfigurerat bankkonto prövas en
hel referens av formen `AVI-2026-09-0001` före det månatligen återanvända
hyresgäst-OCR:t. Ett överbelopp större än den befintliga toleransen på 1 kr
kan slutreglera den uttryckliga avin och skapa ett separat tillgodo. Beloppet
allokerat på avin överstiger aldrig dess återstående skuld.

Referensen får ha prefixet ”Hyra”, ”Inbetalning” eller ”Betalning”. Det andra
fältet måste vara tomt, en neutral banketikett, samma avi eller ett rent OCR.
Ett angivet OCR måste stämma med avin och hyresgästen. Motstridiga referenser,
en redan betald målavi eller otillräckligt underlag får inte falla vidare till
en annan månad. OCR utan uttrycklig avi behåller befintlig matchning/vattenfall.
Detta är ingen ny AI-tolkning av fritext.

En befintlig begränsning bevaras: den äldre extraktorn kan läsa `2026` som
rå-OCR ur ett avinummer. Även prosakontrollen godtar detta årtal som OCR enligt
den befintliga kontrollsiffreregeln. Det värdet kastas inte bort för att
framtvinga en match. AVI i beskrivningen och korrekt OCR i referenskolumnen
är en stödd kombination; motsägande rå-OCR stoppar den nya vägen.

Gemensamma organisations-/granskningslås och avtalslås tas före bankrad och
avi. Bankens belopp, datum, konto och referensbevis återläses under lås. Vanlig
betalning, betalningshändelse, två verifikat och tillgodoraden skrivs atomiskt.
Ett fel lämnar den redan importerade bankraden omatchad och rullar tillbaka
hela matchningen. Avmatchning av en källa som skapat tillgodo avvisas med ett
begripligt fel före någon delvis rättelse.

Första importen får registrera mottagna pengar även när inget tidigare
färskhetsdatum finns. Samma lås skyddar mot olöst identitetsgranskning och
importstopp; inget färskhetsdatum förfalskas. Användning på nästa avi behåller
hela färskhetsgrinden. PSD2-vägen saknar ännu det verifierade bankkonto och
den aktörskontext som krävs för denna mottagning.

## Kvar före aktivering och komplett kundflöde

1. Avmatchning och andra rättelser behöver en sammanhängande kundväg för
   bankallokering, tillgodoreskontra, aviunderlag och verifikat. Lås och
   rättelsespärrar stoppar osammanhängande ingrepp; de ersätter inte ett
   genomfört rättelseflöde.
2. Återbetalning saknar en riktig bankbevisport och en komplett domänlivscykel
   med reservation, bekräftelse och avvisad utbetalning. En bokföringsmetod
   eller ett manuellt besked är inte bevis på att pengar har betalats ut.
3. Revisor behöver uttryckligen välja skuldkontot och bekräfta kopplingen
   mellan bankkontot och bokföringens `1930`. Testkonton är inga godkända
   standardval och depositionskontot används inte som automatisk ersättning.
4. Fortnox-stödet för de nya `customer-credit-*`-källorna och deras
   kontomappning återstår. Ett lokalt balanserat verifikat bevisar inte att
   exporten stöder källan.
5. PSD2 behöver verifierad kontokoppling och aktörskontext. En referensväg
   som bara täcker uttryckliga AVI-nummer bevisar inte målet för alla bankformat.
6. Första reservationen på en redan delbetald/krediterad avi eller en avi
   med ränta/kravsteg är inte stödd med aktiv carry-policy. Finns tillgängligt
   tillgodo på en redan förfallen avi stoppas också förberedelsen. Detta måste
   hanteras innan bred aktivering; nollsaldoundantaget gäller bara helt
   oförändrade avier.
7. Hela CI på den nya committen och Claudes granskning krävs före merge.
   Produktionsaktivering är ett separat beslut efter verifierad kontokoppling
   och genomgång av återhämtningens larm. Detta är fortfarande ett utkast med
   avstängd policy, inte ett aktiverat komplett kundflöde.

## Avgränsad verifiering

Mätt lokalt 2026-10-15, Node 24.19.0 / Prisma 5.22.0 / PostgreSQL 16.15:

Den nya fasen med automatisk användning och beständigt utskick:

- **402/402 prov i 21 riktade sviter**, körda seriellt i tre grupper: 94
  utskicks-/återhämtningsprov (sex sviter), 161 ekonomiska regressionsprov
  (sex sviter) och 147 bank-/tillgodo-/portal-/inventarieprov (nio sviter).
  De 94 omfattar 22 verkliga DB-kärnprov, 19 prov genom tjänstekedjan,
  28 recoveryprov och 25 kö-/legacy-/kvittensprov. Det är kodprov, inte en
  uppmätt kundvolym eller matchningsprocent. De sista körningarna avslutades
  2026-10-16 svensk tid.
- DB och bokföring är verkliga och isolerade; PDF-renderaren, Redis och
  mejlleverantören är kontrollerade testdubblar. React-mejlmallen renderas
  med ReactDOMServer i stället för paketets dynamiska ESM-adapter. Inga
  riktiga mejl skickas, inga bank-/modell-/produktionsanrop görs.
- Två samtidiga riktiga DB-transaktioner prövar äldre utskicksanspråk mot
  ny reservation: exakt en väg vinner. Andra prov täcker PDF-/köfel,
  provideraccept följd av timeout/DB-fel, konkurrerande PDF-byte, PAID0,
  senare delbetalning, anonymisering och ändrad organisationsstatus/mejlspärr.
- Objektscope-inventariet blev först rött för nya skrivningar. Diffen är
  granskad och registrerad: reservationer skapas från en org-scopad avi;
  payload/kvittens skrivs via `rentNotice.organizationId`; recovery tar
  redan funna beständiga rad-id:n med CAS och omprövad utskicksspärr.
  Inventariet ser också två rent syntetiska fixture-skrivningar. Inga
  skyddsundantag eller testassertioner har tagits bort för att få grönt.
- **16/16 relevanta vakter** är gröna, inklusive 35 klassade cron-jobb och
  deras varaktiga felsänka. ESLint på 55 ändrade TS-filer samt uppföljning
  på slutändringarna är grön. Full typecheck/hela sviten mäts av CI på den
  nya committen; tidigare grönt CI ersätter inte den mätningen.
- Råa utfall ligger under `docs/eval/customer-credit-foundation/dispatch-*.txt`.
- Tre nya additiva migrationer inför utskicksreservationen, spärren mot ett
  tidigare utskicksanspråk och recoveryprogress. Inga tidigare migrationer
  skrivs om. Dokumentets oföränderliga fält och kvittenser skyddas i databasen;
  recoveryfält får ändras, men negativa försök och recovery på legacyrader
  avvisas. Schema-drift ska mätas mot separat tom shadowdatabas.

Bankimportuppföljningen före denna fas:

- **117/117 prov i sex riktade sviter**: 26 bankimportprov (25 affärsfall och
  miljöförutsättning), 27 referensprov, 34 befintliga tillgodoprov och 30
  OCR-/API-import-/avmatchningsregressioner. Ingen typkontroll har stängts av.
- Första import utan förhandsbyggd färskhet, andra organisationer/konton,
  motsägande OCR/AVI, historisk skuld, G2-paus och importstopp är prövade. Den
  nya AVI-vägen markerar historisk skuld även utan fungerande tenant-OCR, så
  betalningen inte bara blir omatchad medan kravhanteringen fortsätter.
- Två separata samtidighetsprov mäter filanspråket respektive två olika
  betalningar som möts före det verkliga mottagningslåset. I båda fallen finns
  exakt en bokförd betalning och ett tillgodo. Ett injicerat fel efter verklig
  tillgodoinsättning rullar tillbaka betalning, händelser, båda verifikaten,
  tillgodo och verifikationssekvens.
- Tolv relevanta vakter är gröna. Delbetalningsvakten läste först det nya
  slutargumentet `proof` som `allowPartial` och blev röd. Den läser nu den
  kontrollerade parameterpositionen och fäller även signaturglidning. Nya
  negativa självtest bevarar spärren mot bara booleans och körbara anrop i
  enkla och nästlade mallsträngar. Ingen baslinje lättas.
- En samlad körning av sju äldre regressioner och en mindre omkörning av två
  DB-regressioner nådde heapgränsen 1536 MB före testresultat. Dessa är inte
  godkända lokalt. Full typecheck, HTTP-/G2-samtidighet och de tyngre äldre
  regressionssviterna lämnas till CI på den nya committen.
- Den följande CI-körningen på **`ab52a440` är helt grön, 65 jobb**:
  [körning 38790046379](https://github.com/yasineken2002-sys/eken/actions/runs/38790046379).
  Det verifierar bankimportfasen före det nya utskicksflödet. Resultatet
  ersätter inte CI på de nu tillagda ändringarna.

Tidigare kärnverifiering, före bankkopplingen:

- 8 riktade bokförings-/aviseringssviter: **116/116 prov**, grönt.
- Tillgodo och historik, 3 sviter: **51/51 prov**, grönt. Där ingår 34
  tillgodoprov mot verklig PostgreSQL, 7 historikenhetsprov och 10 befintliga
  historikprov mot PostgreSQL. Inkluderar två
  samtidiga transaktioner, omkörning, felaktigt källunderlag, direkt försök att
  kringgå tjänstens saldokontroll, periodlås och kronologiska gränsfall.
- Efter bred CI: 6 ytterligare berörda regressionssviter, **56/56 prov**, grönt.
  De prövar organisationsinventariet i kontrolläge, append-only mot PostgreSQL,
  båda reverseringsordningarna, dev-raderingsordningen och GDPR:s bevarandegrind.
- Totalt **223 godkända riktade prov**, inte 223 oberoende kundbetalningar och inte
  ett mått på automatisk matchningsträffsäkerhet.
- 202 migrationer applicerade på separat syntetisk lokal databas. Schema
  validerat och egen Prisma-klient genererad; inga andra arbetskopior berörda.
- Kontrakts-, DTO-placerings-, koercions-, append-only-, aktörs- och kritiska
  indexvakter samt historikregister: gröna. Dagens koercionsvakt heter `check-strict-koercion.mjs`;
  det äldre filnamnet `check-strict-boolean.mjs` finns inte längre på main.
- Aktörsvakten gav ett falskt larm för historikens två `actorKind: true` i
  Prisma-`select`. Den skiljer nu direkta booleska fältval från tilldelningar.
  18 nya självtestfall bevarar spärren mot manuella skrivningar, även när
  `select` och `data` är nästlade eller förekommer i samma anrop. Inget
  produktionsfält döljs och inget undantag läggs till i en baslinje.
- Full API-typecheck slog i den satta heapgränsen 1536 MB. Ingen godkänd full
  typecheck påstås lokalt; CI måste verifiera hela projektet. Full typecheck och
  schema-drift blev gröna i CI på både `ec408e61` och `d4a0a9f8`. Den första
  körningens historikregisterlucka är rättad; den andra körningen bekräftar
  historikregistret. Senaste commit måste ha egen grön CI. De riktade
  Jest-körningarna använde ordinarie ts-jest med typkontroll.
- Första breda CI-körningen gav **578 gröna och 5 röda sviter**
  (8 421 gröna och 7 röda prov). Den hittade fyra saknade schema-/inventarie-
  kopplingar samt en äldre testattrapp utan den nya låsningen. Kopplingarna är
  nu rättade och de berörda proven gröna lokalt; detta ersätter inte en ny
  full CI-körning. **Hela CI blev därefter grön på `49398113`**, inklusive
  API-tester, typecheck, vakter och E2E:
  [körning 38783901673](https://github.com/yasineken2002-sys/eken/actions/runs/38783901673).
  API-sviten gav 584/584 sviter och 8 441/8 441 prov; separat tidszonskörning
  gav ytterligare 15/15 prov.
  Detta verifierar kärnan före bankimportkopplingen; den nya ändringen behöver
  egen CI. Ett lokalt lintanrop från repo-roten avbröts med SIGSEGV;
  samma berörda filer klarade ESLint seriellt från API-paketet med 1536 MB heap.

[Råa provloggar](eval/customer-credit-foundation/) sparas med utkastet.
`customer-credit-history.txt` är senaste historik-/DB-körningen;
`customer-credit-db.txt` bevarar den tidigare 33-fallsmätningen före historikkopplingen.
`actor-guard-selftest.txt` innehåller självtesterna för den rättade aktörsvakten.
`ci-integration-regression.txt` innehåller de 56 uppföljande regressionsproven.
`bank-import-tests.txt` och `bank-import-legacy-tests.txt` innehåller de 117
riktade proven från bankimportfasen; `bank-import-guards.txt` och
`partial-match-guard-selftest.txt` visar vakterna för bankkopplingen.
Inga riktiga mejl-, modell-, bank- eller produktionsanrop har gjorts.

Kör från repositoryts rot. Maskinen delas med andra arbeten och har två
kärnor. Före varje Jest- eller typecheck-körning:

```sh
pgrep -af "[j]est|[t]sc"
```

Vänta om ett annat sådant arbete pågår. Kör testerna med en arbetare. Om en
ny worktree saknar byggda workspacepaket eller genererad Prisma-klient behöver
`@eken/shared`, `@eken/ui` och Prisma-klienten förberedas först.

De två testerna utan databas:

```sh
pnpm --filter @eken/api exec jest --runInBand --runTestsByPath \
  src/accounting/accounting.customer-credit.spec.ts \
  src/avisering/avisering.customer-credit-display.spec.ts
```

Databastestet använder riktig lokal Postgres och ordinarie bokföring, men
skapar enbart syntetiska organisationer, avier och betalningar. Kärnans spec
bygger bankförutsättningen uttryckligen; `customer-credit-bank-import.db.spec.ts`
kör dessutom riktig CSV-import genom controllerns kontogräns och tjänstekedjan.
Testet behåller sina bokföringsbevis och stänger inte av append-only-skydd.

Sätt `DATABASE_URL` till en **separat syntetisk testdatabas** på
`127.0.0.1:56432`, med ett namn som börjar `eveno_bank2000_credit_` och enbart
små bokstäver, siffror eller understreck efter prefixet. Använd testdatabasens
egna inloggningsuppgifter; inga nycklar eller lösenord ska läggas i dokumentet.
`ALLOW_SYNTHETIC_BANK_WRITES=1` är en uttrycklig lokal testmarkering.

Följande kontroll körs före både migration och test och avbryter vid annan
databasmiljö:

```sh
(
  set -e
  : "${DATABASE_URL:?Sätt DATABASE_URL till den isolerade lokala testdatabasen}"
  export ALLOW_SYNTHETIC_BANK_WRITES=1
  node -e '
    const u = new URL(process.env.DATABASE_URL);
    if (u.protocol !== "postgresql:" || u.hostname !== "127.0.0.1" ||
        u.port !== "56432" || !/^\/eveno_bank2000_credit_[a-z0-9_]+$/.test(u.pathname) ||
        process.env.ALLOW_SYNTHETIC_BANK_WRITES !== "1") {
      throw new Error("Endast den uttryckligt isolerade lokala testdatabasen tillåts");
    }
  '
  pnpm --filter @eken/api exec prisma migrate deploy --schema prisma/schema.prisma
  pnpm --filter @eken/api exec jest --runInBand --runTestsByPath \
    src/customer-credit/customer-credit.db.spec.ts \
    src/reconciliation/customer-credit-bank-import.db.spec.ts \
    src/customer-credit/customer-credit-dispatch.db.spec.ts \
    src/avisering/customer-credit-send.db.spec.ts
)
```

Specen har dessutom en egen miljögrind. I CI tillåter den den befintliga
engångscontainern på `localhost:5432/eken_dev` endast när `GITHUB_ACTIONS=true`.
Utan godkänd testmiljö faller ett uttryckligt förutsättningsprov; överhoppade
databasfall får inte rapporteras som godkända.
