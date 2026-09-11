# Agent 3, PR 2a — beständiga leveransbeslut

Ägarens nya tak är 650 tillagda plus borttagna produktionsrader inklusive
Prisma och SQL. Den tidigare stoppstatusen är historisk. PR #878 fortsätter
mot `codex/agent3-debiteringsgrind`, bas
`9f879291dd039e404ba80b7266fbd53842a0b42b`. #877 förblir fryst.

## Kontrakt före SQL

[Tillstånds- och övergångstabellen](agent3-utskicksgrind-2a-tillstand.md)
sparades före schemaarbetet. [Registreringslösningen och de fjorton frysta
facitraderna](agent3-utskicksgrind-2a-bevisplan.md) sparades dessutom i
`6a9a54172b6b925662de8658e1cf0ba28c27ea61` före första schema-/SQL-ändringen.
Den preciserar den tidigare öppna registreringscirkeln och fixturestädningen.

Frånvaro av dokumentrot ger `HISTORY_UNVERIFIED`; frånvaro av beslut under
en registrerad rot betyder bara att den nya modellen inte fattat beslut.
`DECIDED`, `REVOKED`, `SENDING`, `UNKNOWN`, `PROVIDER_ACCEPTED` och
`FAILED_NO_ACCEPTANCE` är beständiga händelsevärden. Senaste revisionen är
tillståndet. Ursprungligt godkännande skrivs aldrig om av ett senare utfall.

## Registrering, identitet och integritet

`DeliveryDecisions.register` äger transaktionen och genererar dokumentets ID.
Den skriver först dokumentroten och därefter själva fakturan/avin med samma
ID och organisation. Den accepterar ingen transaktion, callback, upsert eller
befintlig dokumentidentitet. Extra ID-/organisationsfält i runtime-data
överskrivs med de internt bundna värdena. Inga befintliga skapandevägar anropar
primitiven. Prov 2a-01, 2a-13 och 2a-14 använder just denna implementation.

Rotens trigger låser Invoice och RentNotice i fast ordning och prövar frånvaro
först efter väntan. Därmed kan inte heller en redan pågående äldre INSERT
registreras som kontrollerat nytt. Uppskjutna organisationsbundna FK kräver
verkligt dokument vid commit. Typbindningen är XOR: exakt en faktura eller avi,
med samma stabila ID. Nullable typalternativ utgör ingen nullable unikhetslucka.
Fel under skapandet rullar tillbaka både rot och verkligt dokument.
En riktig probe visade att den installerade Prisma 5.22-klienten kan dölja
ett deferred COMMIT-fel trots PostgreSQL-rollback. Därför kör den ägda wrappern
`checkConstraints(tx)` sist. Framtida tx-ägare måste anropa samma slutkontroll
EFTER alla sina skrivningar; metodresultat inne i en övertagen tx är preliminära.
Prov 2a-17 skriver verkligen rot och dokument med olika ID:n och kräver att
ägd registrering rapporterar FK-felet och att båda rullats tillbaka.

Beslutets UUID är även utskicks-ID, en till en. SENDING-eventets UUID är
försöks-ID. Originalpositionen följer dokumentroten och dess oföränderliga
originalacceptans, aldrig mottagare, version, kommandonyckel eller Redis.
Omsändning har eget beslut, eget utskicks-ID, uttryckligt skäl och länk till
det accepterade fakturaoriginalet. Avispecifik omsändningsfunktion införs inte.

Unikhet i PostgreSQL: kommando per organisation, revision per beslut,
sekvens per organisation/dokument samt medlem per organisation/dokument/
utskick/charge. Samma nyckel med annan JSONB-innebörd ger `KEY_CONFLICT`.
Exakt replay återläser historiskt beslut och aktuellt tillstånd utan ny rätt.
Inga gamla unika nycklar utvidgas. De tre nya indexen på befintliga tabeller
är kompletterande supernycklar över redan unika, icke-nullbara ID:n; ingen
sentinel-backfill och inga historiska beslutsstandardvärden införs.

