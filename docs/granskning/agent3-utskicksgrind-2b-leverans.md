# Agent 3, PR 2b — steg 1, inaktivt exekveringsmaskineri

PR: [#879](https://github.com/yasineken2002-sys/eken/pull/879), fortsatt utkast.
Arbetsplats: `/workspaces/eken-fran-mac-20260909/arbete/agent3-utskicksgrind-2b`.
Gren: `codex/agent3-utskicksgrind-2b`.
PR-bas och jämförelsebas: `0973272d5eb8f6f8285ec8c98f039a47f6ec568b`,
`codex/agent3-utskicksgrind`. Start-HEAD var
`6524b68f8111cd4567db9d53e4e509301b44c4fb`, med ren arbetskopia.

Kontrakt, ändrade UNKNOWN-förväntningar och uppskattningen 624–699
produktionsrader sparades i `3db3fd44` FÖRE schema och SQL.
Första implementationens kontrollpunkt var `07ec3540`.
Efter CI-fyndet skiljs `authorityKind` från global `actorKind` i
`a2bcac66331c9f0d2a611530780fbce9b4a58582`; detta är slutlig produktionskod.
Namnseparationen dokumenterades före korrigerad SQL i `6406d21a`.
Kontrollpunkten innehåller avsiktligt kanariens borttagning av 2a-17.
De slutliga lokala 58-provskörningarna använder dess produktionskod och
2a-provet byteidentiskt återställt från `07ec3540`; återställningen sparas
sedan i en vanlig ny slutcommit.
Slutlig HEAD och dess CI-länk anges i PR:s beskrivning;
en rapport kan inte innehålla sin egen commits hash.

## Levererat och radbudget

Tre nya tabeller: organisationsbunden tjänsteprincipal, oföränderlig
Dispatch som förenar outbox och förseglat anropsinnehåll, samt append-only
exekveringsobservationer. Kärnan är inte registrerad i Nest eller kopplad
till producent, köworker, dokumentutlämning, riktig renderer eller nätklient.

Produktionsdiff mot godkänd 2a-bas: **690 ändrade rader = 676 tillagda +
14 borttagna**, inklusive 204 SQL, 50 Prisma, 332 exekverare, 33
skrivsamordnare, 33 ändringar i beslutsporten och 38 CI-rader.
Tester: **2080 ändrade rader = 2078 tillagda + 2 borttagna**.
Dokumentation och maskinläsbar bevisning redovisas separat i slutlig diffstat.
Inga produktionsrader räknas bort som ”infrastruktur”. Testporten importeras
endast av DB-specen och ingår i testsiffran. Ingen ytterligare uppdelning
har gjorts. 2a:s SQL och samtliga 17 prov återställs byteidentiskt efter
kanarien; den avsiktliga borttagningen finns kvar i vanlig Git-historik.

## Bärande garantier

Filpositionerna avser implementationens kontrollpunkt; efterföljande
ändringar gäller bevisrapport och kanariens borttagning/återställning.

| Garanti                                                                                            | Kod och bevis                                                                    |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Beslut och outbox i samma ägda commit; full rollback även uppskjutet FK-fel                        | `delivery-execution.ts:77`, `delivery-decisions.ts:64`; 2b-01/02 och 2a-17.      |
| Beständig återpublicering med samma beslut; förlorad bekräftelse/retention ändrar inte identitet   | `delivery-execution.ts:122`; 2b-03/04.                                           |
| Egen principal, organisationsbindning och separat eventgren                                        | `schema.prisma:7201`, nya migrationen `:3`, `:71`, `:119`; 2b-18.                |
| Global unik UUID-attempt; team/metod/endpoint/dokument/beslut/body binds oföränderligt             | nya migrationen `:22`, `:56`, `:196`; 2b-08/23.                                  |
| Resursernas verkliga bytes jämförs mot beslutets digester; komplett body förseglas och återanvänds | `delivery-execution.ts:91`, `:246`; 2b-09/29/30.                                 |
| Start och FIRST ägs av exekveraren, rätt lämnas efter commit; förväntad startkonflikt committas    | `delivery-execution.ts:167`; nya migrationen `:90`; 2b-05/06/10/13/18.           |
| Tidsgrund, max tre retries och 1/5/30 sekunders intervall delas mellan processer                   | nya migrationen `:77`, `:85`, `:124`; 2b-13/21/24/25.                            |
| Beständig stängning vid nekad operation och sista kontroll efter commit                            | nya migrationen `:85`; `delivery-execution.ts:147`, `:192`, `:228`; 2b-24/25/26. |
| Sparade korrelerade kvitton; endast positiv tillåten RETRY löser UNKNOWN maskinellt                | `delivery-execution.ts:261`; nya migrationen `:128`; 2b-14/16/19/20/21/22/27.    |
| Deltagande dokument- och charge-skrivare samordnas, frysta och aktuella medlemmar räknas           | `delivery-writes.ts:12`; 2b-10/11/12/28.                                         |
| CI kräver exakt namngivna 17 + 30 prov med positiva genomförda assertionstal                       | `.github/workflows/ci.yml:155`; verklig kanarie nedan.                           |

Fullständiga filer finns under `apps/api/src/consumption/`, respektive
`apps/api/prisma/migrations/20260911150000_delivery_execution/migration.sql`.
[Fryst kontrakt](agent3-utskicksgrind-2b-kontrakt.md) och
[oberoende facit](agent3-utskicksgrind-2b-facit.md) anger förväntningarna.

## Tillstånd, rättigheter och tidsgräns

Senaste DeliveryEvent anger DECIDED, REVOKED, SENDING, UNKNOWN,
PROVIDER_ACCEPTED eller FAILED_NO_ACCEPTANCE. Originalbeslutet och all
historik bevaras. FIRST/RETRY/RECEIPT/CLOSED/CONFLICT/PUBLISHED är separata
exekveringsobservationer. CLOSED betyder aldrig skickat eller misslyckat.

Tjänsteprincipalen får starta befintligt godkänt beslut, registrera osäkerhet
och korrelerade exekveringsobservationer samt verifierad positiv API-acceptans.
UNKNOWN får den lösa endast med ett positivt svar från en tillåten identisk
RETRY. Den får inte besluta, återkalla, registrera dokument, göra mänsklig
utredning eller negativt lösa UNKNOWN. User-ID/SYSTEM fungerar inte som
exekveringsidentitet. En avaktiverad principal får bevara kvitto för sin
egen tidigare grant men får varken ny anropsrätt eller eventövergång.
Processkonfigurationen väljer identiteten; köpayloaden innehåller beslutets ID.

SENDING sparar t0 från PostgreSQLs UTC-klocka före första möjliga anrop.
Deadline är t0 + 23 timmar, med en timmes marginal till Resends dokumenterade
24-timmarscache. Identiskt attemptId används exakt som Idempotency-Key.
Max en FIRST och tre RETRY; 1/5/30 sekunders minimiintervall från föregående
grant, eller t0 när FIRST saknas. Omstart, ny worker och 409 startar aldrig om
fönstret. Vid/efter gränsen committas CLOSED/EXPIRED även om inget
bakgrundsjobb körts. Avslag returneras efter commit så spåret överlever.

Efter alla övriga kontroller hämtas DB-tid. Återstående tid förankras
konservativt i en monoton klocka före frågan, och jämförs synkront efter
slutcommit direkt före transportporten. Förbrukad tid där ger beständig
CONSERVATIVE_DEADLINE och inget POST. SQL håller inte någon transaktion
över nätanropet. En förbrukad grantbudget hindrar nya grants men återkallar
inte redan beviljade anrop.

DB-proven ersätter endast den uttryckliga DB-klockporten `delivery_now()`
med en SyntheticDeliveryClock i det egna schemat och injicerar styrd
monoton tid. Ingen faktisk 23/25-timmarsväntan eller verifiering av driftens
klockor genomförs. PostgreSQL, transaktioner och låsväntor är riktiga.

Klockfel och fördröjning från sista kontroll till providerankomst måste
sammanlagt rymmas inom marginalen. Klockorna måste mäta faktisk förfluten
tid även under pauser. Det är ett uttryckligt transportantagande.
**Ingen DB-flagga, timeout eller lease kan återkalla ett redan auktoriserat
anrop efter sista kontrollen.** 2b-26 visar både stopp före kontroll och
stopp vid fördröjd slutcommit, samt att ett styrt tidshopp till t0 + 25 timmar under en kort verklig barriärpaus efter
kontrollen kan ge två provideracceptanser. Detta negativa scenario
bevisar begränsningen, inte säker drift vid obegränsad paus.

Sena kvitton bevaras utan att öppna fönstret. Positivt svar från redan
tillåten RETRY får avsluta UNKNOWN; sent FIRST efter UNKNOWN bevaras men
kräver människa. 409 concurrent lämnar olöst; 409 innehållskonflikt sparar
avvikelse och stänger. Timeout, saknat kvitto och 404 ger aldrig negativ
finalitet. Ett senare fel upphäver inte tidigare acceptans. Motstridigt
positivt mejl-ID bevaras som avvikelse utan omskrivning av slututfall.

## Lokal verifiering och negativa kontroller

API-typkontroll och riktad ESLint är gröna. Före varje Jest/typkontroll
kontrollerades delad maskin med `pgrep -af '[j]est|[t]sc'`; en tung lokal
körning åt gången. Full svit lämnas till CI.

Egen Docker-container `agent3-2b-step1-20260911`, PostgreSQL 18/pgvector,
port 127.0.0.1:55439, utan hostvolym. Slutdatabas:
`agent3_delivery_2a_2b_step1_authority_final`. Samtliga 189 migrationer
installerades från den slutliga SQL-versionen. Varje DB-svit migrerar
också hela kedjan till sitt eget UUID-schema utan avstängda integritetsregler.

Två kompletta slutkörningar efter återställd mutation: **58/58 godkända,
0 underkända, 0 överhoppade** vardera, 83,961 respektive 66,550 sekunder.
2a: 17 prov/249 assertions; 2b: 30 prov/461 assertions; organisationens
bevarandeprov: 11/18. Totalt 728 genomförda assertions per körning.

Public hade 115 tabeller och 191 rader före och efter VARJE svit och
körning: 189 migrationsrader och två referens-/sekvensrader; domändata 0.
Alla tabellers exakta radantal jämfördes, liksom schemasamling och vector-
extensionens placering i public. Endast respektive eget schema togs bort. Efter båda slutkörningarna
kontrollerades PostgreSQL-versionen (18.6), frånvaro av egna testscheman
och noll public-rader i DeliveryDispatch/DeliveryEvent. Därefter stoppades
och togs endast den egna märkta containern och dess egen anonyma volym bort.

| Körning | 2a-fixturer före städning | 2b-fixturer före städning | 2b: blockerande → väntande PID:n   | Avslutade egna worker-PID:n |
| ------- | ------------------------- | ------------------------- | ---------------------------------- | --------------------------- |
| 1       | 1106                      | 2223                      | 647→646, 650→651, 653→652, 692→691 | 654, 689                    |
| 2       | 1106                      | 2223                      | 767→766, 771→772, 774→773, 813→812 | 775, 810                    |

För 2b var DeliveryDocument=59, Decision=54, Member=110, Event=152,
Dispatch=54, Observation=166 och Principal=58 i respektive egna schema
före städning. För 2a var motsvarande ursprungliga fyra tabeller
36/32/64/61. Samtliga egna scheman saknades efter städning. Även 2a:s fem faktiska
låsväntepar per körning finns i bevisfilen.
`pg_blocking_pids` måste visa just blockerarens PID före barriärsläpp.
Provider-Promise var fortfarande oavslutad och pending=1 när worker-PID:n
avslutades; en retry fick concurrent409, därefter bevisades en acceptans
med samma mejl-ID. Inga andra containeranslutningar avslutades.

[Maskinläsbar DB-bevisning](agent3-utskicksgrind-2b-db-bevis.json) innehåller
samtliga provs assertionstal, schema-ID:n, fullständiga före/efter-inventarier,
fixturrader, PID:n och loggarnas SHA-256.

Byte-negativkontrollen upprepades mot sparad slutlig produktionskod `a2bcac66`.
Endast resursdigestkontrollen i enqueue byttes till `if (false)` lokalt.
2b-09 blev faktiskt rött: `Received promise resolved instead of rejected`
vid utbytt PDF bakom samma nyckel, i stället för DELIVERY_RESOURCE_CONFLICT.
Det var ett beteendefel, inte ett kompileringsfel. Körningen valde endast
2b-09; de andra 29 var därför filtrerade, inte godkända. Därefter återställdes
bara `delivery-execution.ts` från sparad commit och tom diff verifierades.
Mutationen committades eller pushades aldrig. Båda fullständiga gröna
slutkörningarna nedan gjordes efter återställning.

## Verklig CI-kanarie

[Den avsiktligt röda kanarien](https://github.com/yasineken2002-sys/eken/actions/runs/34605274164)
kördes för exakt `a2bcac66331c9f0d2a611530780fbce9b4a58582`, med 2a-17
borttaget i historiken genom `ce62bb61`. Fulla Jest-sviten var grön:
489 sviter och 6066 prov, inga överhoppade. Därefter föll exakt steget
`Verify delivery decision DB assertions actually passed` med:

> delivery-decisions.db.spec.ts: 2a-17 saknas eller saknar godkända genomförda assertions

Övriga egentliga jobb var gröna; den sammanfattande CI passed-grinden blev
också röd eftersom Tests-jobbet var rött. Detta är en exekverad kontroll,
inte en lokal imitation av workflow-koden.

[Den första kanariekörningen](https://github.com/yasineken2002-sys/eken/actions/runs/34604585677)
hade både samma saknade-prov-fel och auditnamnkollisionen. Den senare
rättades, och körningen ovan är det rena kanariebeviset.

2a-17 återställs byteidentiskt från `07ec3540` i en NY vanlig commit,
tillsammans med denna bevisrapport. Ingen historik skrivs om. Endast egen
2b-gren pushas. Därefter verifieras slutlig grön CI för exakt rapporterad
HEAD; direktlänken och HEAD anges i PR-beskrivningen och slutrapporten till
ägaren, utan ytterligare kodändring efter den gröna körningen.

## Separata granskare och åtgärder

- `granska_db`: organisations-FK, immutable historik, transaktioner och
  skrivsamordning. NULL-lucka i SQL-statusjämförelse, aktörs/providerbindning,
  retryintervall och kvittokorrelation rättades. Slutlig läsgranskning utan
  kvarstående blockerande fynd.
- `granska_provider`: providerbevis, tidsgräns och pauser. Sista DB-avläsning
  kompletterades med monoton kontroll efter commit; blankstegs-ID avvisas
  utan kvittorollback; sent fel blir inte falsk motstridig acceptans.
  Granskaren hittade även självlåsning i 2b-26:s testläsning; separat
  clockDb-anslutning används nu. Slutlig produktionsläsning godkänd.
- CI:s befintliga Actor stamping guard upptäckte att fältnamnet actorKind
  även aktiverade den globala auditmekanismen. Den nya behörighetskolumnen
  och dess kommandofält heter nu authorityKind. Ingen global guard eller
  auditkod undantas eller ändras. DB-granskaren godkände separationen;
  2b-18 provar också verklig Prisma-extension under SYSTEM-kontext med
  fortsatt SERVICE-behörighet och rätt principal. Ny Prisma-klient,
  ny isolerad databas, upprepad negativkontroll och två nya fullständiga
  DB-körningar används för slutversionen.
- `granska_facit`: oberoende 30 facit, assertions och CI:s bokstavliga
  17 + 30 ID:n. Simulatorn ändrades från sparat pending-värde till faktiskt
  väntande original-Promise med separat nätanrops-/acceptansräkning.
  FIRST-saknad budget och förfalskad FIRST→RETRY-korrelation fick egna
  assertions. Slutlig läsgranskning utan blockerande designfynd.

Första körningen av nya sviten visade två provfel: pausprovets egen
anslutningsväntan och en ny mätaravläsning skapad efter försegling i 2b-28.
Det senare gav korrekt startkonflikt; fixturen skapas nu före förseglingen.
Inga förväntningar försvagades för att få grönt. Granskarnas läsbesked
ersätter inte de redovisade körresultaten.

## Kvarstående arbete och modellens gränser

Spärren skyddar deltagande skrivare genom DeliveryWrites. Befintliga
produktionsskrivare är fortfarande inte inkopplade: fakturaändring,
kreditering och makulering i invoices.service.ts; avins betalning,
annullering och chargefrikoppling i avisering.service.ts; kredit,
påminnelse, ränta och kundförlust i rent-\*-tjänsterna; chargeändringar i
consumption.service.ts och skrivare av avtal, part, organisation, mätare
samt bedömning. Listan är inte en färdig fullständig 2c-inventering.
2b-28 visar uttryckligen den osamordnade produktionsluckan och att
samordnaren därefter skyddar både frysta och aktuella charge-medlemmar.
Annat obesläktat dokument i samma organisation kan fortfarande skrivas.

Modellen uttrycker API-acceptans hos Resend, inte mottagarleverans eller
läsning. Resends egna leveransretries begränsar det begreppet. Modellen
uttrycker inte säker äldre historik, historisk attest, återkallelse av
redan auktoriserad transport, garanterad klocka/transporttid, eller skydd
mot godtycklig SQL och feldeklarerade skrivmängder i en betrodd port.
Inga verkliga mejl, betalda API-anrop eller produktionsdata har använts.

Steg 2 är inte byggt. Grov uppskattning för verklig fryst rendereradapter,
resursinfrysning och fullständigt providerinnehåll: 450–750 ändrade
produktionsrader och 800–1400 provrader, med osäkerhet kring PDF-metadata,
resursladdning och ordning. Detta är en uppskattning, inte en ny godkänd
uppdelning eller genomförandeorder. Nuvarande pdf.service.ts:135 läser
levande DB och lagring, vilket behöver ersättas i den nya adaptervägen.
Samma återanvändbara determinismkontrakt måste köras mot den riktiga
adaptern, över nya instanser och med alla negativa bytefall. Syntetiska
portprov bevisar inte verklig rendering. Inkoppling, äldre dokument,
2c:s skrivararbete och produktionsmätning återstår separat från steg 1.

Allt förblir inaktivt. Ingen merge eller driftsättning. Stopp efter steg 1.
