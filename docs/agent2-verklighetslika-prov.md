# Agent 2: verklighetslika syntetiska bankprov

## Vad det äldre 81-procentsresultatet betyder

`experiment-referensstod-betalning.json` innehåller 16 syntetiska fall, två
repetitioner per variant. Den tidigare uppdelade bedömningen fick rätt
hanteringskategori i 26/32 observationer, **81,25 %**. Rätt identitet och
helt rätt bedömning var 22/32. Referensstödet fick 32/32 i alla tre måtten
på samma lilla utvecklingsmaterial. Det var inte driftprecision eller en
kalibrerad sannolikhet för en viss bankmatchning.

## Resultat 2026-09-09

**Provet är komplett men kvalitetsmässigt rött.** Alla 168 planerade
observationer finns, varav 146 faktiska modellanrop. Noll tekniska bortfall,
12/12 OCR-kontroller godkända och samtliga gamla kandidater bevarade.
Båda repetitionerna gav samma val och hanteringskategori i alla tre varianter.

| Experiment på samma nya fall | Rätt identitet | Rätt hantering | Helt rätt      |
| ---------------------------- | -------------- | -------------- | -------------- |
| Tidigare uppdelad bedömning  | 32/52 (61,5 %) | 36/52 (69,2 %) | 28/52 (53,8 %) |
| Med referensstöd             | 44/52 (84,6 %) | 40/52 (76,9 %) | 40/52 (76,9 %) |

Referensstödet förbättrade sex grundfall i båda repetitionerna: gemensamt
efternamn, identiska fullnamn, överskott, hyra plus faktura, den sjunde avin
och den gamla skulden. **Noll försämringar mot den uppdelade varianten**,
även kontrollerat separat för identitet och hantering. Detta belägger bara
utfallet på dessa fall; det garanterar inte att alla andra betalningar bevaras.
Rätt dokument fanns i kandidatlistan i 30/38 relevanta observationer utan
stödet och 38/38 med stödet. Antalet observationer med en felaktigt vald
referens minskade från 16 till 8; missad identitet och fel hantering redovisas
separat i rårapporten.

**Den befintliga förslagsvägen mäter en annan fråga:** ett korrekt en-avi-förslag
eller att avstå. Den fick **34/52 (65,4 %)** helt rätt, **12 felaktiga förslag**
och **6 missade förslag**. De sex missarna var den lilla delbetalningen, den
sjunde avin och den gamla skulden, i båda repetitionerna. Felaktiga förslag
fanns vid två förfallna avier, flera betalningsmål, överskott, identitetskonflikt,
okänd explicit referens och del av avinummer. Beloppsetiketten beräknas i kod.
Det är förslagens kvalitet som mäts, inte att någon felaktig betalning har
bokförts. De 34/52 får inte jämföras med experimentens total som identiskt mått.

### Sex kvarvarande feltyper i referensstödet

| Fall                                                     | Facit                          | AI:ns bedömning, båda repetitionerna          |
| -------------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| Två lika stora förfallna avier utan särskiljande uppgift | OKLART, inget valt dokument    | Väljer januariavin och FULL                   |
| 8 450 kr in, 1 250 kr skuld kvar, tydlig OCR             | Rätt avi och OVERSKOTT         | Rätt avi men DEL                              |
| OCR pekar mot Maja, namn och avinummer mot Markus        | OKLART, inget valt dokument    | Väljer Majas avi och FULL                     |
| Uttryckligt okänt avinummer tillsammans med känt namn    | OKLART, inget valt dokument    | Ersätter med den kända personens avi och FULL |
| HY-2701019 råkar innehålla HY-270101                     | OKLART, inget valt dokument    | Väljer den kortare avin och FULL              |
| 8 448,99 kr in på 8 450 kr skuld                         | DEL, eftersom 1,01 kr återstår | FULL                                          |

Alla sex felen återkom. Negerad retur, negerad referens, rättad referens och
den konkreta instruktionen i banktexten klarades i detta prov. Det är ingen
generell verifiering av alla negationer eller angrepp.

### Vad nästa förbättring bör pröva

Beloppsklassning bör prövas som exakt beräkning efter identifieringen, så
modellen inte behöver räkna ören eller avgöra överskott. Separata kontroller
behöver prövas för flera förfallna avier, motstridiga uppgifter och okända
uttryckliga referenser. Sådana kontroller måste behålla OCR, relevanta kandidater
samt människans möjlighet att välja. Att skära bort avier vars skuld inte
rymmer hela betalningen är fortfarande fel väg. Ingen av dessa nya kontroller
är införd eller aktiverad i detta tillägg; de kräver egen prövning med nya fall.

### Spårbarhet

Fulla begäranden och svar: `apps/api/src/ai/shadow/eval/verklighetslika-betalningar.modell.json`.
Oberoende omräkning, kandidatbevarande och jämförelse per fall/repetition:
`docs/eval/agent2-verklighetslika-kontroll.json`. Omräkningen från val och facit
stämmer för samtliga observationer. Alla sex sparade SHA-256 för källfilerna
stämmer med koden i tillägget. Körningen startade på en arbetskopia ovanpå
`d12b8e07760a5be8ee1a981016d01f06b27ec1c7`; rapportens HEAD avser den basen,
medan källhasharna identifierar den faktiskt körda koden.