Beslut och medlemmar skapas under samma organisationslås som charge-grinden.
Medlemmar måste infogas i beslutets skapandetransaktion, före första event.
Första eventet jämför hela mängden i båda riktningarna. En uppskjuten kontroll
kräver komplett försegling. Fyra nya tabellers UPDATE, DELETE och TRUNCATE
avvisas. Senare extra INSERT av medlem avvisas också. Historiken kan därför
inte frigöra originalposition eller gamla nycklar genom vanlig SQL-skrivning.

Affärsauktorisering måste gå genom `decide`/`transition`: där körs aktuell
`requireChargeCheck` för varje serverhärledd charge vid beslut och start.
Rå SQL skyddar kopplingar, full medlemsmängd, historik och övergångsstruktur;
den duplicerar inte TypeScripts fullständiga granskning/policy/regelversion.
SQL:s SENDING-kontroll jämför dessutom hela aktuella domänsnapshoten.

## Snapshot och startkontrakt för 2b

Snapshoten innehåller dokumentet, samtliga rader, krediter inklusive deras
rader, mottagarens kontakt-/adressuppgifter, tryckta organisations- och
betalningsuppgifter, mall/varumärkesval, avtal, enhet och fastighet, charges,
mätare, avläsningar, bedömningar samt senaste check med dess fulla evidens.
SQL konverterar tal rekursivt till exakta strängar innan JavaScript läser dem.
Fingerprint är SHA-256 över PostgreSQL:s JSONB-representation. Därför räcker
varken `updatedAt` eller en enda dokumentrad som innehållsidentitet.

Snapshoten är avsiktligt konservativ: även en relevant källändring som inte
ändrar tryckt belopp kan kräva återkallelse och nytt beslut. Den är inget
bevis på redan framställda byte. `artifactEvidence: UNVERIFIED` säger detta
uttryckligt; `logoStorageKey` intygar exempelvis inte logotypens faktiska byte.

`decide(command, tx)` kan senare dela commit med en outboxavsikt. Ingen outbox
finns här. `transition(SENDING)` med ägd transaktion ger starttillstånd först
efter commit. Övertagen transaktion ger alltid `startGranted: false`, även
om anroparen senare committar; replay kan inte omvandla detta till starttillstånd.
Verkställande anrop måste använda den ägda transaktionen enligt 2b-kontraktet.

## UNKNOWN och mänsklig utredning

DECIDED/SENDING reserverar dokumentet. UNKNOWN blockerar både nytt original
och omsändning med `OUTCOME_UNKNOWN_REQUIRES_HUMAN`, även efter version,
mottagare, ny kommandonyckel eller tjänsteomstart. Ett kommando för det beslut som är UNKNOWN kan
återläsas men svaret anger blockeringen. Replay av ett annat, redan avslutat
beslut visar det beslutets eget tillstånd; det ger ingen ny start- eller
beslutsrätt för dokumentet. Ingen tidpunkt löser tillståndet.

Utredningen måste identifiera samma försök, bevara leverantör/kvitto/referens,
ärende, källa och konkret observation. Positivt slutbevis har `ACCEPTED`;
negativt slutbevis kräver `NOT_ACCEPTED_FINAL` och `finalityReference` som
underbygger att fördröjd acceptans inte längre kan inträffa. Timeout, bounce,
utgången dedupliceringstid eller tomt sökresultat räcker inte. Utan tillförlitligt
slutbevis kvarstår UNKNOWN. Interna metoder validerar detta beviskontrakt;
verifiering hos leverantören och en utredningsvy byggs först senare.

REVOKED och FAILED_NO_ACCEPTANCE avslutar bara det beslutets reservation.
En uttrycklig ny begäran prövas med aktuellt underlag och får nytt beslut/
utskicks-ID. Ett aldrig accepterat original får försöka som ORIGINAL igen;
ett redan accepterat original kan endast följas av legitim fakturaomsändning.

## Övergångsrisk före beställning av 2b

