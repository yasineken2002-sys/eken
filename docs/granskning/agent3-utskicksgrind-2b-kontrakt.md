# PR 2b, steg 1 — kontrakt före SQL

Datum: 2026-09-11. Godkänd 2a-bas:
`0973272d5eb8f6f8285ec8c98f039a47f6ec568b`, PR #878. Eget utkast #879.
Detta kontrakt beskriver beställda garantier; körda bevis redovisas separat.

## Öppen ändring av det tidigare kontraktet

Byggordern ”Agent 3, PR 2b — STEG 1” ersätter 400-raderstaket med 700
ändrade produktionsrader och tillåter ett enda nytt sätt att maskinellt lösa
UNKNOWN: verifierat positivt svar från ett tillåtet, identiskt omanrop.
Tidigare 2b-förbud mot alla omanrop och all maskinell upplösning är ersatta
här och i facit FÖRE implementation. Versionen vid `6524b68f` finns i historiken.
2a:s migration, historiska leveransrapport och sjutton beteendeprov bevaras.

2a:s A–D gäller: A nytt kontrollerat original; B nytt original efter acceptans
nekas; C uttrycklig fakturaomsändning får eget beslut och försök; D UNKNOWN
hindrar nytt ORIGINAL och INVOICE_RESEND. D förbjuder inte det uttryckligen
beställda identiska omanropet av SAMMA försök. 2a:s generiska mänskliga
UNKNOWN-övergång utan utredning ska fortfarande nekas.

## Två skilda dimensioner

Senaste DeliveryEvent-revision anger leveransutfallet. Oföränderlig
exekveringshistorik anger rätten till ytterligare nätanrop. Ingen tidsgräns,
köstatus eller stängningspost får betyda skickat eller misslyckat.

| Leveransutfall       | Betydelse och övergång                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| DECIDED              | Människa har godkänt fryst underlag. Behörig människa får återkalla; behörig tjänst får försöka starta efter kontroller. |
| REVOKED              | Terminalt för beslutet; inga anrop. Historiken bevaras.                                                                  |
| SENDING              | Start har committats med ett beständigt försöks-ID. Ingen ny start; osäkerhet kan registreras som UNKNOWN.               |
| UNKNOWN              | Inget slutligt utfall är bevisat. Reservation och deltagande skrivares spärr kvarstår även när anropsfönstret stängts.   |
| PROVIDER_ACCEPTED    | Positiv korrelerad Resend-API-acceptans. Ingen mottagarleverans eller läsning påstås.                                    |
| FAILED_NO_ACCEPTANCE | 2a:s definitiva negativa slutbevis, inklusive utesluten senare acceptans. Ett fel från ett omanrop räcker aldrig.        |

| Anropsrätt             | Villkor, beständig observation och nekning                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inte startat           | Ingen nätanropsrätt, även om attemptId redan allokerats i Dispatch.                                                                                                                                                                                 |
| Första anrop           | Egen lyckad SENDING-commit, matchande principal/scope/artefakt och separat committad anropsobservation.                                                                                                                                             |
| Begränsat omanrop      | Samma attemptId, scope och sparade byte; SENDING/UNKNOWN, öppen tid och kvarvarande global budget. Ny observation med eget anropsnummer, aldrig ny attempt.                                                                                         |
| Tillfälligt för tidigt | Ingen ny rätt före återförsöksintervallet. Tidsgrund och budget återställs inte.                                                                                                                                                                    |
| Stängt                 | EXPIRED, CALL_LIMIT, CONTENT_CONFLICT eller slututfall spärrar nya rättigheter. Stängningen är oåterkallelig; inga nya POST. UNKNOWN kvarstår tills tillräckligt slutbevis; utan korrelerat positivt svar från redan tillåten RETRY krävs människa. |

Varje anropsobservation har eget beständigt ID/nummer och typ FIRST/RETRY.
Kvitto refererar just den observationen, inte bara attemptId. Identiskt
kvitto kan lagras igen utan ny acceptansövergång; annat mejl-ID för samma
försök är en avvikelse. Avvikelsen sparas utan att skriva om ett slututfall.

## Identitet, principal och behörighet

