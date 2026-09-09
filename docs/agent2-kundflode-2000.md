# Agent 2 — 2 000 betalningar genom kundens bankflöde

Mål: högst 20 av 2 000 inkommande betalningar ska behöva mänsklig granskning.
Felaktiga automatiska matchningar, pengar på fel avi och felaktiga belopp
räknas separat. Ett felaktigt automatiskt beslut får inte förbättra täckningen.

## Förhandsbestämt material

En konstruerad kund med 10 fastigheter, 200 lägenheter, 200 hyresgäster,
200 avtal och 2 000 hyresavier för oktober 2025–juli 2026. Två identiska
kundkopior jämför befintlig import med betalningsagentens flagga av respektive
på. Samma 2 000 unika betalningshändelser spelas genom varje kopia.
Inga verkliga kunduppgifter eller bankanslutningar används.

| Betalningstyp | Antal inkommande bankrader |
| --- | ---: |
| Vanlig hyra med OCR | 1 485 |
| Helt avinummer i text | 180 |
| Två delbetalningar per avi | 150 |
| Två månaders hyra tillsammans | 75 |
| Namn och uttrycklig månad | 60 |
| Felskriven OCR med namn och månad | 20 |
| Ingen identifierare | 10 |
| Överbetalning med uttrycklig avi | 10 |
| Motstridiga identifierare | 10 |
| **Totalt** | **2 000** |

Detta är en redovisad testblandning, inte uppmätt frekvens hos riktiga kunder.
Andelarna ändras inte efter körningen för att få målet att passera. De 30
rader som enligt förhandsfacit saknar stöd för ett säkert beslut redovisas
öppet: en ensam bättre modell kan inte skapa betalningsinformation som saknas.
Facit separerar generatorns kunskap om avsedd betalare från vad bankraden
faktiskt visar. Alla dessa rader ligger kvar i nämnaren.

Betalningarna sker i datumordning, med samma OCR återanvänt per hyresgäst över
månaderna. Avier skapas månad för månad. Restskuld, tidigare felmatchningar,
delbetalningar och väntande granskning följer med till nästa månad. Ingen
låtsad mänsklig rättning nollställer historiken mellan bankrader.

## Mätväg

En egen lokal PostgreSQL 16-databas, med projektets migrationer, används.
Fastigheter, lägenheter och avtal seedas som förutsättningar. Import/parsing,
matchning, allokering, händelser och verifikat går genom befintliga tjänster.
Detta är en integration på tjänste-/databasnivå, inte ett webbläsarprov,
bankanslutning eller test av hela appens inloggning och CRUD-validering.

Inga filer under `apps/api/src/reconciliation/` ändras. Endast testkundernas
växlar kan ändras. Inga mejl eller externa köjobb skickas. AI-anrop görs bara
efter separat kostnadsgodkännande och får en egen rapport. Sparade fullständiga
kandidatunderlag från den faktiska tidpunkten gör efteranalysen möjlig utan
att facit eller framtida betalningar läcker in i modellens indata.