Kodspårningen är kontrollerad på PR-basen: `invoices.service.ts:1630,1671`
avstår vid VOID/PAID; `:1699` använder statisk `invoice-send-${id}` och
`:1701–1711` ändrar DRAFT till SENT eller registrerar ännu ett SENT-event.
`avisering.service.ts:947` avstår vid sentAt/SENT och `:990` sätter SENT efter
mejlköläggning. `mail.queue.ts:86–103` har fem försök, retention och Bull-jobb-ID.
Det verkliga leverantörsanropet ligger i `mail.worker.ts:89`. SENT är således
inte bevis för leverantörsacceptans, mottagarleverans eller läsning.

2a och 2b kan byggas men kan **inte säkert aktiveras för äldre dokument enbart
på dessa uppgifter**. Registreringen vägrar överta dem. Ingen automatisk
backfill eller historisk attest finns. Verkligt innehåll i äldre köer,
bevarade leverantörskvitton, pågående anrop och osäkra försök har inte
inventerats i drift och kan hindra aktivering. **INGEN DOKUMENTERAD ORSAK**
anges för historiska luckor när underlag saknas; kodens beteende får inte bli
en påhittad förklaring till en enskild gammal post.

En säker övergång behöver samordna samtliga äldre producenter, PDF-/mejlworkers,
cron, manuella retries och utlämningsvägar. Väntande/aktiva jobb får inte få
skicka efter den nya modellens reservation. Osäkra anrop måste korreleras och
utredas; att tömma Redis bevisar inte att en extern effekt uteblivit. Återgång
mellan gammal och ny väg får heller inte förlora den stabila originalpositionen.

Nya dokument som skapats genom primitivens transaktion **kan under angivna
villkor införas separat**: samtliga gamla vägar måste då hållas borta från
just dem, med beständig avgränsning och verifierade övergångsprov. Äldre
dokument får stanna i särskild hantering. Detta är en möjlig strategi,
**inte verifierat genomförbar i denna PR**. Registreringslåsen kan dessutom
påverka äldre skrivare eller ge deadlock när primitivens anrop senare införs;
låsordning och kostnad måste prövas vid inkopplingen.

Inga triggers läggs på gamla tabeller. Förseglingen är ingen allmän spärr mot
senare källdokumentändringar; sådana upptäcks vid nästa beslut/start. Inte
heller tidigarelagd constraint-kontroll via SET CONSTRAINTS eller osamordnade
äldre innehållsskrivare gör snapshoten till bytebevis. Dessa gränser kräver
2b/2c:s samordnade leverans, och är inte lösta genom en grön 2a.

## Vad modellen avsiktligt inte uttrycker — och varför

- Mottagarleverans och läsning: PROVIDER_ACCEPTED intygar endast acceptans.
- Verkliga PDF-/mejl-/logotypbyte, rendererutfall och lagringsattest: de har
  ännu inte framställts eller bundits till beslutet. Detta krävs i 2b.
- Äldre dokumenthistorik: saknad rot ger HISTORY_UNVERIFIED; DRAFT, utebliven
  SENT och äldre köstatus skapar inget godkännande.
- Betrodd leverantörsverifiering, automatisk kraschhantering och mänskligt UI:
  här finns bara beständiga korrelations-/övergångskontrakt. Proven använder
  tydligt syntetiska kvitton och gör inga leverantörsanrop.
- Automatisk retry, timeoutupplåsning eller annan nyckel för UNKNOWN: dessa
  skulle påstå något som underlaget inte bevisar.
- System-/cronprincipal: endast aktiv behörig organisationsbunden människa
  accepteras. Saknad människa ersätts inte med en godtycklig default.
- Publiceringspolicy, publika PDF-rutter, gamla köjobb och inkoppling: hör till
  senare godkänd 2c. Ingen sådan väg använder de nya metoderna i 2a.
- Rättelse av felaktig debitering eller dokument: separat obeställd rättelseväg.

Tystnad i dessa delar är inget implicit godkännande.

## Verifiering och granskning

