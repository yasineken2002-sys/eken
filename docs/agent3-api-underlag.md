# Agent 3: API:t äger granskningsunderlaget

Fortsätter #858 och #859. GET `/consumption/reading-review` lämnar den kompletta
granskningsrapporten för organisationen i inloggningen. Alla fem befintliga
användarroller får läsa. Inga filter eller organisations-id från klienten styr
urvalet. Tjänsten läser bara de sju fält reglerna behöver via Prisma.

Reglerna bor nu i `packages/shared/src/utils/reading-review.ts`. Flytten ändrar
inte heuristiken; webbens tidigare modul är en återexport så de befintliga
regelproven fortsätter pröva samma funktion. Webben visar API:ts färdiga rapport
och räknar inte om median eller varningar. Query-nyckeln börjar med `readings`,
så befintlig registrering av en avläsning invaliderar även rapporten.

Varje varning får ett SHA-256-fingeravtryck av regelversion, varningskod,
avläsnings-id, mätar-id och de källrader som ingick, sorterade efter id. Varje
källrad innehåller id, organisation, mätare, värde, avläsningstyp och perioddatum.
API:t normaliserar Decimal till sträng och datum till ISO före beräkningen.
Förklaringens formulering ingår inte. Regelversionen är `consumption-review-v1`
och måste ändras när reglernas eller underlagets betydelse ändras.

Fingeravtrycket är **inte ett tillstånd att skriva**, inte ett godkännande och
inte sparat facit. En kommande sparendpoint behöver själv räkna fram aktuell
varning, jämföra fingeravtrycket och kontrollera organisation/roll. Den får inte
lita på underlag eller beslutande användare som webbläsaren skickar in.

## Mätning

- API: 13 serviceprov, 8 HTTP-prov och 34 befintliga förbrukningsprov gröna.
- Behörighetsytan: 19 prov gröna, golden-diff en ny läsroute (217 → 218).
- Webb: 40 prov gröna, inklusive att API:ts rapport faktiskt visas och att ny
  registrering invaliderar rapportens query.
- Shared-bygge, API- och webbtypkontroller samt lint gröna lokalt.
- Request-contract: 6 kända överträdelser, inga nya/stale; DTO-placering 0;
  modulcykelvakt grön. Baslinjerna ändras inte av denna läsroute.

HTTP-proven kör den riktiga kontrollern, tjänsten, rollgrinden, OrgId-dekoratorn
samt svarskuvertet i Nest/Fastify. JWT-identitet och Prisma är ersatta; de bevisar
inte tokenvalidering eller beteende mot riktig Postgres. Den första körningen
hade fel ordning i riggen (roll före identitet), vilket gav 403 även för tillåtna
roller. Ordningen rättades till AuthModules ordning och samtliga HTTP-prov passerade.

Webbläsarprov med konstruerat API-svar: den riktiga komponenten gjorde exakt
en GET till review-endpointen, visade rätt kumulativ differens och hade inga
JavaScript-fel eller horisontell överströmning vid 390 pixlar. Även 1150 pixlar
kontrollerades. Detta prov mockar nätverkssvaret; HTTP-proven ovan mäter servern.

Inga migrationsfiler, skrivningar, agentflaggor eller debiteringsändringar ingår.
Beständiga mänskliga bedömningar och validering mot verkligt godkänt material
återstår. Denna PR ska granskas efter #859 och riktas om mot main efter basens
merge; kör sedan aktuell CI innan merge.