Tokenförbrukning: **232 290 in, 16 277 ut, 146 anrop**, inga återförsök eller
bortfall. Ingen uppmätt kostnad i kronor påstås. Utvecklingsnyckeln användes
först efter användarens uttryckliga godkännande av dess plats och Anthropic-
anropen. Nyckeln finns inte i underlaget. Utfilen är en enda fullständig
körning; inga efterhandsändrade facit eller omkörningar för att välja bättre svar.

## Nytt prov

28 påhittade organisationsvyer med bankrader och öppna poster. Två fall
kontrollerar exakt OCR: skuggagenten ska lämna dessa till den befintliga
regelvägen utan modellanrop. De mäter inte utförd bankmatchning. Återstående
26 fall körs två gånger per variant: **52 bedömningar, inte 52 oberoende fall**.

Facit är skrivet före modellkörningen och sparas med observationerna. Det är
Codex konstruerade facit, inte oberoende mänskligt verifierade bankuppgifter.
Scenarioförklaringar och facit skickas aldrig till modellen. Fallen är
avsiktligt svåra och deras fördelning motsvarar inte en uppmätt kundpopulation.

De omfattar felskriven och ofullständig OCR, en delbetalning på 45 kr, delade
namn, identiska fullnamn, annan betalare, flera perioder, redan delvis betald
skuld, överskott, hyra plus separat faktura, returer och negationer, rättade
referenser, motstridiga identiteter, okända referenser, kandidatgränsen på fem,
90-dagarsfönstret, instruktioner i banktext, delsträngar och en-kronasgränsen.

Tre varianter använder samma observationer:

- **Befintlig förslagsväg:** produktens kandidatregel, prompt, verktyg och
  svarstolkning. Facit gäller ett förslag om EN matchning eller INGEN.
  Beloppsetiketten räknas av produktens regel. Detta prov startar inte
  tjänsten, hämtar inte DB-poster och testar inte kvoter, behörighet,
  samtidighet, bekräftelser eller bokföring.
- **Uppdelad bedömning:** det tidigare experimentets identitet och separat
  hantering. En tydligt identifierad avi kan finnas kvar även vid överskott
  eller retur. Därför är totalsiffran inte samma mått som i förslagsvägen.
- **Referensstöd:** samma uppdelade bedömning plus det redan befintliga
  experimentets hela referenser och kontroll av tvetydiga personnamn.
  Ursprungliga kandidater tas aldrig bort.

Experimentets prompt och verktygsform har flyttats till en gemensam hjälpare;
28/28 jämförelser med det tidigare skriptets uttryck var byteidentiska. Ingen
produktprompt, kandidatregel eller svarstolkning ändras av detta tillägg.

Modell: `claude-haiku-4-5-20251001`, temperatur 0, högst 1024 svarstokens,
tvingat verktyg, 60 sekunders anropstimeout och inga återförsök. Variantordningen
vänds i andra repetitionen. Råa svar, stopporsak, kandidater, begäran och
exakt tokenförbrukning sparas efter varje observation. Saknade, avvisade och
trunkerade svar behålls i nämnaren. Första API-felet stoppar vidare anrop;
kvarvarande observationer markeras uttryckligen. Inga riktiga bankrader eller
kunduppgifter används.

## Körning

Från `apps/api`, utan modell eller API-saldo:

```sh
node -r ts-node/register/transpile-only scripts/eval-verklighetslika-betalningar.ts /tmp/bankprov-utan-modell.json
```

Modellprovet kräver uttryckligen `EVAL_PAYMENTS_LIVE=1` och en
`ANTHROPIC_API_KEY` i processens miljö. Ladda bara utvecklingsnyckeln säkert;
lägg aldrig nyckeln i kommando, rapport eller repo. Använd en ny utfil för varje
prov så att tidigare felresultat bevaras.

```sh
EVAL_PAYMENTS_LIVE=1 node -r ts-node/register/transpile-only scripts/eval-verklighetslika-betalningar.ts /tmp/bankprov-med-modell.json
```

Modellprovet ger exitkod 1 om en enda bedömning avviker från facit, ett
kontrollfall faller eller ett svar saknas. Det kan alltså vara ett komplett
utfört men kvalitetsmässigt rött prov. Utan modell markeras ej körda anrop och
körningen ger ingen AI-precision.

## Lokala kodkontroller

73/73 prov i fyra avgränsade Jest-sviter, API-typkontroll och lint med noll
varningar passerar. En ny testfixture byttes före modellprovet: ett stort
överskott utan OCR hade inga kandidater, så den kunde inte pröva ett felaktigt
modellsvar. Samma kontroll använder nu det förhandsbestämda fallet med redan
delvis betald skuld och exakt OCR; scenariernas facit ändrades inte.

Sex vakter passerar utan nya undantag: webbkontrakt (6 kända poster i 5 filer),
DTO-placering (0), StrictBoolean (0 oskyddade), AI-maskering, verktygseffekter
och deterministisk journalkälla. Full utdata finns i
`docs/eval/agent2-verklighetslika-vakter.txt`.

Det här tillägget är ett mätunderlag för Claudes granskning i utkast #856.
Ingen aktivering, finansiell skrivning eller ändring i reconciliation ingår.