Den slutliga lokala produktionsversionen sparades i
`2a28acbd91f2de9cd3800637f03ba8153615edea` före negativkontrollen.
Alla fjorton frysta facitrader samt tre kompletteringar kördes mot riktig
PostgreSQL utan Redis, köjobb, leverantörsanrop eller betalda AI-anrop.

| Riktning | Implementation | Oberoende DB-prov | Båda körningarna |
| --- | --- | --- | --- |
| A: nytt kontrollerat original | `delivery-decisions.ts:74,185`; SQL `delivery_register:73` | 2a-01, spec:475 | Tillåtet, exakt ett beslut med full mängd |
| B: nytt första original efter acceptans | SQL `delivery_ready:158–165` | 2a-02, spec:502 | ORIGINAL_ALREADY_ACCEPTED, noll radtillväxt |
| C: avsiktlig fakturaomsändning | SQL `delivery_ready:160–166`; metod:185 | 2a-03, spec:515 | Två successiva egna beslut/försök; avi nekas |
| D: UNKNOWN | SQL `delivery_ready:156`; replay metod:147–156 | 2a-04, spec:540 | Båda operationerna blockerade efter version/nyckel/omstart |

Övriga frysta facit: 2a-05 nyckelinnehåll/replay, 06 nedkoppling/omstart,
07 konkurrerande original, 08 återkallelse mot start i båda ordningar,
09 återkallat/slutligt misslyckat följt av nytt beslut, 10 riktiga
korskopplingar, 11 full/förseglad mängd, 12 övergångar och beviskrav,
13 atomisk rollback, 14 äldre dokument och registreringsrace. Alla gröna.
Kompletteringar 15 avtalsmottagare utan charges, 16 snapshotmutationer,
17 verklig uppskjuten FK-förlust genom ägd registrering: alla gröna.

Den egna nya tomma databasen `agent3_delivery_2a_20260911_final` fick hela
kedjan: **188 migrationer, varav en ny i 2a**. En tidigare egen utvecklings-DB
`agent3_delivery_2a_20260911_6a9a5417` användes under felsökningen; ingen
befintlig kund-/applikationsdatabas ändrades. Slutbevisen nedan gäller samma
slutverifieringsdatabas och samma återställda produktionskod.

| Mätning | Körning 1 | Körning 2 efter negativkontroll |
| --- | ---: | ---: |
| Godkända / hoppade prov | 17 / 0 | 17 / 0 |
| Tid | 41,012 s | 28,745 s |
| Public före / efter | 190 / 190 | 190 / 190 |
| Egna schemas rader efter prov, före städning | 1106 | 1106 |
| DeliveryDocument / Decision / Member / Event före städning | 36 / 32 / 64 / 61 | 36 / 32 / 64 / 61 |
| Eget schema efter städning | saknas | saknas |
| Faktiskt blockerande anslutningspar | 5 | 5 |

Public-baslinjens 112 tabeller var oförändrade: 188 migrationsrader och två
migrationsskapade referens-/sekvensrader; alla övriga tabeller tomma. Egna
scheman började med samma migrationsskapade två rader och tomma fixturtabeller.
Fixturraderna räknades innan endast respektive eget UUID-schema togs bort.
Schemaförteckning, public-tabellmängd och varje public-radantal jämfördes före/
efter; vector låg kvar i public. Inga produktionsregler stängdes av för städning.
Fullständiga radantal, schema-ID:n, anslutnings-PID och facitstatus finns i
[DB-beviset](agent3-utskicksgrind-2a-db-bevis.json).

Racerna hade separata enanslutningsklienter och överlappande transaktioner.
`pg_blocking_pids(secondPid)` måste innehålla just första deltagarens PID
innan barriären släpptes. Legacy-racet tar inget nytt organisationshjälplås:
den äldre verkliga dokumentinsättningen måste orsaka registreringens väntan.
Omstart betyder nedkopplad skrivklient och ny klient/tjänsteinstans, inte en
simulerad Redis-reset. Tidsprovet visar en kort faktisk tidsförflyttning,
inte ett tim-/dygnslångt uthållighetsprov; modellen har ingen timeoutövergång.