`Idempotency-Key` är EXAKT attemptId: ett beständigt UUID med DB-unikhet
även mellan organisationer. Dispatch kan allokera det i beslutets commit;
SENDING måste sedan ha `event.id = event.attemptId = dispatch.attemptId`.
Beslutets UUID är utskicks-ID. Dokumentrot och accepterad originalposition
är oförändrade. Inga prefix, Redis-nycklar eller nya nycklar vid retry.

Dispatch binder organisation, dokument, beslut, attemptId, Resend-team,
HTTP-metod, endpoint och fullständiga förseglade anropsbyte. Dessa värden är
oföränderliga. API-hemligheter ingår aldrig. Bytt team eller endpoint är
inte ett återförsök och ska avvisas före nätanrop.

Tjänsten har egen organisationsbunden principaltabell och egen kontrollerad
FK-gren i eventtriggern. Befintliga mänskliga actorId är fortsatt icke-null;
fältet authorityKind väljer uttryckligen människa respektive tjänst. SYSTEM eller
saknat User-ID blir aldrig tjänsteidentitet. En User-rad utan principalrad
kan inte verkställa. SQL skyddar relation och övergång; processens betrodda
konstruktionsport väljer tjänsteidentiteten. Ingen extern autentisering
eller hemlighetsdistribution installeras i detta inaktiva steg.

Jobbet innehåller endast beslutets identitet. Exekveraren läser organisation,
dokument och principal ur betrodd konfiguration och DB, aldrig aktör ur jobbet.
Tjänsten får starta befintligt beslut och spara korrelerade observationer/utfall.
Den får inte registrera dokument, besluta, återkalla, utreda mänskligt eller
lösa UNKNOWN negativt. Den nya positiva UNKNOWN-rätten kräver en sparad
RETRY-rätt och verifierat positivt svar för exakt dess scope och byte.
Ett sent originalkvitto efter UNKNOWN ger inte denna rätt.

CI-granskning före den korrigerade SQL-versionen: leveransens nya
behörighetsfält heter `authorityKind`, inte den globala auditkolumnen
`actorKind`. Den senare härleds och stämplas automatiskt av en befintlig
Prisma-extension. HUMAN/SERVICE och principalens FK-gren måste därför ha
egen kolumn; auditmekanismen och dess CI-spärr ändras inte.

## Atomisk lagring och ägda transaktioner

Tre nya tabeller räcker: principal, Dispatch och exekveringsobservationer.
Dispatch förenar outboxavsikt, frysta resurser och förseglad artefakt; det är
en avsikt med ett oföränderligt innehåll. Observationer är append-only och
blir inte ett andra leveransutfall. Funktioner som ersätts får kompletta
nya definitioner i NY migration; 2a:s SQL skrivs aldrig om.

| Operation         | Transaktion och bevis                                                                                                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Beslut + Dispatch | Betrodd port fryser syntetiska resurser; deras digester ingår i jämfört beslutskommando. Ägd READ COMMITTED-tx tar 2a:s lås, kör decide(tx), renderar endast frysta indata utan extern I/O och sparar förseglad Dispatch. checkConstraints körs sist. Fel rullar tillbaka allt; transporten har noll anrop. |
| Publicering       | Läser committad Dispatch och publicerar samma besluts-ID. Krasch före publicering och tappad bekräftelse lämnar avsikten återpublicerbar. Redis-retention och tidigare publiceringsobservation ger inga nya identiteter.                                                                                    |
| Start             | Exekveraren äger tx, läser underlag efter lås, kontrollerar aktuella charges/snapshot/artefakt, skriver SENDING och tidsgrund. Starttillstånd lämnas först efter lyckad commit. Övertagen tx/replay ger aldrig starttillstånd.                                                                              |
| Nekad start       | Förväntad snapshot-/policykonflikt returneras som ett nekningsresultat efter att konfliktspåret committats. Eventuellt undantag kastas först utanför tx. Inget SENDING eller POST. Oförväntat DB-fel ger ingen rätt.                                                                                        |
| Anrop             | Startens tx registrerar FIRST; omanropets egen tx registrerar RETRY och antal. Ingen tx hålls över transporten. Sista kontrollerbara portpunkt kontrollerar deadline efter commit. Tappat commitbesked ger inget anrop, även om rätten råkade bli lagrad.                                                   |
| Utgång            | Nekande operation observerar tiden och committar EXPIRED innan den rapporterar avslag. Bakgrundsjobb behövs inte för att neka. SQL-undantag i samma tx får inte vara vägen för denna normala nekning.                                                                                                       |
| Kvitto            | Ny kort tx sparar svar med grant/attempt/scope-korrelation. Positivt slutbevis ger tillåten eventövergång; 409/timeout/404 ger aldrig acceptans eller negativ finalitet.                                                                                                                                    |

