# Datumrymden för avläsningsgranskningen

## Mätning före nytt designval

Basen är 9295e013303c4de21f8eb947e3812e05d6f693e3. Första #888-fixen är 8c6f850111b7e378d653ee781abd7e6071f3e32c. Båda analysfilerna är byteidentiska, hashkontrollerade testfixturer; deras resultat hålls isär från den aktuella kandidatens.

ReadingForm.tsx:228–247 har tre redigerbara date-fält utan min/max. CreateReadingSchema, packages/shared/src/schemas/index.ts:1151–1168, kräver datum och slut >= start. Den kräver varken start den första, slut i samma månad, eller att readingDate ligger i perioden. MeterReading.periodStart/periodEnd är @db.Date (schema.prisma:6173–6174). Ingen lagring eller backendacceptans har körts i denna mätning.

Matrisen korsar samtliga 3 startformer × 4 slutformer × 3 avstånd × 2 typer × 3 kalender-/idag-kontexter: **216 axelkombinationer, 150 unika typ+periodserier**. Detta är ändliga ekvivalensklasser, inte ett påstående om att alla kalenderdatum är uttömda. Start=first/15:e/last; end=today/last/same/next månads 10:e. Successive använder efterföljande månader; skip-month hoppar över en månad inför sista observationen; same-month upprepar föregående månad med samma slutdatum. Två extra fall prövar skilda slutdatum inom samma månad, två prövar readingDate både före och efter perioden.

jan20 börjar januari 2026 med idag den 20:e; jan02 med idag den 2:a; nov28 börjar november 2027 med idag den 28:e och passerar årsskifte/skottår. Varje rad visar perioderna explicit. CUMULATIVE har fem observationer för fyra differenser; PERIOD_VOLUME fyra periodvolymer. Tre dagsmedel är 10, sista är 270 när en giltig differens/period finns. Duplicerade periodslut har ingen väldefinierad sista differens och klassas strukturellt, inte som ett missat 27×-hopp.

Alla datum och värden passerar riktiga fält, resolver, submit och handleClean. Fyra läshooks ersätts med syntetiska uppgifter; UI och schema är verkliga. Identiska formulärinmatningar återanvänder ett verifierat kvitto. Första mätningen gav 425 unika formulärsubmit, 220 observationer (216 + 4 extra) och 221 gröna instrumentprov.

Kanarien kördes FÖRST separat: verkliga dagliga serier gav exakt trendAssessed=1 och HIGH_RATE på sista raden för båda typerna och alla tre laddade versionerna. Ett instrument som alltid lämnar noll fälls. Den fullständiga matrisen startar först efter dessa kontroller. Rapportskrivningen har därefter förstärkts med exakt ID-mängd: partiell/duplicerad mätning får inte kallas fullständig.

| Utfall, 216 kombinationer | Före #888 | Första #888-fixen |
| --- | ---: | ---: |
| Formuläret avvisar minst en rad | 24 | 24 |
| Strukturella överlappningsfynd | 76 | 76 |
| HIGH_RATE | 6 | 67 |
| Tyst: inga fynd och ingen trendbedömning | 110 | 49 |

Per typ finns 58 accepterade, icke överlappande serier. Första fixen bedömer alla 58 CUMULATIVE men bara 9 PERIOD_VOLUME; 49 periodvolymserier förblir helt tysta. Start den 15:e samt sista dagen→nästa månads 10:e reproducerar tystnaden med 27× dagsmedel.

## Designbeslut med mätningen som underlag

Kalenderundantaget tas bort. PERIOD_VOLUME normaliseras som volym / inklusive kalenderdagar i just den registrerade perioden. Mellanrummet ingår inte i täljaren eller nämnaren. Det finns därför ingen matematisk grund för att godkänna den första men avvisa den femtonde. Luckor bryter inte trendjämförelsen för någon typ; ogiltiga data, typbyte, överlappning, minskande ställning och tre tidigare jämförbara dagsmedel behåller sina regler.

Avstånd säger däremot något om täckning. Hela UTC-dagar mellan två periodvolymer av samma typ redovisas som separata coverageGaps med egna datum och antal dagar, inte som fel på den senare avläsningen. Ingen godtycklig tröskel för ”stor” införs; en eller flera hela luckdagar visas i en neutral, hopfällbar upplysning. Inget värde fylls i och ingen förbrukning uppskattas. Detta visar luckor mellan de registrerade perioderna i hämtat underlag, inte att ingen avläsning någonsin gjorts. Luckor före första/efter sista observationen kan inte härledas utan en separat förväntan.

Dagsmedel är inte en säsongs-/beläggningsmodell. Gammal historik kan vara mindre representativ; HIGH_RATE är en uppmaning att kontrollera, aldrig bevis för fel eller debiteringsklartecken. Två meningar i analyskoden ska uttrycka både vad som mäts och vad jämförelsen inte kan se.

Separat läsande granskning stödjer matematiken. Den upptäckte att en ny GAP-kod i findings skulle ge en bärnstensfärgad avvikelse med den aktuella avläsningens datum; därför används separat upplysning med luckans egna datum. Mätgranskningen verifierade fullständighet och källhashar, samt krävde exakt rapportmängd och att 216 kombinationer inte kallas 216 olika datumserier.