Negativkontrollen ändrade tillfälligt endast
`apps/api/prisma/migrations/20260911120000_delivery_decisions/migration.sql`:
medlemsförseglingen i `delivery_member_insert` togs förbi. Det namngivna
**2a-11** föll på `Received promise resolved instead of rejected`; den tredje
riktiga medlemmen hade accepterats. Detta var ett beteendefel, inte ett
kompileringsfel. Endast denna fil återställdes från ovanstående commit med
`git restore --source=2a28acbd91f2de9cd3800637f03ba8153615edea -- <fil>`.
Diffen verifierades tom och körning 2 blev helt grön. Förbikopplingen committades
eller pushades aldrig. De andra 16 proven var avsiktligt utelämnade i just
den namngivna negativkontrollen, inte i de två fullständiga körningarna.

CI:s nya steg i `.github/workflows/ci.yml:155` läser API-svitens riktiga
Jest-rapport. Alla fjorton identifierade facit måste finnas med godkänd status;
sviten och varje tilläggsprov måste också vara godkända. Saknad filträff, noll
assertions och hoppat prov avvisades dessutom lokalt med samma CI-kod och den
riktiga rapporten som grund. Faktisk CI-exekvering på slutlig pushad HEAD
redovisas med länk i PR-beskrivningen/slutrapporten; inget tidigare CI-resultat
används som bevis för en annan HEAD.

Slutlig API-typecheck gick grönt med heap 2600 MB; den första körningen med
1800 MB avbröts av heapgränsen. Riktad ESLint och `git diff --check` gick grönt.
Före Jest/typecheck kontrollerades processer; ett tungt jobb kördes åt gången.
Hela testsviten körs av CI.

Tre separata granskare invände mot kontrakt, diff och prov:

- `integritet_2a`: försegling vid commit, lease/tenant-bindning, requestens
  organisations-/nyckel-/försöksbindning och avi-kreditrader rättades. Granskaren
  reproducerade dessutom Prisma-felet i eget kortlivat schema; slutkontrollen
  och 2a-17 täcker det. Schemat raderades efter proben.
- `tillstand_2a`: starttillstånd före caller-commit rättades; aktuella källrader
  lades i snapshoten, och negativt slutbevis fick uttrycklig finalitet.
  Gränsen mellan SQL-integritet och aktuell affärspolicy är dokumenterad.
  Replay-texten preciserades till det återlästa beslutets egen UNKNOWN-status.
- `provfacit_2a`: hjälplåset togs bort från legacy-racet; felkopplingsprov kräver
  specifikt medlems-/FK-fel; delvis utelämnad mängd och självkonsekvent otillåten
  övergång prövas. Nedkoppling, schema-baslinje, städning vid frånkopplingsfel,
  snapshotmutationer och ägd slutkontroll fick egna assertions.

Inga kvarstående blockerande fynd rapporterades efter omläsningarna.
Granskarnas läsning ersätter inte de ovanstående exekverade DB-proven.
Öppna frågor gäller 2b/2c:s betrodda byte-/leverantörsbevis, principaler,
kapacitets-/låsordning och övergång från äldre flöden enligt avsnitten ovan.

## Omfattning och stopp

Mätt som tillagda PLUS borttagna rader mot den frysta PR-basen: applikationskod
267 + SQL 281 + Prisma 73 = **621 + 0**. CI-kontroll **14 + 0** räknas också
konservativt i produktionstaket: **635 ändrade produktionsrader av 650**.
Tester **1324 + 0** redovisas separat. Dokumentationens exakta diffstat anges
i slutrapporten efter att denna rapport färdigställts.

Endast 2a levereras. Ingen modulregistrering eller anrop från skapandevägar,
controllers, workers, cron eller utskicksproducenter finns. Inga funktionsflaggor
aktiverades, inga rutter tillkom och inga nya triggers lades på deras tabeller.
Ingenting mergas eller driftsätts; 2b, 2c och rättelsevägen kräver nästa besked.
