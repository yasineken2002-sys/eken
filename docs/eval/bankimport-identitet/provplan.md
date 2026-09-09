# Fryst provplan — bankimportens händelseidentitet

Bas #873: c6457aa00f027baa685d7e9b6ec28e8aa264c8e4. Endast offline-test och
rapport, ingen produktionsfix. Underlagets senaste main är
27a720d4b6fb194fed83c760ce713c6aa70a0ad5: de berörda importmetoderna,
PSD2-synken och schema.prisma är byteoförändrade. En närliggande
confirm-import.dto.ts har fått StrictString på tre fält; den körs inte här.

## Oberoende krav före körning

Olika externa händelser i ett uttryckligen bestämt syntetiskt namespace ska
representeras var för sig. Exakt återimport ska inte ge fler poster eller
nedströms anrop. Samma dag, belopp och OCR är inte ett identitetsbevis.
Fil/API-fallen med samma respektive olika verkliga testhändelser ska ha
identiska indata till produktionsmetoderna; deras skilda facit ligger separat.
Det synliggör att den tillgängliga informationen inte kan avgöra identiteten.

Faktiskt provider-namespace och cursorsemantik är okända. Prov av konto-/
leverantörslokala ID:n, nästa-sida-token och kontovisa cursors märks därför
HYPOTETISKT KONTRAKT. Ett motsatt, kompatibelt globalt-cursorfall behövs så att
riggen inte bara kan påstå fel. Kontoordning får inte påverka täckningen under
respektive uttryckligt testkontrakt. Tom sida och kontofel ska provas vid nytt
försök. Ändrat innehåll för samma ID kräver synlig osäkerhet, inte tyst
dubblettbesked; inget krav på automatisk ekonomisk rättelse införs.

Originalens 2 000, facit och tidigare resultat används inte som nya testfall
och jämförs oförändrade mot basen. Inga nya procenttal.

## Körda respektive ersatta lager

Plan: ladda de faktiska TypeScript-filerna i en isolerad Node VM med befintlig
Node 24:s type-transform. Endast Nest-dekoratorerna tas bort i minnet; ingen
metodkropp skrivs om. Kör exporterna computeBankDedupKey/normalizeToStockholmDay,
ReconciliationService.ingestFromApi/ingestFromFile och
Psd2SyncService.syncOrganization/toApiRaw samt verkliga OCR-hjälpare.
Importlänkaren tillåter endast uttryckligen listade lokala rena hjälpare,
node:crypto och testdubblar. Ej tillåtna beroenden/anrop ska kasta.

Ingen appstart, Nest-container, riktig provider, krypteringsnyckel, Redis, kö,
matchning eller bokföring startas. Provider/crypto/logger och nedströms
matchning/kö ersätts med skriptade testdubblar och anropsobservatörer. Anrop
till observerad matchningsgräns räknas; de är inte bokförda betalningar.
Prisma-runtime finns inte installerad: Decimal-fasaden hanterar enbart dessa
hela öresbelopp och P2002-fasaden motsvarar ett verkligt SQL-unikhetsfel.
Ingen allmän Prisma-/decimalcertifiering påstås.

Repository-fasaden ska översätta exakt mottagna where/data till faktisk SQL i
ny egen testtabell i isolerad PostgreSQL; den får inte svara med förbestämda
dubbletter eller själv beräkna dedupnycklar. Frågor och skrivningar sparas.
Unikhet org+externalId och nullable-id ska utvärderas av PostgreSQL. Befintlig
tillgodo_pg.py startar och verifierar egen network-none-container utan portar,
värdkataloger eller anslutningssträng från omgivningen. Inga ändringar av
produktionsschema, migrationer eller skyddad katalog görs. Om upplägget inte
kan köras säkert ska begränsningen redovisas, inte ersättas med påstått bevis.

## Mätning och granskningsgräns

Separata frysta indata/facit anger avsedda distinkta händelser och belopp.
Produktionsmetoderna får endast sina befintliga argument, aldrig facit eller
scenarioetikett. Per fall sparas indata vid gränsen, provideranrop/cursors,
utfall, faktiska SQL-frågor, sparade poster/ören/referensfält, nedströms anrop,
kontotäckning samt uttryckligen saknad identitetsinformation. Synkfel har
partiella spår även när metoden inte returnerar en resultaträknare.

Rött produktbeteende ska inte göra ett vanligt CI-test avsiktligt rött:
diagnostiken redovisar produktkrav separat från att riggen och omräkningen
fungerar. Oberoende omräkning ska kunna upptäcka ändrade antal, tappade poster,
dold kollision eller ett felaktigt påstående om bevarat konto. Minst en tidig
läsande säkerhetsgranskning av upplägget och två slutgranskningar av samma
frysta version; högst två samtidiga granskare, inga parallella tunga prov.