## Fast tidsgrund och transportbegränsning

Tidsgrund t0 sparas från PostgreSQLs UTC-klocka före första möjliga POST.
Deadline är oföränderligt `t0 + 23 timmar`: Resends 24 timmar minus en vald
säkerhetsmarginal om en timme. Jämförelsen är strikt `nu < deadline`;
likhet och senare tid nekas. Omstart, ny worker, återpublicering, UNKNOWN
eller 409 får aldrig flytta t0 eller deadline.

Högst fyra anropsrättigheter per försök: original plus tre identiska omanrop.
Minsta intervall före retry 1/2/3 är 1/5/30 sekunder från föregående beviljade
anrop. Budget och intervall räknas i DB över alla processer. FIRST får förekomma
högst en gång, endast i den ägda starttransaktionen; RETRY högst tre gånger.
Vid krasch efter SENDING utan FIRST-observation räknas första retryintervallet
från t0. Återstartaren får RETRY, aldrig FIRST eller en fjärde retry.
CALL_LIMIT nekar nya rättigheter, inte den sista redan beviljade rätten. Förbrukad budget
stänger rätten beständigt även om ett svar tappats; utfallet kan förbli UNKNOWN.

Sista DB-tidsavläsningen görs efter övriga kontroller. Dess återstående
budget förankras konservativt i en lokal monoton klocka avläst före DB-frågan.
Direkt efter slutcommiten och före transportporten jämförs den monotona tiden
igen utan mellanliggande await. Om budgeten förbrukats sparas oåterkallelig
CONSERVATIVE_DEADLINE-stängning och UNKNOWN i en ny ägd tx; inget anrop görs.
Testerna får injicera den uttryckliga monotona klockporten och DB-tidsporten.
En paus efter denna sista synkrona jämförelse är fortfarande inte återkallbar.

PostgreSQL-klockan och den monotona klockporten måste följa faktisk
förfluten tid, även under processpauser, inom marginalen. Även
fördröjningen mellan sista kontroll och providerankomst måste rymmas inom
marginalen tillsammans med klockfelet. Detta är transportantaganden, inte
bevisade driftgränser. En säkerhetsmarginal garanterar ingenting vid
obegränsad processpaus eller obegränsad klockavvikelse.

Paus FÖRE sista kontroll: återupptagning vid/efter deadline nekas och stängning
sparas. Paus EFTER sista kontroll: ett redan kontrollerat anrop kan nå providern
senare, även efter cachens utgång. Varken lease, lokal timeout eller DB-flagga
återkallar den förmågan. Provet ska visa denna lucka och får visa möjlig andra
acceptans när transportantagandet avsiktligt bryts. Ingen driftgaranti om
högst en acceptans över obegränsad paus får hävdas.

Sena kvitton sparas alltid. En principal som avaktiverats efter en beviljad
anropsrätt får fortfarande bevara korrelerat svar för sin egen rätt. Den
får inga nya anropsrättigheter eller slutövergångar genom detta undantag. Positivt kvitto från en tidigare tillåten RETRY
får lösa UNKNOWN även när svaret anländer efter stängningen: detta avslutar
redan auktoriserat arbete och ger ingen ny anropsrätt. Stängningshistoriken
ligger kvar. Sent originalkvitto efter UNKNOWN sparas för mänsklig utredning.
Felkorrelerat eller motsägande kvitto sparas som avvikelse och ändrar inte
slututfallet. Negativ maskinell UNKNOWN-upplösning är aldrig tillåten.

## Artefakt och determinism

