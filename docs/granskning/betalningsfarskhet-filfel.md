# CSV/Excel: filfel får inte förnya betalningsunderlagets datum

## Kontrakt före produktionsändring, 2026-09-13

Fast bas: `ed993decf799b6d0d32322471dc7ba4f1e526c38` (#891). Egen gren `codex/betalningsfarskhet-filfel`, PR-bas `codex/betalningsfarskhet-skydd`. Ingen merge, aktivering, historisk datumrättning eller produktionsövergång ingår.

En relevant datarad är en rad som dagens parser lämnar till importloopen: CSV:s icke-blankrader efter vald rubrik, respektive objekten från första Excel-bladets `sheet_to_json({ raw: false, defval: '' })`. Ingen ny filtrering eller tolkningsgrammatik införs. Datumet måste vara giltigt enligt befintlig parser och beloppet ändligt, även för uttag och nollbelopp.

Hela körningen avstår från att förnya `paymentDataThrough` om någon relevant rad saknar giltigt obligatoriskt datum/belopp eller en inbetalning inte når bekräftat ingestutfall. Det omfattar fel vid dubblettuppslag och lagring. En lyckad rad, oavsett datum eller ordning, får inte maskera en misslyckad. Redan sparade rader behålls; inga nya transaktioner som återställer hela filen införs. Återimport går genom befintlig dubblettmekanism.

Bekräftad dubblett eller returnerat utfall med sparad bankrad är godkänd inläsning. `matchError` efter lagring behåller befintlig policy och kan fortfarande tillåta datumuppdatering och krav trots omatchad betalning. Klassificeringen bygger på utfall, aldrig feltext eller `errors.length`. Normalt unmatched, giltiga uttag, nollbelopp och dubbletter behåller beteendet. Tomma filer och rubriker utan datarader ger inget datum. Tidigare datum backas eller nollställs aldrig. NULL/gammalt datum förblir pausat efter filfel; ett aktuellt tidigare datum behåller åldersregeln.

Befintlig radfelvisning ska förklara att betalningsunderlagets datum inte uppdaterades och att filen behöver rättas/importeras igen. Texten får inte påstå att allt är pausat. `parseFloat` accepterar numeriska prefix med skräp; ändlighetskontrollen är inte fullständig beloppsvalidering. Dagens datumtolkning, parserns radurval, kontotäckning och korrekt matchning bevisas inte av denna fix.

## Förebevis och planerad verifiering

F19 använder oförändrat underlag `Datum;Beskrivning;Belopp\n2026-09-13;Syntetisk felaktig rad;ogiltigt\n`. Säkerhetskravet prövas före ändring av produktion. Logg/JSON sparas lokalt i `.proof-filfel/f19-fore.*`.

Beteendeproven ska mäta faktisk import, lagrade bankrader, datum och verklig cron med DB-avgift/verifikat/event. CSV och verkliga små Excel-buffer går genom produktionsparsern. Övriga #891-prov behålls. Radantal för samtliga tabeller mäts före/efter egen fixturstädning. Ingen kunddata eller verklig köleverans används.

Föreprovet blev beteenderött: 0 bankrader, datum `2026-09-13`, faktisk avgift 60 kr, 1 event, 1 verifikat och 1 köanrop. Assertionen `through === null` föll efter verklig cron. Produktion var byteoförändrad mot fasta basen. 1 kört prov föll; 22 andra filtrerades bort. Samtliga 106 tabellers radantal återställdes efter städning (185 migrationsrader, 1 kundnummersekvens, 1 referensränta, övriga 103 tabeller tomma). Maskinläsbart förebevis: [betalningsfarskhet-filfel-fore.json](betalningsfarskhet-filfel-fore.json).

## Byggt och granskat

Produktionsändringen finns enbart i `importBankStatement`: hela körningen avstår från datumuppdatering vid radvaliderings- eller lagringsfel; `ingestionConfirmed` skiljer returnerat ingestutfall från tidigare fel. Felraden får en svensk förklaring i befintlig felvisning, utan extra påhittad felrad eller påstående om paus. Ingen parsergrammatik, OCR, dedup, matchning, avrundning, annan importkälla eller låsgräns ändras.

80 DB-prov omfattar 22 bevarade #891-fall och 58 filfelsfall (F19/F24–F34). F27 ger två observationer per format, totalt 60 filfelsobservationer. Markören `FILFEL_ASSERTIONS_OK` skrivs med fullständigt Jest-namn efter stegets assertions; båda F27-stegen och hela svitens slutstatus ska kontrolleras. F04:s feltext och cronriggens uttryckliga bankradantal är anpassade, säkerhetsfaciten bevarade.

Två oberoende granskare fann inga blockerande implementations-/provfynd. Produktionsgranskaren identifierade F27:s felaktiga förväntan om framtida datum; provet är rättat till befintlig begränsning till dagens datum. Provgranskaren bekräftade A–J, verklig dedup och bevarade äldre fall. Ett typfel i den nya riggens allokeringsräkning rättades också före slutkörningarna.

F27 injicerar ett verkligt PostgreSQL-fel före INSERT, avgränsat till egen organisation/rad, och tar bort trigger/funktion i `finally`. Det är inget COMMIT-felprov. F29 injicerar matchningsportens fel efter verklig lagring; samma text som lagringsfelet används, men ingen feltext styr spärren. Skuggkö och påminnelsekö är syntetiska portar utan utskick. Excel-proven använder verkliga XLSX-arbetsböcker och ett XLS-fall, men täcker inte alla cellformat. Återimportprovet intygar bankradernas identitet och antal; de är normalt omatchade och har inga avi-allokeringar. Det intygar inte korrekt matchning eller dubbelallokeringsfrihet i alla matchningsvägar.

## Mätta utfall

Samtliga datum/avgifter nedan kommer från faktisk import och verklig cron/DB. Avgift 60 betyder också 1 påminnelseevent, 1 avgiftsverifikat (1510 D / 3593 K) och 1 syntetiskt köanrop. Avgift 0 betyder inga sådana effekter. Frånsett F19:s sparade föreprov är tabellen eftermätningar; inga andra föreutfall har antagits.

| Fall | Importutfall | Bankrader efter | Datum efter | Faktisk avgift |
|---|---|---:|---|---:|
| F19 före, NULL + ogiltigt belopp | 0 importerade, 1 fel | 0 | 2026-09-13 | 60 kr |
| F19 efter, exakt samma CSV | 0 importerade, 1 förklarat radfel | 0 | NULL | 0 kr, paus |
| F24 blandat, fel först/sist och äldre/senare datum, CSV/XLSX | 1 importerad/unmatched, 1 radfel | 1 | NULL | 0 kr, paus |
| F25/F26/F34 felaktigt datum, saknat fält, icke-ändligt belopp, CSV/XLSX samt XLS | 0 importerade, 1 radfel | 0 | NULL | 0 kr, paus |
| F27 lagringsfel, CSV/XLSX | 1 importerad/unmatched, 1 avvisad INSERT | 1 | NULL | 0 kr, paus |
| F27 samma fil efter avhjälpt lagringsfel | 1 importerad/unmatched, 1 verklig dubblett, 0 fel | 2, första id oförändrat | 2026-09-13 (framtidsdatum begränsas som tidigare) | 60 kr |
| F28 enbart giltigt uttag / nollbelopp | 0 importerade, 0 fel | 0 | 2026-09-13 | 60 kr |
| F28 enbart redan lagrad dubblett | 0 importerade, 1 dubblett, 0 fel | 1, samma id | 2026-09-13 | 60 kr |
| F29 normalt unmatched | 1 importerad, unmatched=1, 0 fel | 1 | 2026-09-13 | 60 kr |
| F29 matchError efter lagring | 1 importerad, unmatched=0, 1 matchfel | 1, status UNMATCHED | 2026-09-13 | 60 kr, bevarad policy |
| F30 tom/rubrik/blankrader | Ingen datarad; CSV på 0 byte avvisas som tidigare | 0 | NULL | 0 kr, paus |
| F31 fel + tidigare NULL / 2026-09-01 | 0 importerade, 1 radfel | 0 | Oförändrat NULL / 2026-09-01 | 0 kr, paus |
| F31 fel + tidigare aktuellt 2026-09-10 | 0 importerade, 1 radfel | 0 | Oförändrat 2026-09-10 | 60 kr, dagens åldersregel |
| F32 `123skräp`, CSV/XLSX | 1 importerad/unmatched, belopp 123, 0 fel | 1 | 2026-09-13 | 60 kr, kvarvarande parsergräns |
| F33 giltig äldre fil + aktuellt datum | Uttag, 0 fel | 0 | Oförändrat 2026-09-13 | 60 kr |

## Negativkontroll och bevisgränser

Implementationscommit `7f87ade0e38e46347f186d78141db54fb5823dbe` sparades före negativkontrollen. Endast `if (fileReadComplete)` gjordes till ett alltid sant villkor. F19 föll på `through === null` med faktiskt datum 2026-09-13 och avgift 60 kr (1 event/verifikat/köanrop). Exakt fil återställdes från committen, SHA-256 `9373ffdf759ffd08ab174e4beb22432de4ab09a6c2363312a94e49fcdb0c59d8`, och Gitdiffen var tom före de två fullständiga slutkörningarna. Negativkörningen innehöll 1 kört rött prov och 79 bortfiltrerade, inte en full svit.

Den nya spärren skyddar filkörningens underlag enligt dagens parser. Den intygar inte bankens eller filens fullständighet, alla konton/blad/rader, strikt belopps-/datumgrammatik, korrekt matchning eller korrekt allokering. Numeriska prefix, matchError efter lagring och ett tidigare aktuellt datum kan fortsatt släppa krav. #891:s F15 är portfel, F22 manuell tjänsteväg och F23 låsportens räckvidd; deras tidigare bevisgränser består. Ingen ny verksamhetspolicy, migration eller historisk datumrättning införs. Gamla/nya producenter och workers måste avskärmas vid ett separat beslutat införande.

## Lokala slutkörningar och diff

Efter exakt återställning: **80/80 DB-prov två gånger**, inga hoppade. Båda JSON-rapporterna har alla 80 assertionresultat `passed`; loggarna har 60 filfelsobservationer och 58 distinkta fullständiga testnamn. Körningarna städade egna fixturer: 106 tabeller med identiska före/efter-antal, `_prisma_migrations=185`, `CustomerNumberSequence=1`, `ReferenceInterestRate=1`, övriga 103 tabeller noll. Detta är 187 befintliga rader per mätt ögonblick, inte antalet skapade fixturrader under körningen. Egna feltriggers/funktioner efteråt: 0/0.

Den egna PostgreSQL-containern `eveno-farskhet-filfel-20260913`, etikett `eveno.task=betalningsfarskhet-filfel`, använde endast syntetisk databas `eveno_farskhet_test` på `127.0.0.1:55440`. Den är stoppad med volymen bevarad. DB-URL-säkerhetskontrollen är kvar. Grenens 185 befintliga migrationer applicerades i den tomma egna databasen; ingen ny migration skapades. Inga kunddatabaser användes.

Riktade regressionsprov: **12 sviter, 129/129 prov**, inklusive importgräns, färskhetstjänst, ingest/dedup, OCR, API och PDF. Riktad lint är grön. Lokala tredjeparter lånades från befintlig cache utan installation eller generering; egen Prisma-klient och shared/ui användes. CI måste köra grenens frysta låsfil och hela sviten för leveransens exakta HEAD.

Lokala råbevis finns i worktreens ignorerade `.proof-filfel/`: `f19-fore.*`, `f19-negativ.*`, `negativ.diff`, `db-slut-1.*`, `db-slut-2.*`, `unit.*`, `lint.log`, `typecheck.log`, `migrations.log`, `db-identitet.txt` och `db-triggerstadning.txt`. Förebevisets observation och alla före/efter-radantal finns även i den versionshanterade JSON-filen ovan.

Fetch bekräftade PR-basen `origin/codex/betalningsfarskhet-skydd = ed993decf799b6d0d32322471dc7ba4f1e526c38`. `origin/main` och dess merge-base är `3b71e905d866f461f6b07211bc89b3fa88505200`. Egna ändringar omfattar **5 filer** mot både fasta basen och PR-basen: importtjänsten, DB-provet, denna rapport, förebevisets JSON och `revision-status.md`. Mot main omfattar diffen **37 filer**: #891:s 35 ärvda filer, varav 3 får ovanstående egna ändringar, plus 2 nya dokument. De övriga 32 ärvda filerna är byteoförändrade; dit hör de två ursprungliga reproduktionsunderlagen. Ingen främmande ändring ingår.

API-typkontrollen är grön. Pinnad radräkning (`git diff --numstat`, tillagda + borttagna rader, inga binärer) mot `ed993dec` och fjärr-PR-basen: **34 produktion (23+/11−), 377 test (367+/10−), 321 dokumentation (320+/1−)**. Samma beräkning mot merge-base med main: **328 produktion (266+/62−), 2248 test (2214+/34−), 1312 dokumentation (1312+/0−)**. Egna rader får inte blandas ihop med denna större ärvda diff. Slutlig HEAD, PR och full CI verifieras i leveranskvittot; lokala gröna prov är inte i sig grön CI.