## Fullständig tabell

Y/N är verkligt formulärutfall per observation. Om någon rad avvisas körs inte analysen för den serien; strecket betyder **inte noll**. Analyscellen visar trendAssessed; findings som KOD@avläsningsnummer (ettbaserat). Samma månad med samma periodslut ger dubblett/OVERLAP, vilket hålls isär från tyst luckspärr.

| Kombination | Formulär | Perioder i ordning | Före | Första fixen |
| --- | --- | --- | --- | --- |
| jan20/CUMULATIVE/first/today/successive | YYYYY | 2026-01-01..2026-01-20; 2026-02-01..2026-02-20; 2026-03-01..2026-03-20; 2026-04-01..2026-04-20; 2026-05-01..2026-05-20 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/first/today/skip-month | YYYYY | 2026-01-01..2026-01-20; 2026-02-01..2026-02-20; 2026-03-01..2026-03-20; 2026-04-01..2026-04-20; 2026-06-01..2026-06-20 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/first/today/same-month | YYYYY | 2026-01-01..2026-01-20; 2026-02-01..2026-02-20; 2026-03-01..2026-03-20; 2026-04-01..2026-04-20; 2026-04-01..2026-04-20 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/first/last/successive | YYYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-04-01..2026-04-30; 2026-05-01..2026-05-31 | 1; [HIGH_RATE@5] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/first/last/skip-month | YYYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-04-01..2026-04-30; 2026-06-01..2026-06-30 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/first/last/same-month | YYYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-04-01..2026-04-30; 2026-04-01..2026-04-30 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/first/same/successive | YYYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-04-01..2026-04-01; 2026-05-01..2026-05-01 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/first/same/skip-month | YYYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-04-01..2026-04-01; 2026-06-01..2026-06-01 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/first/same/same-month | YYYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-04-01..2026-04-01; 2026-04-01..2026-04-01 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/first/next/successive | YYYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-04-01..2026-05-10; 2026-05-01..2026-06-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/first/next/skip-month | YYYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-04-01..2026-05-10; 2026-06-01..2026-07-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] |
| jan20/CUMULATIVE/first/next/same-month | YYYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-04-01..2026-05-10; 2026-04-01..2026-05-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/middle/today/successive | YYYYY | 2026-01-15..2026-01-20; 2026-02-15..2026-02-20; 2026-03-15..2026-03-20; 2026-04-15..2026-04-20; 2026-05-15..2026-05-20 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/middle/today/skip-month | YYYYY | 2026-01-15..2026-01-20; 2026-02-15..2026-02-20; 2026-03-15..2026-03-20; 2026-04-15..2026-04-20; 2026-06-15..2026-06-20 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/middle/today/same-month | YYYYY | 2026-01-15..2026-01-20; 2026-02-15..2026-02-20; 2026-03-15..2026-03-20; 2026-04-15..2026-04-20; 2026-04-15..2026-04-20 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/middle/last/successive | YYYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-04-15..2026-04-30; 2026-05-15..2026-05-31 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/middle/last/skip-month | YYYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-04-15..2026-04-30; 2026-06-15..2026-06-30 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/middle/last/same-month | YYYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-04-15..2026-04-30; 2026-04-15..2026-04-30 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/middle/same/successive | YYYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-04-15..2026-04-15; 2026-05-15..2026-05-15 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/middle/same/skip-month | YYYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-04-15..2026-04-15; 2026-06-15..2026-06-15 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/middle/same/same-month | YYYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-04-15..2026-04-15; 2026-04-15..2026-04-15 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/middle/next/successive | YYYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-04-15..2026-05-10; 2026-05-15..2026-06-10 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/middle/next/skip-month | YYYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-04-15..2026-05-10; 2026-06-15..2026-07-10 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/middle/next/same-month | YYYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-04-15..2026-05-10; 2026-04-15..2026-05-10 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/last/today/successive | NNNNN | 2026-01-31..2026-01-20; 2026-02-28..2026-02-20; 2026-03-31..2026-03-20; 2026-04-30..2026-04-20; 2026-05-31..2026-05-20 | — avvisad | — avvisad |
| jan20/CUMULATIVE/last/today/skip-month | NNNNN | 2026-01-31..2026-01-20; 2026-02-28..2026-02-20; 2026-03-31..2026-03-20; 2026-04-30..2026-04-20; 2026-06-30..2026-06-20 | — avvisad | — avvisad |
| jan20/CUMULATIVE/last/today/same-month | NNNNN | 2026-01-31..2026-01-20; 2026-02-28..2026-02-20; 2026-03-31..2026-03-20; 2026-04-30..2026-04-20; 2026-04-30..2026-04-20 | — avvisad | — avvisad |
| jan20/CUMULATIVE/last/last/successive | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-05-31..2026-05-31 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/last/last/skip-month | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-06-30..2026-06-30 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/last/last/same-month | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-04-30..2026-04-30 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/last/same/successive | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-05-31..2026-05-31 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/last/same/skip-month | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-06-30..2026-06-30 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/last/same/same-month | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-04-30..2026-04-30 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/CUMULATIVE/last/next/successive | YYYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-04-30..2026-05-10; 2026-05-31..2026-06-10 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/last/next/skip-month | YYYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-04-30..2026-05-10; 2026-06-30..2026-07-10 | 0; [] | 1; [HIGH_RATE@5] |
| jan20/CUMULATIVE/last/next/same-month | YYYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-04-30..2026-05-10; 2026-04-30..2026-05-10 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan20/PERIOD_VOLUME/first/today/successive | YYYY | 2026-01-01..2026-01-20; 2026-02-01..2026-02-20; 2026-03-01..2026-03-20; 2026-04-01..2026-04-20 | 0; [] | 1; [HIGH_RATE@4] |
| jan20/PERIOD_VOLUME/first/today/skip-month | YYYY | 2026-01-01..2026-01-20; 2026-02-01..2026-02-20; 2026-03-01..2026-03-20; 2026-05-01..2026-05-20 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/first/today/same-month | YYYY | 2026-01-01..2026-01-20; 2026-02-01..2026-02-20; 2026-03-01..2026-03-20; 2026-03-01..2026-03-20 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/first/last/successive | YYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-04-01..2026-04-30 | 1; [HIGH_RATE@4] | 1; [HIGH_RATE@4] |
| jan20/PERIOD_VOLUME/first/last/skip-month | YYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-05-01..2026-05-31 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/first/last/same-month | YYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-03-01..2026-03-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/first/same/successive | YYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-04-01..2026-04-01 | 0; [] | 1; [HIGH_RATE@4] |
| jan20/PERIOD_VOLUME/first/same/skip-month | YYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-05-01..2026-05-01 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/first/same/same-month | YYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-03-01..2026-03-01 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/first/next/successive | YYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-04-01..2026-05-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/first/next/skip-month | YYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-05-01..2026-06-10 | 0; [OVERLAP@2, OVERLAP@3] | 0; [OVERLAP@2, OVERLAP@3] |
| jan20/PERIOD_VOLUME/first/next/same-month | YYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-03-01..2026-04-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/middle/today/successive | YYYY | 2026-01-15..2026-01-20; 2026-02-15..2026-02-20; 2026-03-15..2026-03-20; 2026-04-15..2026-04-20 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/middle/today/skip-month | YYYY | 2026-01-15..2026-01-20; 2026-02-15..2026-02-20; 2026-03-15..2026-03-20; 2026-05-15..2026-05-20 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/middle/today/same-month | YYYY | 2026-01-15..2026-01-20; 2026-02-15..2026-02-20; 2026-03-15..2026-03-20; 2026-03-15..2026-03-20 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/middle/last/successive | YYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-04-15..2026-04-30 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/middle/last/skip-month | YYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-05-15..2026-05-31 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/middle/last/same-month | YYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-03-15..2026-03-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/middle/same/successive | YYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-04-15..2026-04-15 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/middle/same/skip-month | YYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-05-15..2026-05-15 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/middle/same/same-month | YYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-03-15..2026-03-15 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/middle/next/successive | YYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-04-15..2026-05-10 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/middle/next/skip-month | YYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-05-15..2026-06-10 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/middle/next/same-month | YYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-03-15..2026-04-10 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/last/today/successive | NNNN | 2026-01-31..2026-01-20; 2026-02-28..2026-02-20; 2026-03-31..2026-03-20; 2026-04-30..2026-04-20 | — avvisad | — avvisad |
| jan20/PERIOD_VOLUME/last/today/skip-month | NNNN | 2026-01-31..2026-01-20; 2026-02-28..2026-02-20; 2026-03-31..2026-03-20; 2026-05-31..2026-05-20 | — avvisad | — avvisad |
| jan20/PERIOD_VOLUME/last/today/same-month | NNNN | 2026-01-31..2026-01-20; 2026-02-28..2026-02-20; 2026-03-31..2026-03-20; 2026-03-31..2026-03-20 | — avvisad | — avvisad |
| jan20/PERIOD_VOLUME/last/last/successive | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/last/last/skip-month | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-05-31..2026-05-31 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/last/last/same-month | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-03-31..2026-03-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/last/same/successive | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/last/same/skip-month | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-05-31..2026-05-31 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/last/same/same-month | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-03-31..2026-03-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan20/PERIOD_VOLUME/last/next/successive | YYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-04-30..2026-05-10 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/last/next/skip-month | YYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-05-31..2026-06-10 | 0; [] | 0; [] |
| jan20/PERIOD_VOLUME/last/next/same-month | YYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-03-31..2026-04-10 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan02/CUMULATIVE/first/today/successive | YYYYY | 2026-01-01..2026-01-02; 2026-02-01..2026-02-02; 2026-03-01..2026-03-02; 2026-04-01..2026-04-02; 2026-05-01..2026-05-02 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/first/today/skip-month | YYYYY | 2026-01-01..2026-01-02; 2026-02-01..2026-02-02; 2026-03-01..2026-03-02; 2026-04-01..2026-04-02; 2026-06-01..2026-06-02 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/first/today/same-month | YYYYY | 2026-01-01..2026-01-02; 2026-02-01..2026-02-02; 2026-03-01..2026-03-02; 2026-04-01..2026-04-02; 2026-04-01..2026-04-02 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/first/last/successive | YYYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-04-01..2026-04-30; 2026-05-01..2026-05-31 | 1; [HIGH_RATE@5] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/first/last/skip-month | YYYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-04-01..2026-04-30; 2026-06-01..2026-06-30 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/first/last/same-month | YYYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-04-01..2026-04-30; 2026-04-01..2026-04-30 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/first/same/successive | YYYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-04-01..2026-04-01; 2026-05-01..2026-05-01 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/first/same/skip-month | YYYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-04-01..2026-04-01; 2026-06-01..2026-06-01 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/first/same/same-month | YYYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-04-01..2026-04-01; 2026-04-01..2026-04-01 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/first/next/successive | YYYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-04-01..2026-05-10; 2026-05-01..2026-06-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/first/next/skip-month | YYYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-04-01..2026-05-10; 2026-06-01..2026-07-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] |
| jan02/CUMULATIVE/first/next/same-month | YYYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-04-01..2026-05-10; 2026-04-01..2026-05-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/middle/today/successive | NNNNN | 2026-01-15..2026-01-02; 2026-02-15..2026-02-02; 2026-03-15..2026-03-02; 2026-04-15..2026-04-02; 2026-05-15..2026-05-02 | — avvisad | — avvisad |
| jan02/CUMULATIVE/middle/today/skip-month | NNNNN | 2026-01-15..2026-01-02; 2026-02-15..2026-02-02; 2026-03-15..2026-03-02; 2026-04-15..2026-04-02; 2026-06-15..2026-06-02 | — avvisad | — avvisad |
| jan02/CUMULATIVE/middle/today/same-month | NNNNN | 2026-01-15..2026-01-02; 2026-02-15..2026-02-02; 2026-03-15..2026-03-02; 2026-04-15..2026-04-02; 2026-04-15..2026-04-02 | — avvisad | — avvisad |
| jan02/CUMULATIVE/middle/last/successive | YYYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-04-15..2026-04-30; 2026-05-15..2026-05-31 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/middle/last/skip-month | YYYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-04-15..2026-04-30; 2026-06-15..2026-06-30 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/middle/last/same-month | YYYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-04-15..2026-04-30; 2026-04-15..2026-04-30 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/middle/same/successive | YYYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-04-15..2026-04-15; 2026-05-15..2026-05-15 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/middle/same/skip-month | YYYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-04-15..2026-04-15; 2026-06-15..2026-06-15 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/middle/same/same-month | YYYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-04-15..2026-04-15; 2026-04-15..2026-04-15 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/middle/next/successive | YYYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-04-15..2026-05-10; 2026-05-15..2026-06-10 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/middle/next/skip-month | YYYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-04-15..2026-05-10; 2026-06-15..2026-07-10 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/middle/next/same-month | YYYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-04-15..2026-05-10; 2026-04-15..2026-05-10 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/last/today/successive | NNNNN | 2026-01-31..2026-01-02; 2026-02-28..2026-02-02; 2026-03-31..2026-03-02; 2026-04-30..2026-04-02; 2026-05-31..2026-05-02 | — avvisad | — avvisad |
| jan02/CUMULATIVE/last/today/skip-month | NNNNN | 2026-01-31..2026-01-02; 2026-02-28..2026-02-02; 2026-03-31..2026-03-02; 2026-04-30..2026-04-02; 2026-06-30..2026-06-02 | — avvisad | — avvisad |
| jan02/CUMULATIVE/last/today/same-month | NNNNN | 2026-01-31..2026-01-02; 2026-02-28..2026-02-02; 2026-03-31..2026-03-02; 2026-04-30..2026-04-02; 2026-04-30..2026-04-02 | — avvisad | — avvisad |
| jan02/CUMULATIVE/last/last/successive | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-05-31..2026-05-31 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/last/last/skip-month | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-06-30..2026-06-30 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/last/last/same-month | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-04-30..2026-04-30 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/last/same/successive | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-05-31..2026-05-31 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/last/same/skip-month | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-06-30..2026-06-30 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/last/same/same-month | YYYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30; 2026-04-30..2026-04-30 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan02/CUMULATIVE/last/next/successive | YYYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-04-30..2026-05-10; 2026-05-31..2026-06-10 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/last/next/skip-month | YYYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-04-30..2026-05-10; 2026-06-30..2026-07-10 | 0; [] | 1; [HIGH_RATE@5] |
| jan02/CUMULATIVE/last/next/same-month | YYYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-04-30..2026-05-10; 2026-04-30..2026-05-10 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| jan02/PERIOD_VOLUME/first/today/successive | YYYY | 2026-01-01..2026-01-02; 2026-02-01..2026-02-02; 2026-03-01..2026-03-02; 2026-04-01..2026-04-02 | 0; [] | 1; [HIGH_RATE@4] |
| jan02/PERIOD_VOLUME/first/today/skip-month | YYYY | 2026-01-01..2026-01-02; 2026-02-01..2026-02-02; 2026-03-01..2026-03-02; 2026-05-01..2026-05-02 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/first/today/same-month | YYYY | 2026-01-01..2026-01-02; 2026-02-01..2026-02-02; 2026-03-01..2026-03-02; 2026-03-01..2026-03-02 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/first/last/successive | YYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-04-01..2026-04-30 | 1; [HIGH_RATE@4] | 1; [HIGH_RATE@4] |
| jan02/PERIOD_VOLUME/first/last/skip-month | YYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-05-01..2026-05-31 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/first/last/same-month | YYYY | 2026-01-01..2026-01-31; 2026-02-01..2026-02-28; 2026-03-01..2026-03-31; 2026-03-01..2026-03-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/first/same/successive | YYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-04-01..2026-04-01 | 0; [] | 1; [HIGH_RATE@4] |
| jan02/PERIOD_VOLUME/first/same/skip-month | YYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-05-01..2026-05-01 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/first/same/same-month | YYYY | 2026-01-01..2026-01-01; 2026-02-01..2026-02-01; 2026-03-01..2026-03-01; 2026-03-01..2026-03-01 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/first/next/successive | YYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-04-01..2026-05-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/first/next/skip-month | YYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-05-01..2026-06-10 | 0; [OVERLAP@2, OVERLAP@3] | 0; [OVERLAP@2, OVERLAP@3] |
| jan02/PERIOD_VOLUME/first/next/same-month | YYYY | 2026-01-01..2026-02-10; 2026-02-01..2026-03-10; 2026-03-01..2026-04-10; 2026-03-01..2026-04-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/middle/today/successive | NNNN | 2026-01-15..2026-01-02; 2026-02-15..2026-02-02; 2026-03-15..2026-03-02; 2026-04-15..2026-04-02 | — avvisad | — avvisad |
| jan02/PERIOD_VOLUME/middle/today/skip-month | NNNN | 2026-01-15..2026-01-02; 2026-02-15..2026-02-02; 2026-03-15..2026-03-02; 2026-05-15..2026-05-02 | — avvisad | — avvisad |
| jan02/PERIOD_VOLUME/middle/today/same-month | NNNN | 2026-01-15..2026-01-02; 2026-02-15..2026-02-02; 2026-03-15..2026-03-02; 2026-03-15..2026-03-02 | — avvisad | — avvisad |
| jan02/PERIOD_VOLUME/middle/last/successive | YYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-04-15..2026-04-30 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/middle/last/skip-month | YYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-05-15..2026-05-31 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/middle/last/same-month | YYYY | 2026-01-15..2026-01-31; 2026-02-15..2026-02-28; 2026-03-15..2026-03-31; 2026-03-15..2026-03-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/middle/same/successive | YYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-04-15..2026-04-15 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/middle/same/skip-month | YYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-05-15..2026-05-15 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/middle/same/same-month | YYYY | 2026-01-15..2026-01-15; 2026-02-15..2026-02-15; 2026-03-15..2026-03-15; 2026-03-15..2026-03-15 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/middle/next/successive | YYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-04-15..2026-05-10 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/middle/next/skip-month | YYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-05-15..2026-06-10 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/middle/next/same-month | YYYY | 2026-01-15..2026-02-10; 2026-02-15..2026-03-10; 2026-03-15..2026-04-10; 2026-03-15..2026-04-10 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/last/today/successive | NNNN | 2026-01-31..2026-01-02; 2026-02-28..2026-02-02; 2026-03-31..2026-03-02; 2026-04-30..2026-04-02 | — avvisad | — avvisad |
| jan02/PERIOD_VOLUME/last/today/skip-month | NNNN | 2026-01-31..2026-01-02; 2026-02-28..2026-02-02; 2026-03-31..2026-03-02; 2026-05-31..2026-05-02 | — avvisad | — avvisad |
| jan02/PERIOD_VOLUME/last/today/same-month | NNNN | 2026-01-31..2026-01-02; 2026-02-28..2026-02-02; 2026-03-31..2026-03-02; 2026-03-31..2026-03-02 | — avvisad | — avvisad |
| jan02/PERIOD_VOLUME/last/last/successive | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/last/last/skip-month | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-05-31..2026-05-31 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/last/last/same-month | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-03-31..2026-03-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/last/same/successive | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-04-30..2026-04-30 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/last/same/skip-month | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-05-31..2026-05-31 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/last/same/same-month | YYYY | 2026-01-31..2026-01-31; 2026-02-28..2026-02-28; 2026-03-31..2026-03-31; 2026-03-31..2026-03-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| jan02/PERIOD_VOLUME/last/next/successive | YYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-04-30..2026-05-10 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/last/next/skip-month | YYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-05-31..2026-06-10 | 0; [] | 0; [] |
| jan02/PERIOD_VOLUME/last/next/same-month | YYYY | 2026-01-31..2026-02-10; 2026-02-28..2026-03-10; 2026-03-31..2026-04-10; 2026-03-31..2026-04-10 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/CUMULATIVE/first/today/successive | YYYYY | 2027-11-01..2027-11-28; 2027-12-01..2027-12-28; 2028-01-01..2028-01-28; 2028-02-01..2028-02-28; 2028-03-01..2028-03-28 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/first/today/skip-month | YYYYY | 2027-11-01..2027-11-28; 2027-12-01..2027-12-28; 2028-01-01..2028-01-28; 2028-02-01..2028-02-28; 2028-04-01..2028-04-28 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/first/today/same-month | YYYYY | 2027-11-01..2027-11-28; 2027-12-01..2027-12-28; 2028-01-01..2028-01-28; 2028-02-01..2028-02-28; 2028-02-01..2028-02-28 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/first/last/successive | YYYYY | 2027-11-01..2027-11-30; 2027-12-01..2027-12-31; 2028-01-01..2028-01-31; 2028-02-01..2028-02-29; 2028-03-01..2028-03-31 | 1; [HIGH_RATE@5] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/first/last/skip-month | YYYYY | 2027-11-01..2027-11-30; 2027-12-01..2027-12-31; 2028-01-01..2028-01-31; 2028-02-01..2028-02-29; 2028-04-01..2028-04-30 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/first/last/same-month | YYYYY | 2027-11-01..2027-11-30; 2027-12-01..2027-12-31; 2028-01-01..2028-01-31; 2028-02-01..2028-02-29; 2028-02-01..2028-02-29 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/first/same/successive | YYYYY | 2027-11-01..2027-11-01; 2027-12-01..2027-12-01; 2028-01-01..2028-01-01; 2028-02-01..2028-02-01; 2028-03-01..2028-03-01 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/first/same/skip-month | YYYYY | 2027-11-01..2027-11-01; 2027-12-01..2027-12-01; 2028-01-01..2028-01-01; 2028-02-01..2028-02-01; 2028-04-01..2028-04-01 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/first/same/same-month | YYYYY | 2027-11-01..2027-11-01; 2027-12-01..2027-12-01; 2028-01-01..2028-01-01; 2028-02-01..2028-02-01; 2028-02-01..2028-02-01 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/first/next/successive | YYYYY | 2027-11-01..2027-12-10; 2027-12-01..2028-01-10; 2028-01-01..2028-02-10; 2028-02-01..2028-03-10; 2028-03-01..2028-04-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/first/next/skip-month | YYYYY | 2027-11-01..2027-12-10; 2027-12-01..2028-01-10; 2028-01-01..2028-02-10; 2028-02-01..2028-03-10; 2028-04-01..2028-05-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] |
| nov28/CUMULATIVE/first/next/same-month | YYYYY | 2027-11-01..2027-12-10; 2027-12-01..2028-01-10; 2028-01-01..2028-02-10; 2028-02-01..2028-03-10; 2028-02-01..2028-03-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/middle/today/successive | YYYYY | 2027-11-15..2027-11-28; 2027-12-15..2027-12-28; 2028-01-15..2028-01-28; 2028-02-15..2028-02-28; 2028-03-15..2028-03-28 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/middle/today/skip-month | YYYYY | 2027-11-15..2027-11-28; 2027-12-15..2027-12-28; 2028-01-15..2028-01-28; 2028-02-15..2028-02-28; 2028-04-15..2028-04-28 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/middle/today/same-month | YYYYY | 2027-11-15..2027-11-28; 2027-12-15..2027-12-28; 2028-01-15..2028-01-28; 2028-02-15..2028-02-28; 2028-02-15..2028-02-28 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/middle/last/successive | YYYYY | 2027-11-15..2027-11-30; 2027-12-15..2027-12-31; 2028-01-15..2028-01-31; 2028-02-15..2028-02-29; 2028-03-15..2028-03-31 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/middle/last/skip-month | YYYYY | 2027-11-15..2027-11-30; 2027-12-15..2027-12-31; 2028-01-15..2028-01-31; 2028-02-15..2028-02-29; 2028-04-15..2028-04-30 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/middle/last/same-month | YYYYY | 2027-11-15..2027-11-30; 2027-12-15..2027-12-31; 2028-01-15..2028-01-31; 2028-02-15..2028-02-29; 2028-02-15..2028-02-29 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/middle/same/successive | YYYYY | 2027-11-15..2027-11-15; 2027-12-15..2027-12-15; 2028-01-15..2028-01-15; 2028-02-15..2028-02-15; 2028-03-15..2028-03-15 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/middle/same/skip-month | YYYYY | 2027-11-15..2027-11-15; 2027-12-15..2027-12-15; 2028-01-15..2028-01-15; 2028-02-15..2028-02-15; 2028-04-15..2028-04-15 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/middle/same/same-month | YYYYY | 2027-11-15..2027-11-15; 2027-12-15..2027-12-15; 2028-01-15..2028-01-15; 2028-02-15..2028-02-15; 2028-02-15..2028-02-15 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/middle/next/successive | YYYYY | 2027-11-15..2027-12-10; 2027-12-15..2028-01-10; 2028-01-15..2028-02-10; 2028-02-15..2028-03-10; 2028-03-15..2028-04-10 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/middle/next/skip-month | YYYYY | 2027-11-15..2027-12-10; 2027-12-15..2028-01-10; 2028-01-15..2028-02-10; 2028-02-15..2028-03-10; 2028-04-15..2028-05-10 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/middle/next/same-month | YYYYY | 2027-11-15..2027-12-10; 2027-12-15..2028-01-10; 2028-01-15..2028-02-10; 2028-02-15..2028-03-10; 2028-02-15..2028-03-10 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/last/today/successive | NNNNN | 2027-11-30..2027-11-28; 2027-12-31..2027-12-28; 2028-01-31..2028-01-28; 2028-02-29..2028-02-28; 2028-03-31..2028-03-28 | — avvisad | — avvisad |
| nov28/CUMULATIVE/last/today/skip-month | NNNNN | 2027-11-30..2027-11-28; 2027-12-31..2027-12-28; 2028-01-31..2028-01-28; 2028-02-29..2028-02-28; 2028-04-30..2028-04-28 | — avvisad | — avvisad |
| nov28/CUMULATIVE/last/today/same-month | NNNNN | 2027-11-30..2027-11-28; 2027-12-31..2027-12-28; 2028-01-31..2028-01-28; 2028-02-29..2028-02-28; 2028-02-29..2028-02-28 | — avvisad | — avvisad |
| nov28/CUMULATIVE/last/last/successive | YYYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-02-29..2028-02-29; 2028-03-31..2028-03-31 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/last/last/skip-month | YYYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-02-29..2028-02-29; 2028-04-30..2028-04-30 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/last/last/same-month | YYYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-02-29..2028-02-29; 2028-02-29..2028-02-29 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/last/same/successive | YYYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-02-29..2028-02-29; 2028-03-31..2028-03-31 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/last/same/skip-month | YYYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-02-29..2028-02-29; 2028-04-30..2028-04-30 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/last/same/same-month | YYYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-02-29..2028-02-29; 2028-02-29..2028-02-29 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/CUMULATIVE/last/next/successive | YYYYY | 2027-11-30..2027-12-10; 2027-12-31..2028-01-10; 2028-01-31..2028-02-10; 2028-02-29..2028-03-10; 2028-03-31..2028-04-10 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/last/next/skip-month | YYYYY | 2027-11-30..2027-12-10; 2027-12-31..2028-01-10; 2028-01-31..2028-02-10; 2028-02-29..2028-03-10; 2028-04-30..2028-05-10 | 0; [] | 1; [HIGH_RATE@5] |
| nov28/CUMULATIVE/last/next/same-month | YYYYY | 2027-11-30..2027-12-10; 2027-12-31..2028-01-10; 2028-01-31..2028-02-10; 2028-02-29..2028-03-10; 2028-02-29..2028-03-10 | 0; [OVERLAP@4, OVERLAP@5] | 0; [OVERLAP@4, OVERLAP@5] |
| nov28/PERIOD_VOLUME/first/today/successive | YYYY | 2027-11-01..2027-11-28; 2027-12-01..2027-12-28; 2028-01-01..2028-01-28; 2028-02-01..2028-02-28 | 0; [] | 1; [HIGH_RATE@4] |
| nov28/PERIOD_VOLUME/first/today/skip-month | YYYY | 2027-11-01..2027-11-28; 2027-12-01..2027-12-28; 2028-01-01..2028-01-28; 2028-03-01..2028-03-28 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/first/today/same-month | YYYY | 2027-11-01..2027-11-28; 2027-12-01..2027-12-28; 2028-01-01..2028-01-28; 2028-01-01..2028-01-28 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/first/last/successive | YYYY | 2027-11-01..2027-11-30; 2027-12-01..2027-12-31; 2028-01-01..2028-01-31; 2028-02-01..2028-02-29 | 1; [HIGH_RATE@4] | 1; [HIGH_RATE@4] |
| nov28/PERIOD_VOLUME/first/last/skip-month | YYYY | 2027-11-01..2027-11-30; 2027-12-01..2027-12-31; 2028-01-01..2028-01-31; 2028-03-01..2028-03-31 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/first/last/same-month | YYYY | 2027-11-01..2027-11-30; 2027-12-01..2027-12-31; 2028-01-01..2028-01-31; 2028-01-01..2028-01-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/first/same/successive | YYYY | 2027-11-01..2027-11-01; 2027-12-01..2027-12-01; 2028-01-01..2028-01-01; 2028-02-01..2028-02-01 | 0; [] | 1; [HIGH_RATE@4] |
| nov28/PERIOD_VOLUME/first/same/skip-month | YYYY | 2027-11-01..2027-11-01; 2027-12-01..2027-12-01; 2028-01-01..2028-01-01; 2028-03-01..2028-03-01 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/first/same/same-month | YYYY | 2027-11-01..2027-11-01; 2027-12-01..2027-12-01; 2028-01-01..2028-01-01; 2028-01-01..2028-01-01 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/first/next/successive | YYYY | 2027-11-01..2027-12-10; 2027-12-01..2028-01-10; 2028-01-01..2028-02-10; 2028-02-01..2028-03-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/first/next/skip-month | YYYY | 2027-11-01..2027-12-10; 2027-12-01..2028-01-10; 2028-01-01..2028-02-10; 2028-03-01..2028-04-10 | 0; [OVERLAP@2, OVERLAP@3] | 0; [OVERLAP@2, OVERLAP@3] |
| nov28/PERIOD_VOLUME/first/next/same-month | YYYY | 2027-11-01..2027-12-10; 2027-12-01..2028-01-10; 2028-01-01..2028-02-10; 2028-01-01..2028-02-10 | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@2, OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/middle/today/successive | YYYY | 2027-11-15..2027-11-28; 2027-12-15..2027-12-28; 2028-01-15..2028-01-28; 2028-02-15..2028-02-28 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/middle/today/skip-month | YYYY | 2027-11-15..2027-11-28; 2027-12-15..2027-12-28; 2028-01-15..2028-01-28; 2028-03-15..2028-03-28 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/middle/today/same-month | YYYY | 2027-11-15..2027-11-28; 2027-12-15..2027-12-28; 2028-01-15..2028-01-28; 2028-01-15..2028-01-28 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/middle/last/successive | YYYY | 2027-11-15..2027-11-30; 2027-12-15..2027-12-31; 2028-01-15..2028-01-31; 2028-02-15..2028-02-29 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/middle/last/skip-month | YYYY | 2027-11-15..2027-11-30; 2027-12-15..2027-12-31; 2028-01-15..2028-01-31; 2028-03-15..2028-03-31 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/middle/last/same-month | YYYY | 2027-11-15..2027-11-30; 2027-12-15..2027-12-31; 2028-01-15..2028-01-31; 2028-01-15..2028-01-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/middle/same/successive | YYYY | 2027-11-15..2027-11-15; 2027-12-15..2027-12-15; 2028-01-15..2028-01-15; 2028-02-15..2028-02-15 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/middle/same/skip-month | YYYY | 2027-11-15..2027-11-15; 2027-12-15..2027-12-15; 2028-01-15..2028-01-15; 2028-03-15..2028-03-15 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/middle/same/same-month | YYYY | 2027-11-15..2027-11-15; 2027-12-15..2027-12-15; 2028-01-15..2028-01-15; 2028-01-15..2028-01-15 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/middle/next/successive | YYYY | 2027-11-15..2027-12-10; 2027-12-15..2028-01-10; 2028-01-15..2028-02-10; 2028-02-15..2028-03-10 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/middle/next/skip-month | YYYY | 2027-11-15..2027-12-10; 2027-12-15..2028-01-10; 2028-01-15..2028-02-10; 2028-03-15..2028-04-10 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/middle/next/same-month | YYYY | 2027-11-15..2027-12-10; 2027-12-15..2028-01-10; 2028-01-15..2028-02-10; 2028-01-15..2028-02-10 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/last/today/successive | NNNN | 2027-11-30..2027-11-28; 2027-12-31..2027-12-28; 2028-01-31..2028-01-28; 2028-02-29..2028-02-28 | — avvisad | — avvisad |
| nov28/PERIOD_VOLUME/last/today/skip-month | NNNN | 2027-11-30..2027-11-28; 2027-12-31..2027-12-28; 2028-01-31..2028-01-28; 2028-03-31..2028-03-28 | — avvisad | — avvisad |
| nov28/PERIOD_VOLUME/last/today/same-month | NNNN | 2027-11-30..2027-11-28; 2027-12-31..2027-12-28; 2028-01-31..2028-01-28; 2028-01-31..2028-01-28 | — avvisad | — avvisad |
| nov28/PERIOD_VOLUME/last/last/successive | YYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-02-29..2028-02-29 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/last/last/skip-month | YYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-03-31..2028-03-31 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/last/last/same-month | YYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-01-31..2028-01-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/last/same/successive | YYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-02-29..2028-02-29 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/last/same/skip-month | YYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-03-31..2028-03-31 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/last/same/same-month | YYYY | 2027-11-30..2027-11-30; 2027-12-31..2027-12-31; 2028-01-31..2028-01-31; 2028-01-31..2028-01-31 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| nov28/PERIOD_VOLUME/last/next/successive | YYYY | 2027-11-30..2027-12-10; 2027-12-31..2028-01-10; 2028-01-31..2028-02-10; 2028-02-29..2028-03-10 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/last/next/skip-month | YYYY | 2027-11-30..2027-12-10; 2027-12-31..2028-01-10; 2028-01-31..2028-02-10; 2028-03-31..2028-04-10 | 0; [] | 0; [] |
| nov28/PERIOD_VOLUME/last/next/same-month | YYYY | 2027-11-30..2027-12-10; 2027-12-31..2028-01-10; 2028-01-31..2028-02-10; 2028-01-31..2028-02-10 | 0; [OVERLAP@3, OVERLAP@4] | 0; [OVERLAP@3, OVERLAP@4] |
| readingDate-before-after/CUMULATIVE | YYYYY | 2026-01-15..2026-01-20; 2026-02-15..2026-02-20; 2026-03-15..2026-03-20; 2026-04-15..2026-04-20; 2026-05-15..2026-05-20 | 0; [] | 1; [HIGH_RATE@5] |
| readingDate-before-after/PERIOD_VOLUME | YYYY | 2026-01-15..2026-01-20; 2026-02-15..2026-02-20; 2026-03-15..2026-03-20; 2026-04-15..2026-04-20 | 0; [] | 0; [] |
| same-month-distinct-ends/CUMULATIVE | YY | 2026-01-15..2026-01-20; 2026-01-15..2026-01-28 | 0; [OVERLAP@2] | 0; [OVERLAP@2] |
| same-month-distinct-ends/PERIOD_VOLUME | YY | 2026-01-15..2026-01-20; 2026-01-15..2026-01-28 | 0; [OVERLAP@2] | 0; [OVERLAP@2] |