Det sparade innehållet är exakt serialiserade byte, inte bara en JSONB-form
som kan serialiseras annorlunda. Det binder mottagare/avsändare/ämne,
text/HTML, samtliga bilagebyte, namn, mediatyper och alla övriga fält som
skickas. Inga externa bilage-URL:er får ersätta bytebindningen. Digest ska
beräknas över de verkliga sparade byten och kontrolleras vid anropsgränsen.
Omanrop läser samma sparade sträng/byte; rendererporten får inte anropas igen.

Resursernas digester binds i beslutets commit. Betrodd syntetisk port
använder bara fryst snapshot och byte med kontrollerade digester. Samma
lagringsnyckel med bytt innehåll nekas; ny hash från den utbytta resursen är
inte ett godkännande att byta det redan beslutade innehållet.

Återanvändbara rendererportprov jämför hela resultatet för identiska frysta
indata och resurser, även över ny adapterinstans. Ändrad tidsstämpel,
slumpvärde, filnamn eller en bilagebyte ska vart och ett fälla kontraktsprovet.
Syntetiska portprov bevisar INTE den verkliga renderern. Steg 2 måste köra
samma krav mot sin riktiga adapter; dess arbete är inte byggt här.

## Skrivsamordning och inaktiv gräns

Deltagande skrivare tar samma korta organisationslås som 2a men prövar
beständig spärr för berört dokument och dess charge-medlemmar. Aktuella
relationer OCH frysta DeliveryMember ska räknas vid chargeflytt/ändring.
SENDING/UNKNOWN förbjuder skrivningen. Ett annat, obesläktat dokument i
samma organisation får committa; organisationen får ingen beständig spärr.
Samordnaren är en betrodd intern deltagarport; den gör inte godtycklig SQL
eller felaktigt deklarerade skrivmängder säkra.

Ändring först ger beständig startkonflikt; start först ger beständig
skrivspärr som överlever startarens förlorade DB-anslutning. Prov använder
separata anslutningar och observerar faktisk pg_blocking_pids-väntan.

Befintliga produktionsskrivare är ännu inte inkopplade: fakturans ändring,
kreditering och makulering i invoices.service.ts; avins betalning,
annullering och chargefrikoppling i avisering.service.ts; kredit,
påminnelse, ränta och kundförlust i rent-\*-tjänsterna; chargeändringar i
consumption.service.ts samt skrivare av snapshotens källor (avtal, part,
organisation, mätare och bedömning). Detta är namngivna kvarstående grupper,
inte en verifierad fullständig 2c-inventering. Produktionsluckan är öppen.

Ingen producent, worker, renderer, dokumentutlämning eller annan
produktionsväg kopplas in. Inga verkliga utskick, betalda API-anrop,
produktionsdata, backfill, reconciliation, merge eller driftsättning.
Modellen uttrycker inte mottagarleverans, läsning eller säker gammal historik.
Resends egna leveransretries begränsar innebörden av API-acceptans och är
inte ett separat hinder för detta inaktiva steg.

## Godkänt leverantörskontrakt, steg 0

Kontrollerat 2026-09-11: Resend behåller nycklar i 24 timmar och kan återge
originalets mejl-ID för identisk begäran. 409 concurrent anger pågående;
409 invalid anger innehållskonflikt. Ingen 409 är API-acceptans. Efter
utgången kan samma nyckel skapa en ny sändning; varje senare anrop behöver
inte göra det. [Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys),
[Errors](https://resend.com/docs/api-reference/errors).

Räckvidden team + HTTP-metod + endpoint är godkänd i byggorderns steg 0.
[Engineering Idempotency Keys](https://resend.com/blog/engineering-idempotency-keys)
och [diagrammet](https://cdn.resend.com/posts/engineering-idempotency-keys-1.png)
är dess källor; diagrammet gick inte att hämta via webbverktyget i denna omgång.
[Retrieve Sent Email](https://resend.com/docs/api-reference/emails/retrieve-email)
är uppslag på mejl-ID, inte slutbevis att ett osäkert försök saknade effekt.
Timeout, saknat kvitto och 404 lämnar alltså UNKNOWN olöst.
