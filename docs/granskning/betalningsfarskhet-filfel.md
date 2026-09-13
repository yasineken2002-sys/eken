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
