# Kundtillgodo – produktkärna och bankmottagning

Arbetet utgår från `main` på `9c17daec`, i grenen
`codex/agent2-kundtillgodo`. Tjänsten är registrerad i bankimportens modul,
bakom en organisationspolicy som är **avstängd som standard**. Ingen policy
aktiveras av migrationerna och inget nytt aktiverings-API införs. Historiska
bankallokeringar ändras inte.

Den här etappen innehåller datamodell, transaktionell mottagning och användning
av tillgodo, bokföringsmetoder, presentation på avin och en snäv bankimportväg
för mottagning. Automatisk användning på nästa avi är ännu inte inkopplad.
Etappen innehåller inga
nya matchningsprocent och ingen ny körning av 2 000 betalningar. Experimentet i
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

En defensiv återläsning stoppar utskicket om tillgodosumman ändrats under
PDF-renderingen; befintlig retry renderar då om. Den är **inte en atomisk
utskicksreservation**. Intervallet mellan återläsning och mejlkö måste stängas
innan automatisk användning vid avisering.

Mottagning och användning ingår även i hyresgästens befintliga historik,
med ursprunglig tidpunkt, belopp, aktörsslag och pekare till respektive
oföränderlig rad. Både organisation och hyresgäst avgränsar läsningen.

Kundtillgodo ingår i den befintliga spärren mot hårdradering av en hyresgäst;
beskedet hänvisar till avidentifiering. Dev-verktygets uttryckliga helradering
har uppdaterad FK-ordning för de nya tabellerna. Det ändrar inte produktens
bevarandepolicy och verktyget har inte körts för att radera tillgodounderlaget.

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

1. En atomisk utskicksreservation måste samordna tillgodo, rendering, mejlkö
   och avins status. Helt täckta avier behöver ett uttryckligt dokument- och
   leveransflöde; att sätta `PAID` är inte ett bevis på att hyresgästen fått
   information.
2. Annulleringsrace och avmatchning behöver en sammanhängande rättelse av
   bankallokering, tillgodoreskontra och verifikat. Främmande nycklar och
   rättelsespärrar hindrar vissa osammanhängande ingrepp, men ersätter inte
   denna kundväg.
3. Återbetalning saknar en riktig bankbevisport och en komplett domänlivscykel
   med reservation, bekräftelse och avvisad utbetalning. En bokföringsmetod
   eller ett manuellt besked är inte bevis på att pengar har betalats ut.
4. Revisor behöver uttryckligen välja skuldkontot och bekräfta kopplingen
   mellan bankkontot och bokföringens `1930`. Testkonton är inga godkända
   standardval och depositionskontot används inte som automatisk ersättning.
5. Fortnox-stödet för de nya `customer-credit-*`-källorna och deras
   kontomappning återstår. Ett lokalt balanserat verifikat bevisar inte att
   exporten stöder källan.
6. PSD2 behöver verifierad kontokoppling och aktörskontext. En referensväg
   som bara täcker uttryckliga AVI-nummer bevisar inte målet för alla bankformat.
7. Hela CI och Claudes granskning krävs före merge. Detta är ett utkast och
   aktiverar inte automatisk tillgodo eller ett komplett kundflöde.

## Avgränsad verifiering

Mätt lokalt 2026-10-15, Node 24.19.0 / Prisma 5.22.0 / PostgreSQL 16.15:

Bankimportuppföljningen:

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
senaste riktade proven; `bank-import-guards.txt` och
`partial-match-guard-selftest.txt` visar vakterna för bankkopplingen.
Inga modell-, bank- eller produktionsanrop har gjorts.

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
    src/reconciliation/customer-credit-bank-import.db.spec.ts
)
```

Specen har dessutom en egen miljögrind. I CI tillåter den den befintliga
engångscontainern på `localhost:5432/eken_dev` endast när `GITHUB_ACTIONS=true`.
Utan godkänd testmiljö faller ett uttryckligt förutsättningsprov; överhoppade
databasfall får inte rapporteras som godkända.
