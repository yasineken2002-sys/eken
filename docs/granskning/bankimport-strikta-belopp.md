# Strikt beloppstolkning vid CSV/Excel-import

## Kontrakt före produktionsändring, 2026-09-13

Fast bas och verifierad fjärr-PR-bas: `39084309279b5bb300b7a783652777fd88f62fdd` (#892), gren `codex/betalningsfarskhet-filfel`. Egen gren `codex/bankimport-strikta-belopp`. #891/#892 lämnas orörda. Ingen merge, deploy, aktivering, migration, ny inställning eller historisk rättning ingår.

Inventering: `reconciliation.service.ts` har fyra anrop till `parseAmount`: CSV-belopp/saldo (562/564 på basen) och Excel-belopp/saldo (615/617). Den separata `ImportService.parseAmount` gäller andra importer och ändras inte. BgMax/PDF/PSD2 använder inte denna hjälpare. Befintlig dokumentation är kodkommentaren om `1 234,56` och `-1 234,56`; OCR-proven har `8000,00`, DB-proven heltal/uttag/noll/Infinity/overflow/prefix, och bank-E2E skapar syntetiska decimalpunktsvärden med `toFixed(2)`. Inga fysiska CSV/XLSX/XLS-fixturer under `apps` hittades. Detta är kod- och syntetiskt provstöd, **inte verifierade exportformat från verkliga banker**.

Hela trimmade token ska följa: valfritt ASCII-tecken +/−, heltal eller decimal med en punkt/komma, samt valfri komplett e/E-exponent med valfritt tecken och minst en siffra. `.5`, `,5`, `1.` och `1,` stöds uttryckligen liksom grupperad mantissa. Tusental kräver 1–3 siffror i första gruppen och exakt 3 i varje efterföljande grupp; vanligt blanksteg, NBSP och smalt NBSP får användas/blandas mellan grupper. Övrig inre whitespace avvisas. Struktur valideras före normalisering. Omgivande whitespace enligt befintlig trim tillåts; CSV:s fysiska radgränser förblir radgränser. En ensam punkt/komma är decimaltecken, aldrig ny tusentalsheuristik; blandade punkt-/kommaseparatorer avvisas.

CSV använder originalcellen för numeriska fält och tar av citattecken endast om båda omsluter hela cellen. Ensidig quote-strip får inte göra första biten av ett citerat flerradsbelopp till ett giltigt tal. Datum, andra fält och fysiskt radurval ändras inte. Detta inför inte fullständigt stöd för CSV:s citerade avgränsare eller flerradsfält.

Numeriska Excelceller läses från råvärdet endast för belopp/saldo. En andra `sheet_to_json` med `raw:true` mappas till befintliga rader via `__rowNum__`; endast `typeof number` under de redan valda belopps-/saldonycklarna används. Den befintliga `raw:false`-projektionen väljer fortfarande datum, text, referens, radurval och första blad. Textceller följer samma strikta talgrammatik som CSV. Ingen global lägesändring eller koordinatgissning från `Object.keys` görs.

Obligatoriskt belopp: ogiltig syntax eller icke-ändligt resultat avvisas av #892:s filfelsspärr. Sparade giltiga rader behålls, inget nytt datum från en ofullständig körning, riktig dedup vid rättad återimport. Uttag/noll/unmatched och tidigare datum behåller sina regler. Ett tidigare aktuellt datum kan fortsatt tillåta krav.

Valfritt saldo: frånvaro/tomhet och avvisad vanlig text utelämnas, inte ett automatiskt obligatoriskt radfel. Ett finit prefix som `123skräp` får aldrig bli saldo 123. **Kompatibilitetsspärr:** om gamla tolkningen hade lämnat ett icke-ändligt saldo (även `1e309skräp`, `Infinityskräp`, felgrupperat overflow eller ensidigt citerad CSV-cell) behålls detta till samma befintliga lagringsgräns. Gamla tolkningen får endast identifiera detta blockerande utfall, aldrig leverera ett accepterat finit värde. Därmed blir tidigare nekad inbetalningslagring inte tyst utelämnat saldo, och dubblett-/uttags-/nollvägar som inte nådde lagringen ändras inte genom en ny obligatorisk saldoregel.

Number, `toFixed(2)` och databasens `Decimal(12,2)` bevaras. Ingen ny affärsgräns eller Decimal-omskrivning görs. Underflow till noll, positiva små tal som lagras som 0,00 och binär avrundning kvarstår och mäts. Belopp över lagringsprecisionen nekas på befintlig lagringsväg; detta är inte fullständig matematisk decimalprecision.

## Acceptansmatris före produktion

Varje rad är syntetiskt underlag för CSV och textceller i riktiga XLSX/XLS. Kolumnen ”dagens tal” mäts med basens oförändrade `parseAmount` extraherad ur faktisk TypeScript-källa; det är en funktionsmätning, inte ett DB-bevis för varje rad. Slutproven ska köra samtliga rader genom verklig import och kontrollera explicita lagringsfacit. ”Ingen rad” betyder giltigt uttag/noll enligt befintlig regel; ”avvisas” betyder rad-/lagringsfel och inget nytt datum. Avsedda värden/facit är fasta och beräknas inte med produktionsparsern.

| Indata (JSON-escaped), CSV/Excel-text | Avsett värde | Dagens tal | Önskat lagringsutfall | Skäl |
|---|---|---|---|---|
| `"123"` | 123 | 123 | 123.00 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"0"` | 0 | 0 | Ingen bankrad; giltigt uttag/noll | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"+123"` | 123 | 123 | 123.00 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"-123"` | -123 | -123 | Ingen bankrad; giltigt uttag/noll | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"123,45"` | 123,45 | 123.45 | 123.45 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"123.45"` | 123,45 | 123.45 | 123.45 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1 234,56"` | 1234,56 | 1234.56 | 1234.56 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1\u00a0234,56"` | 1234,56 | 1234.56 | 1234.56 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1\u202f234.56"` | 1234,56 | 1234.56 | 1234.56 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1 234 567,89"` | 1234567,89 | 1234567.89 | 1234567.89 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1 234\u00a0567,89"` | 1234567,89 | 1234567.89 | 1234567.89 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"\t +1 234,56\u00a0 "` | 1234,56 | 1234.56 | 1234.56 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `".5"` | 0,5 | 0.5 | 0.50 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `",5"` | 0,5 | 0.5 | 0.50 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1."` | 1 | 1 | 1.00 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1,"` | 1 | 1 | 1.00 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1e2"` | 100 | 100 | 100.00 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1,25e+2"` | 125 | 125 | 125.00 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"-1E2"` | -100 | -100 | Ingen bankrad; giltigt uttag/noll | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1 234e-1"` | 123,4 | 123.4 | 123.40 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1,234"` | 1,234, inte tusentalsgissning | 1.234 | 1.23 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1.234"` | 1,234, inte tusentalsgissning | 1.234 | 1.23 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1.005"` | 1,005 → befintligt toFixed(2): 1,00 | 1.005 | 1.00 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"2.675"` | 2,675 → befintligt toFixed(2): 2,67 | 2.675 | 2.67 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"0.001"` | 0,001 → befintligt lagrat 0,00 | 0.001 | 0.00 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"1e-999"` | 1e-999 → Number 0, befintlig nollväg | 0 | Ingen bankrad; giltigt uttag/noll | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"3e-324"` | 3e-324 → Number 5e-324 → lagrat 0,00 | 5e-324 | 0.00 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"9999999999.99"` | 9999999999,99 | 9999999999.99 | 9999999999.99 | Hela token följer beslutad syntax; befintlig avrundning/lagring behålls. |
| `"123skr\u00e4p"` | Ingen entydig tillåten tolkning | 123 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"123kr"` | Ingen entydig tillåten tolkning | 123 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"123abc456"` | Ingen entydig tillåten tolkning | 123 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1e"` | Ingen entydig tillåten tolkning | 1 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1e+"` | Ingen entydig tillåten tolkning | 1 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1e-"` | Ingen entydig tillåten tolkning | 1 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1e2skr\u00e4p"` | Ingen entydig tillåten tolkning | 100 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1 2 3"` | Ingen entydig tillåten tolkning | 123 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"12 34"` | Ingen entydig tillåten tolkning | 1234 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1234 567"` | Ingen entydig tillåten tolkning | 1234567 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1 2345"` | Ingen entydig tillåten tolkning | 12345 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1\t234"` | Ingen entydig tillåten tolkning | 1234 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1\r234"` | Ingen entydig tillåten tolkning | 1234 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1,2,3"` | Ingen entydig tillåten tolkning | 1.2 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1.2.3"` | Ingen entydig tillåten tolkning | 1.2 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1,234.56"` | Ingen entydig tillåten tolkning | 1.234 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1.234,56"` | Ingen entydig tillåten tolkning | 1.234 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1-23"` | Ingen entydig tillåten tolkning | 1 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"+ 123"` | Ingen entydig tillåten tolkning | 123 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"--1"` | Ingen entydig tillåten tolkning | NaN | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"0x10"` | Ingen entydig tillåten tolkning | 0 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"0b10"` | Ingen entydig tillåten tolkning | 0 | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"NaN"` | Ingen entydig tillåten tolkning | NaN | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"Infinity"` | Ingen entydig tillåten tolkning | Infinity | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"-Infinity"` | Ingen entydig tillåten tolkning | -Infinity | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"1e309"` | Ingen entydig tillåten tolkning | Infinity | Avvisas | Inte en hel numerisk token med giltig gruppering. |
| `"10000000000"` | 10000000000 | 10000000000 | Avvisas | Hel numerisk syntax; befintlig Decimal(12,2)-lagring nekar, ingen ny affärsgräns. |
| `"9 999 999 999,995"` | 9999999999,995 → 10000000000,00 | 9999999999.995 | Avvisas | Hel numerisk syntax; befintlig Decimal(12,2)-lagring nekar, ingen ny affärsgräns. |
| `"9007199254740993"` | 9007199254740993 → Number 9007199254740992 | 9007199254740992 | Avvisas | Hel numerisk syntax; befintlig Decimal(12,2)-lagring nekar, ingen ny affärsgräns. |

## Excel: uppmätt visning och avsett cellvärde

Riktiga små XLSX/XLS har skrivits/lästs med grenens befintliga SheetJS 0.18.5. Samma resultat i båda formaten:

| Rått numeriskt värde | Talformat | `raw:false` | Basens parsade tal | Önskat lagrat tal |
|---:|---|---|---:|---:|
| 1234.56 | `#,##0.00` | `1,234.56` | 1.234 | 1234.56 |
| 4321.99 | `#,##0` | `4,322` | 4.322 | 4321.99 |
| 0.01234 | `0%` | `1%` | 1 | 0.01 |
| 1234.56 | `0.00E+00` | `1.23E+03` | 1230 | 1234.56 |
| 1.005 | `0.00` | `1.00` | 1 | 1.00, befintlig avrundning |

En textcell `1,234.56` ska däremot avvisas som tvetydigt blandade separatorer. Cellens faktiska typ och värde avgör; visningstext är inte facit.

## Förebevis och provplan

F32 körs med exakt #892:s CSV: `Datum;Beskrivning;Belopp\n2026-09-13;Syntetisk prefixrad;123skräp\n`. Faktiska rader och cron observeras före säkerhetsassertionerna. Det lilla textbeviset sparas i `bankimport-strikta-belopp-fore.txt`; råloggar/JSON finns i worktreens ignorerade `.proof-belopp/`.

Alla matrisfall, riktiga numeriska/textceller, saldo, blandat/rättad återimport, NULL/gammalt/aktuellt datum och bärande cron-effekter ska provas med egna DB-fixturer. F32:s båda format är avsiktligt ändrade från nulägesbeskrivning till säkerhetskrav; övriga 78 #892-faciten behålls. Två fullständiga DB-slutkörningar, sparad commit före negativkontroll, exakt återställning, två separata granskare och full CI för slutlig HEAD krävs före leverans.

## Förtydligande efter oberoende granskning, före saldokorrigering

Provgranskaren fann att kompatibilitetsspärren även behöver omfatta ett tidigare finit prefix som överskrider **befintlig** `BankTransaction.balance @db.Decimal(12,2)` efter befintlig `toFixed(2)`, exempelvis `10000000000skräp` eller `9999999999.995skräp`. Sådana värden nekades vid lagring; de får inte bli tyst utelämnat saldo som frigör datum. Samma gäller negativa värden och felgrupperade stora prefix. Gränsen är schemats existerande lagringsprecision, inte en ny affärsmässig beloppsgräns. Kompatibilitetsvägen ska endast bevara dessa tidigare blockerande värden till samma lagringsgräns; ett finit prefix **inom** lagringsomfånget ska fortfarande utelämnas. B11 mäter regressionen före rättelsen och därefter det bevarade säkra utfallet i alla tre format. B02/B12 kompletterar med rena och råa numeriska Excel-saldon över DB-gränsen.

Excel-mappningsprovets första fixtur hade av misstag `!ref=A1:H6` trots avsett startläge C3. Det gjorde en blank rad till rubrik och gav datumfel. Fixturen rättas till uttryckligt `C3:H6`; samma datum-/rad-/beloppsfacit behålls, ingen produktionsändring behövs för det felet.

En kvarvarande historikgräns är särskilt viktig inför införandet: belopp ingår i befintlig dedup. Om äldre kod redan sparat en formaterad numerisk Excelcell med fel belopp (t.ex. 1234,56 som 1,23), kan en senare import med korrekt råvärde skapa en ny bankrad. Återimportproven bevisar korrekt sparad rad plus tidigare avvisad rad inom det nya beteendet, inte dedup mot historiskt feltolkade rader. Ingen historisk omtolkning, rättning eller migrering ingår.

## Granskad implementation

Efter rättelserna passerar 368/368 DB-prov: 78 bevarade #892-fall, 2 ändrade F32-säkerhetsfall och 288 nya B-fall. B-markörerna har 291 observationer eftersom återimporten har två steg i varje format. Fasta facit verifierar exakt lagrat belopp/saldo, importerade rader, datum och riktig cron/DB-effekt. Denna körning är före negativkontroll och ersätter inte de två beställda slutkörningarna.

Två separata granskare har avslutat utan kvarstående blockerande fynd. Provgranskarens finita saldooverflow-fynd reproducerades med 15 röda fall och rättades; produktionsgranskaren återgranskade utökningen. Slutgranskad produktionsfil SHA-256: `8496b96e728b370d068a14f9c62c4da0c32c7cfd63f0495a5ed9c6eddec7ef2d`. Kontraktet kräver varken ny verksamhetspolicy eller bred parserombyggnad.


## Slutbevis efter exakt återställning

Implementation sparades som `d2313e52d113fc85dc10285866b7dca9b8639f5d` före negativkontrollen. Endast gamla `parseAmount` återinfördes tillfälligt. Båda F32-fallen (CSV/XLSX) blev röda på faktisk bankrad 123,00, datum 2026-09-13 och avgift 60 kr med 1 kravhändelse, 1 verifikation och 1 syntetiskt köanrop. Felet var `toHaveLength(0)` efter observerad riktig cron-effekt. Hela produktionsfilen återställdes från committen; SHA-256 ovan matchade exakt och Git-diff var tom.

| Verifiering | Godkända prov | Hoppade prov | Namngivna nya B-fall / observationer | Tabeller före/efter städning |
|---|---:|---:|---:|---|
| `db-slut-1` | 368/368 | 0 | 288 / 291 | 106, alla radantal identiska |
| `db-slut-2` | 368/368 | 0 | 288 / 291 | 106, alla radantal identiska |

Varje körnings faktiska baslinje och slutläge: `_prisma_migrations=185`, `CustomerNumberSequence=1`, `ReferenceInterestRate=1`, övriga 103 tabeller noll. Totalt 187 rader före och efter; detta är **inte** antalet skapade fixturer. Egna organisations- och räntefixturer städas av sviten. Lika antal bevisar antalsstädning, inte identiskt innehåll i äldre rader. De 60 ärvda `FILFEL_ASSERTIONS_OK`-observationerna finns i båda loggarna; F32:s två förväntningar är avsiktligt skärpta, övriga 78 äldre provfacit bevarade.

Egen PostgreSQL: `eveno-strikta-belopp-20260913`, etikett `eveno.task=bankimport-strikta-belopp`, port 55441, databas `eveno_farskhet_test`. 185 befintliga migrationer applicerades på egen tom volym; ingen ny migration. Säkerhetskontrollen för databasadress är oförändrad. Alla data och kö-/mejlportar är syntetiska; inga externa AI-anrop eller utskick görs. Lokala loggar och Jest-JSON ligger i worktreens ignorerade `.proof-belopp/`.

## Uppmätta import-, datum- och kravutfall

Datum i tabellen avser `paymentDataThrough`; provklockan är 2026-09-13. Avgift 60 innebär också en faktisk kravhändelse och en verifikation (1510 debet 60 / 3593 kredit 60) samt ett syntetiskt köanrop. Avgift 0 i de pausade fallen har noll av dessa sidoeffekter. Sparade bankrader i de nya beloppsfallen är normalt `UNMATCHED`.

| Fall | Importerade / fel / dubbletter | Exakt lagrat belopp; saldo | Datum | Faktisk avgift |
|---|---|---|---|---:|
| F32 före, samma CSV `123skräp` | 1 / 0 / 0 | 123.00; NULL | 2026-09-13 | 60 |
| F32 efter, CSV/XLSX; B01 även XLS | 0 / 1 / 0 | Ingen bankrad | NULL | 0 |
| Giltig 100,50 + felaktig rad, alla tre format | 1 / 1 / 0 | 100.50; NULL | NULL | 0 |
| Rättad återimport av samma fil | 1 / 0 / 1 | 100.50 och 123.45; NULL | 2026-09-13 | 60 |
| Prefixfel först + giltig 100, tidigare NULL | 1 / 1 / 0 | 100.00; NULL | NULL | 0 |
| Samma, tidigare gammalt datum | 1 / 1 / 0 | 100.00; NULL | 2026-09-01 oförändrat | 0 |
| Samma, tidigare aktuellt datum | 1 / 1 / 0 | 100.00; NULL | 2026-09-10 oförändrat | 60 |
| Belopp 100, saldo `123skräp`, före | 1 / 0 / 0 | 100.00; 123.00 | 2026-09-13 | 60 |
| Samma, efter | 1 / 0 / 0 | 100.00; NULL | 2026-09-13 | 60 |
| Belopp 100, saknat/tomt/vanligt ogiltigt saldo | 1 / 0 / 0 | 100.00; NULL | 2026-09-13 | 60 |
| Belopp 100, saldo Infinity / exponentoverflow | 0 / 1 / 0 | Ingen bankrad | NULL | 0 |
| Belopp 100, saldo med för stort finit prefix, efter granskningens rättelse | 0 / 1 / 0 | Ingen bankrad | NULL | 0 |
| XLSX/XLS numeriska celler 1234,56 / 4321,99 med tusentals-/heltalsvisning, före | 1 / 0 / 0 | 1.23; 4.32 | 2026-09-13 | 60 |
| Samma cellvärden och format, efter | 1 / 0 / 0 | 1234.56; 4321.99 | 2026-09-13 | 60 |

Återimporten använder produktionsvägens verkliga dubblettkontroll; första bankradens ID är uttryckligen oförändrat och slutantalet är två. B05 bevarar uttag/noll/dubblett även med saldo som inte når lagringsvägen. B06–B12 prövar råa numeriska celler, textceller, blad/radmappning, citat och tidigare saldofel. Matrisens explicita facit kontrolleras genom import i alla tre format, inte genom att beräkna facit med parsern.

Detta löser F32:s prefixfel och visningstextens feltolkning av numeriska Excelbelopp inom angivet område. Befintlig datumparser, ofullständig CSV-grammatik, Number-precision/underflow/avrundning och matchError-policy efter lagrad bankrad kvarstår. Lagrad bankdata bevisar inte korrekt matchning eller fullständig konto-/banktäckning. Ett fortfarande aktuellt tidigare datum är inte pausat av varje filfel. Historiskt felaktiga Excelbelopp kan få annan dedupidentitet vid korrekt råtolkning; dessa prov och denna PR rättar inte historiken. F15:s portfel, F22:s manuella tjänsteväg och F23:s låsräckvidd från #891 får inte beskrivas som verkligt commitfel, HTTP-behörighetsprov eller generell parallell bokföringskapacitet. Införande och avskärmning av gamla producenter/workers kräver separat beslut.


## Lokal kontroll och avgränsad diff före push

Riktade regressionsprov: 12 sviter, 129/129 godkända (färskhet, importgräns, ingest, OCR, dubbletter, matchError/unmatched och PDF-gränser). Riktad ESLint för produktionsfil och DB-spec är grön. Disk och `pgrep -af "[j]est|[t]sc"` samt `live/farskhet-tunga-processer.py` kontrollerades före tung körning; en tung process åt gången. Cirka 3,4 GiB ledigt, ingen ytterligare diskstädning. API-typkontroll (`tsc --noEmit -p tsconfig.typecheck.json`) är grön. Full svit och exakt slutlig HEAD ska verifieras i CI; lokala prov är inte CI-bevis.

Egna lokala tredjepartsberoenden lånar befintlig cache; Prisma-klient och shared/ui är egna kopior. Ingen installation eller generering muterade cachegivarens arbetsyta. CI ska installera från grenens frysta låsfil. Den egna testcontainern är stoppad med volymen bevarad; noll `filfel_`-triggers/funktioner återstod efter provstädningen.

Efter fetch är fast bas och aktuell PR-bas identiska: `39084309279b5bb300b7a783652777fd88f62fdd`. Merge-base med `origin/main` är `3b71e905d866f461f6b07211bc89b3fa88505200`. Inga främmande ändringar finns i den egna diffen. #891 och #892 är oförändrade. PR ska vara utkast mot `codex/betalningsfarskhet-filfel`; ingen merge, deploy, aktivering eller framåtpropagering.

Egna fem filer:

- `apps/api/src/reconciliation/reconciliation.service.ts`
- `apps/api/src/payment-freshness/import-reminder-reproduction.db.spec.ts`
- `docs/granskning/bankimport-strikta-belopp.md`
- `docs/granskning/bankimport-strikta-belopp-fore.txt`
- `docs/revision-status.md`

Mot main är det 39 filer: dessa fem och 34 enbart ärvda, byte-oförändrade mot #892. Basen hade 37 filer mot main; tre av dem vidareändras här och två dokument tillkommer. Ärvt område: #889:s två reproduktionsunderlag, #891:s schema/migration, färskhetstjänst och import-/effektgränser, webbtext och äldre prov samt #892:s filfelsspärr och rapporter. Ärvd migration är ingen ny migration i denna PR.

Radräkning använder `git diff --numstat`, tillägg plus borttagningar; kategorierna bestäms av de fem ovan angivna filernas roll. Testfacit och textförebevis räknas som test respektive dokumentation. Ingen binär diff. Exakta tal för fast/aktuell bas och merge-base med main står i följande kvitto.

Fast bas = aktuell PR-bas: **5 filer, +843/−24**; produktion **98** berörda rader (+81/−17), test **568** (+562/−6), dokumentation **201**. Merge-base med main: **39 filer, +4628/−113** inklusive ärvt. Noll binärer.
