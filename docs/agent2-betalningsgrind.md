# Agent 2: prövbar kontroll före en möjlig framtida automatisk matchning

Kontrollen är byggd som ett fristående experiment i utkast #856.
Nya modellprov är förberedda men väntar på användarens godkännande av högst
64 ytterligare anrop med den sparade utvecklingsnyckeln. Inga nya API-anrop
har gjorts i detta tillägg.

Kontrollen rättar alla sex tidigare kända feltyper i återspel: 40/52 → 52/52
korrekta bedömningar. Ett äldre material förblir 32/32. Detta är utvecklings-
material som har påverkat lösningen. Det är inte bevis för 99,1 procent i drift.

## Lösningen som prövas

AI:n föreslår dokumentidentitet. Kontrollkoden jämför ören exakt, upptäcker
identitetskonflikter och bevarar både kandidatlistan och ursprungligt svar.
En korrekt identifierad avi kan därför fortsätta visas vid överskott, retur,
flera dokument eller behov av manuell granskning.

- Belopp läses som högst två decimaler och omvandlas till heltalsören.
  Ingen avrundning av extra decimaler eller tolerans med flyttalsepsilon.
  FULL/DEL/OVERSKOTT jämförs mot befintlig en-kronasgräns, och överskott på
  kvarvarande skuld beräknas efter tidigare betalningar. Toleransen tillåter
  aldrig att provkandidaten allokerar mer än den uppgivna skulden.
- Okänd uttrycklig referens, dubbelt avinummer, tvetydig OCR, konflikt mellan
  OCR och text samt flera förfallna avier utan särskiljande referens markeras
  för granskning. OCR förblir underlag; ingen kandidatsökning snävas åt.
- En **provkandidat** kräver en enda avi, ett helt unikt referensnummer eller
  unik nära OCR med unikt stöd av fullnamn, känt komplett underlag, positivt
  belopp inom skuld och en enkel positiv banktext. Namn ensamt räcker inte.
- Fri text, negationer, rättelser, flera referenser, återbetalningar och okända
  format samt okänd eller felaktigt formad OCR går till manuell granskning. Kontrollen försöker inte förstå all
  svensk text med regex. Ett korrekt AI-förslag kan därför vara kvar även
  när texten är olämplig för den snävare provkandidaten.

`provmatchning` är endast ett mätresultat. `automatiskVerkstallning` är alltid
false. Ingen producent importerar kontrollen, inga flaggor aktiveras och inga
API-, DB-, bank- eller bokföringsskrivningar tillkommer. Befintlig automatisk
OCR-matchning och filer under reconciliation är inte ändrade eller sluttestade
av detta experiment. Underlagets fullständighet är en förutsättning som testet
kan ange för sina konstruerade organisationsvyer, inte en verklig DB-garanti.

## Nya prov och hur resultatet bedöms

32 nya fall med facit skrevs innan kontrollen implementerades. De är fortfarande
konstruerade av Codex, inte oberoende människoverifierade bankrader. Samma
modellsvar jämförs före och efter kontrollen för att isolera kontrolleffekten.
Två modellrepetitioner är 64 observationer, inte 64 oberoende fall.

Förutom rätt identitet och hantering redovisas hur många korrekta tidigare
förslag som tappas, hur många rader som blir provkandidater, felaktiga
provkandidater, missade förväntade provkandidater och kvarvarande manuell andel.
Ett tomt urval har ingen uppmätt precision. Facit eller bortfall ändras inte för
att få en högre procentsiffra. Alla observationer och råa svar sparas.

## Vad 99,1 procent skulle kräva

Punktprecision räknas som rätt valda matchningar / alla valda matchningar.
Täckning är andelen inkommande rader som väljs; oklara fall får inte försvinna
ur redovisningen. Båda talen behövs, liksom separata fel vid beloppsfördelning,
fel person, dubbelbetalning och bortfall.

