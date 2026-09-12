# Luckregel för avläsningsgranskning

Bas: #858, codex/agent3-forbrukningsgranskning, 9295e013303c4de21f8eb947e3812e05d6f693e3.
Egen gren: codex/agent3-luckregel-858. Endast denna gren ändras.

Kontrakt före kod:

- Typbyte bryter alltid trendkedjan.
- CUMULATIVE: en positiv differens täcker tiden mellan periodsluten. Datumlucka bryter inte; dagsnämnaren är fortsatt tiden mellan ställningarna.
- PERIOD_VOLUME: behåll befintlig dygnsadjacens. Tillåt dessutom jämförelse mellan observerade månadsfönster: båda börjar den första vid UTC-midnatt, slutar på ett UTC-datum inom sin egen månad och tillhör direkt efterföljande kalendermånader.
- Tröskeln är alltså kalenderföljd, inte ett godtyckligt antal tolererade luckdagar. Formuläret skapar första→idag och det kräver ett kalenderbegrepp. En helt utebliven månad bryter periodvolymserien.
- Ingen interpolation: omätta mellandagar räknas inte in i volym eller dagsnämnare. trendAssessed betyder jämförda observationer, inte komplett mätning.
- Datumformen kan inte skilja 1:a→1:a som månadsfönster från en enskild dagsobservation. Kalenderformen styr även detta fall; vi lovar inte att alla glesa dagliga avsikter går att identifiera.
- OVERLAP, DECREASE, ogiltiga data, organisation/mätare, tre tidigare jämförelser och faktor tre är oförändrade.
- Upprepade månadsfönster inom samma månad överlappar fortsatt. Det är inte en luckregel och ändras inte här.

Fixturer hämtar periodStart/periodEnd genom verklig ReadingForm, fryst UTC-klocka, verkligt submit/schema och oförändrade datumfält. Dagliga/andra manuella perioder matas genom samma formulär. Värden är syntetiska dagsmedel med oberoende facit: 10 enheter/dag och ett sista hopp till 270. Inga verkliga avläsningar eller externa anrop.

Separat läsande designgranskning stödjer kontraktet och krävde att första-dagen-tvetydigheten och omätta mellandagar redovisas uttryckligen. Grenmätningen har reproducerat felet i 19 grenar (152 formulärfall) och bevarade kontroller i 76 fall. Tidigaste introduktion är #858:s egen commit. Detaljer och slutprov tillkommer efter implementation.