Som ett förhandsvalt statistiskt exempel: med noll fel på **332 oberoende,
representativa valda matchningar** blir den ensidiga exakta 95-procentiga
nedre gränsen 0,05^(1/332) = 99,1017 procent. Vid 331 är gränsen 99,0990 procent.
Detta är vår beräkning för nollfelsspecialfallet av ett
[exakt binomialintervall enligt NIST](https://itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm).
Samma fördelning, oberoende observationer och i förväg vald provstorlek är
antaganden. Upprepade syntetiska mallar ger inte detta bevis. Med något fel
krävs en annan beräkning och större underlag; att testa om tills en körning
blir grön är inte ett giltigt ersättningsprov.

Innan skarp automatik behövs dessutom oberoende facit, oförändrad kontroll
under mätningen, granskad beloppsfördelning, verifierad org-avgränsning,
aktuell skuld, samtidighet/dubblettskydd och mänsklig återställningsväg.
De senare delarna ligger utanför detta avgränsade experiment. Kravet är
fortfarande **inte belagt**, även om syntetiska prov skulle nå 100 procent.

## Körning

Från apps/api, endast återspel av sparade svar:

```sh
node -r ts-node/register/transpile-only scripts/eval-betalningsgrind.ts /tmp/bankkontroll-ny-rapport.json
```

Nya modellprov kräver EVAL_PAYMENTS_LIVE=1 och ANTHROPIC_API_KEY säkert satt i
processens miljö. Högst 64 anrop, inga återförsök, ingen överskrivning av tidigare
rapport. Första API-felet stoppar vidare anrop och kvarvarande fall redovisas
som ej körda. Använd en ny utfil för varje körning.

Källfiler, historiska underlag och körskript får SHA-256 i rapporten. Rapportens
HEAD kan vara bascommitten medan hashvärden identifierar arbetskopians faktiskt
körda filer. Efterhandsändrat facit får aldrig förklaras som modellförbättring.

## Verifiering och återspelsrapport

Slutlig rapport: `docs/eval/agent2-betalningsgrind-aterspel.json`.
Samtliga 13 källhashar stämmer. Senare källändringar kräver en ny rapportfil.
52/52 rätt på de 26 svåra grundfallen i två repetitioner, från 40/52. Äldre
16 grundfall i två repetitioner förblir 32/32. Noll tidigare korrekta
bedömningar förlorades. Alla ursprungliga kandidater är kvar i resultatet.

Det finns 8 provkandidater i vardera återspelsmaterialet, men de äldre faciten
anger inte om ett fall får gå automatiskt. Därför är precision för automatik,
felaktiga provkandidater och missar **omätta**, inte noll fel. De nya 32 fallen
har ett separat förhandsbestämt facit för just denna snävare avgränsning.

141 berörda lokala kodprov i tre sviter är verifierade, varav kontrollens
slutliga svit har 92/92. De andra två oförändrade sviterna har 34/34 och 15/15.
Lint med noll varningar och sex vakter passerar utan nya undantag. API-
typkontroll passerar. Full vaktutdata: `docs/eval/agent2-betalningsgrind-vakter.txt`.

Under arbetet tillkom gränsen för säkert representerbara ören, ett prov mot
att saknat automatikfacit visas som noll fel, och två OCR-gränsfall. Tre
tidigare återspelsrapporter finns kvar lokalt i arbetsytans rot. De använder
åldrade källhashar och ersätts som slutmätning av den länkade rapporten. Inget
scenariofacit eller sparat modellsvar ändrades.

## CI fann ett tidigare slumpberoende nyckeltest

Första CI på 8bb4ef2 passerade 474/475 API-sviter och 5793/5794 tester.
Alla nya bankprov passerade. Det enda felet var env-placeholders.spec.ts: en
slumpad base64-fixture råkade innehålla både xxx och jwt och avvisades av den
befintliga tvåordsheuristiken. E2E och övriga jobb passerade.

Acceptansprovet använder nu 200 fasta SHA-512-baserade syntetiska bytevärden
i samma tre format, utan filtrering eller omförsök. Ett uttryckligt motprov
visar att giltig base64 med två indikatorord faktiskt avvisas. Säkerhetsregeln
är oförändrad och den möjliga falska positiva avvisningen kvarstår; detta är
inte en rättning av nyckelheuristiken. Testets namn lovar därför inte längre
att alla slumpade hemligheter saknar falsklarm.

Första körningens fulla fel finns i den historiska
[CI-körningen](https://github.com/yasineken2002-sys/eken/actions/runs/34367416361/attempts/1).
Slutlig CI ska verifieras på uppföljningscommittens HEAD före merge.
