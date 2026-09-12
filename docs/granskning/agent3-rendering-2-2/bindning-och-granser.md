# Steg 2.2 — bindning och identitetsgräns

## Kort återupptagningsstatus — 2026-09-12 00:33 UTC

- Egen worktree: `/workspaces/eken-fran-mac-20260909/arbete/agent3-rendering-2-2-real`; gren `codex/agent3-rendering-2-2-real`; utkast [#883](https://github.com/yasineken2002-sys/eken/pull/883).
- Senaste kodcommit: `72226f91bb4254124b0ee699d1d975e815a46f93`. Bas: `0d048101f291cf352a730100ec96d6b042ed98a4`. Basmätning **402/450**.
- Två fullständiga DB-körningar: **67/67 + 67/67**, resultat och radantal nedan. Egen tillfällig databas är borttagen.
- Pågående [CI-kanarie](https://github.com/yasineken2002-sys/eken/actions/runs/34661093684): r22-12 saknas avsiktligt i committen. Kravlistan kräver alla 85 id. Tidigare röda CI-körningar nådde inte rätt kravsteg och är inte kanariebevis.
- Nästa steg: invänta att hela API-sviten passerar och kravsteget uttryckligen fäller r22-12; spara länken, återställ provet med vanlig commit och push, mät bas→HEAD, invänta grön CI för samma HEAD och uppdatera slutrapport/PR.
- Arbetskopian innehåller redan det återställda r22-12-blocket. Vid förlust hämtas enbart blocket `it('r22-12 ...` fram till nästa `it('r22-13 ...` ur `b93b7eb66bc6086d9e117bf30e82f39f97ba3b70:apps/api/src/consumption/delivery-renderer.db.spec.ts`; lägg det före nuvarande r22-13. Återställ inte hela den äldre filen eftersom riggen senare samlats i specen.
- Inget ägarbeslut krävs just nu. Stanna om 450 nås eller nytt ägarbeslut krävs. Ingen merge, aktivering eller 2c.

Det [kompletterade beteendefacitet](komplettering-facit.md) frystes i `b2de5c13`
före implementation och bevarar [basens r22-facit](kontrakt-och-facit.md).
Denna frusna sammanfattning beskriver mekanismen och verifieringen.

## Återanvänt skydd

`DeliveryDecisionCommand.resources/team`, fullständig JSONB-jämförelse av
`DeliveryEvent.request` samt SQL:s `delivery_dispatch_insert` fanns på basen.
Den senare kräver samma transaktion för beslut och dispatch, samma organisation,
dokument och mottagare samt samma manifest/team som i första beslutseventet.
Befintliga append-only-spärrar skyddar beslut, manifest, body och digest.
Ingen ny tabell eller migration behövs för att återskapa detta skydd.

Det nya valfria `rendering`-fältet ingår i samma fullständiga request. Det bär
version, asOf, avsändaradress, logotypens nyckel/MIME/base64 och PDF-miljöns
identitet. `resources` binder hash av logotypbyte och miljöidentitet.
Den verkliga adaptern kräver rendering-kontext. Äldre 2a/2b-kommandon får inga
nya standardfält, och deras JSONB-innebörd ändras inte.

`enqueue` kopierar kommandot innan första await. Förhandsläsningen auktoriserar
och jämför replay innan den läser aktuell snapshot. Ett identiskt redan
committat kommando återger befintlig dispatch utan resurshämtning/rendering.
För kommandon med den nya renderingskontexten körs Chromium utanför skrivtransaktionen.
Äldre kommandon behåller sin tidigare enda transaktion; det bevarar även 2b:s
prover av faktisk delskrivning och rollback. `decide` kontrollerar
snapshot igen, och resurserna kontrolleras vid bindningen. Constraints slås på
omedelbart före commit som tidigare. Ett fel rullar tillbaka beslut/medlemmar/
event/dispatch tillsammans. Konkurrerande identiska förberedelser kan rendera
flera gånger, men bara ett resultat binds; den andra får det sparade resultatet.

## Verklig framställning

`DeliveryRenderer` har inga domän-DB-, lagrings- eller konfigurationsanrop. Den
använder sparat underlag, `PdfService.renderInvoice`,
`AviseringService.renderNoticePdf` (samma HTML-byggare och `generateFromHtml`),
`MailService.buildInvoice/buildRentNotice` och `MailRenderer`.
Fakturamejlets befintliga byggning har lyfts till en gemensam statisk metod;
produktionsanroparen delegerar till den med samma argument och beteende. Avins
befintliga HTML→PDF-sekvens delas på samma sätt. PDF-granskarens regler och
producentregister är oförändrade; dess självtest och verkliga skanning passerar.

SQL-delivery-snapshotens talsträngar avkodas mot Prismas deklarerade skalärtyper.
Datum och tider kontrolleras för kalendergiltighet innan Date konstrueras.
Ogiltiga tal, icke-finit konvertering, förlust av decimalvärde och osäkra heltal
avvisas. Arrayordningen bevaras. Den verkliga renderaren räknar och formaterar
med samma nyttolastbyggare som tidigare.

Identiteten omfattar 2.1:s explicita fil-/paketgräns, adapter/mappningsfilen och dess digestberoende i exekveringsfilen,
genererad Prisma-runtime, Node, Chromium, bibliotek, typsnitt, fontconfig,
lokalisering och deklarerade miljövariabler. Det är ingen påstådd fullständig
applikationsimportgraf. Upplösta filvägar ingår också; beviset lovar inte
portabilitet till en godtyckligt annan installation. Logotypens frysta byte och MIME följer kommandot;
nytt innehåll bakom samma nyckel kan inte ersätta dem vid reproduktion.
Den aktiva kod-/motormiljön läses färskt vid identitetskontroll.

`reproduce` jämför verkligt återframställd fullständig providerbody med den
sparade bodyn och digesten. Den skriver ingenting och ger ingen anropsrätt.
Transportvägen `run` skickar alltid den oföränderligt sparade bodyn och samma
attemptId. Retry efter en redan beviljad start kräver inte ny rendering eller
att dagens domändata/miljö är oförändrade. De befintliga tids- och anropsgränserna
avgör separat om ett omanrop får göras.

## Kvarstående gränser

- Installationen måste vara oföränderlig under framställningen. Hashkontroller
  bevisar inte säkerhet mot en godtyckligt växlande installation mellan kontroller.
- Betrodda renderaren och dess bindningskod är tillitsgränsen. En body/digest i
  SQL är inte i sig ett bevis för korrekt sakligt fakturainnehåll.
- PROVIDER_ACCEPTED är API-acceptans, inte mottagarleverans eller läsning.
- Den dokumenterade patologiska pausen efter sista transportauktorisationen
  (2b-26) kvarstår; reproduktionsbeviset täpper inte till den.
- Ingen produktionsanropare eller flagga har kopplats till denna adapter.
  Äldre dokument, övergång och aktivering hör till senare beställningar.
- Historiskt skäl till att den frysta kontexten inte bands tidigare:
  **INGEN DOKUMENTERAD ORSAK**.

## Kontrollerade utvecklingsfynd

Första kompletta r22-körningen gav 15/15 godkända prov, inklusive byte-identitet
mellan förseglad body och två nya Node-/Chromium-processer. Därefter skärptes
proven med faktisk medlemsändring, blockering i en ny process och SQL som ändrar
body **och matchande digest**. Detta ändrar inga frysta förväntningar.

En samlad körning fångade en kompatibilitetsregression i 2b-01/02: en extra
förberedelseläsning gjorde att äldre kommandons befintliga transaktionssonder
träffade läsningen i stället för skrivningen. Rättningen bevarar den gamla vägen
för äldre kommandon; den verkliga adaptern kräver den nya frysta kontexten.
Varken 2a- eller 2b-provfilen ändrades. Alla 17 2a-prov passerade även vid fyndet.

React Emails verkliga dynamiska import kräver Nodes `--experimental-vm-modules`
i Jest. CI:s provsteg får den inställningen; inga produktionsflaggor tillkommer.
Beteendeproven körs med samma källor och separat ts-jest-transpilation
(`isolatedModules`) för att lämna minne åt Chromium och dess filcache.
Full API-typkontroll körs separat. Tidigare heapavbrott och avbrutna körningar
räknas inte som gröna bevis. Alla tillfälliga scheman städas i den egna databasen.

Negativkontroll: `from: frozen.from` byttes till `from: 'mutation@example.test'`
i den verkliga renderaren. r22-01 föll på avsändarassertionen med exit 1.
Återställning: `git restore --source=b93b7eb66bc6086d9e117bf30e82f39f97ba3b70 --
apps/api/src/consumption/delivery-renderer.ts`. Samma prov passerade därefter.
De 14 ej utvalda proven i dessa två riktade körningar redovisas som otestade,
inte som godkända; de fullständiga körningarna nedan prövar samtliga id.

Resurskontrollens synkrona läsning av Chromium/bibliotek/typsnitt blockerade
eventloopen under konkurrerande rendering. r22-13 fångade en avslutad
5-sekunderstransaktion både lokalt och i CI. Strömmad läsning räckte i ett
riktat prov men inte i helsviten; dessa röda körningar räknas inte som bevis.
Slutversionen läser en hel fil i taget asynkront, med samma ordning och hash.
Inga byte ersätts av cache och identitetsgränsen förblir densamma.

För nya renderingskommandon får en bindning som Prisma uttryckligen avbrutit
med P2028/expired transaction ett enda nytt transaktionsförsök. Det återanvänder
samma kommando och redan framställda body, men kör auktorisering, replay,
snapshotkontroll och färsk resurskontroll igen. Okända fel och gamla kommandon
omförsöks inte; ett fel i andra försöket lämnas vidare. Varje transaktion behåller 5000/2000 ms, och inga transportgrants
eller nätanrop finns här. r22-13 tvingar dessutom en verklig expiration, kontrollerar
noll delrader efter rollback, ett renderanrop, återläst identisk dispatch och
noll transportanrop. Facitets samtidighetsutfall är oförändrat.

Objektskrivningsinventeringen upptäckte fixturens `Unit.create` i en separat
hjälparfil. Riggen har bara en anropare och ligger nu i samma spec som proven,
liksom basens DB-riggar. Ingen inventarierad, granskningsregel eller fryst
provförväntan ändrades för det. Endast egen lokal databas, slumpat privat schema
och syntetiska rader används.

## Frusna körresultat

Produktionskod: `7e17e4e8476fe0429a1e9c60ae31129c2400f3cc`. Lokala körningar inkluderar återställda r22-12; alla 15 id har exakt ett prov i en enda svit.

| Körning | Sviter |       Godkända prov |       Tid |
| ------- | -----: | ------------------: | --------: |
| 1       |    3/3 | 67/67, inga hoppade | 417.693 s |
| 2       |    3/3 | 67/67, inga hoppade | 418.541 s |

2a: 17 oförändrade prov. 2b: 35 oförändrade prov (inklusive fem r21-id). CI kräver även de 18 verkliga r21-proven: totalt **85 id**, exakt en svit/prov per id, godkänt och `numPassingAsserts > 0`.

| Id     | Utfall båda körningarna | Assertions körning 1 / 2 |
| ------ | ----------------------- | -----------------------: |
| r22-01 | GODKÄNT                 |                  17 / 17 |
| r22-02 | GODKÄNT                 |                  12 / 12 |
| r22-03 | GODKÄNT                 |                  55 / 55 |
| r22-04 | GODKÄNT                 |                    7 / 7 |
| r22-05 | GODKÄNT                 |                  14 / 14 |
| r22-06 | GODKÄNT                 |                    3 / 3 |
| r22-07 | GODKÄNT                 |                    3 / 3 |
| r22-08 | GODKÄNT                 |                    5 / 5 |
| r22-09 | GODKÄNT                 |                    6 / 6 |
| r22-10 | GODKÄNT                 |                    2 / 2 |
| r22-11 | GODKÄNT                 |                  12 / 12 |
| r22-12 | GODKÄNT                 |                    5 / 5 |
| r22-13 | GODKÄNT                 |                  12 / 12 |
| r22-14 | GODKÄNT                 |                    5 / 5 |
| r22-15 | GODKÄNT                 |                  16 / 16 |

PostgreSQL **16.14**, pgvector **0.8.2**, egen databas `agent3_delivery_2a_r22_20260911`. Varje svit körde 189 migrationer i ett nytt privat schema. `public` var `{}` före och efter samtliga sviter; vector låg kvar i public.

| Körning | Sviten och dess privata schema                       |
| ------- | ---------------------------------------------------- |
| 1       | r22: `delivery_r22_60d7809bc2e343b38752d83eb1edea07` |
| 1       | 2b: `delivery_2b_74bf5b845da244a491f2a1f1c32e5f2a`   |
| 1       | 2a: `delivery_2a_62452dbdd0064e6f96951f4b91a94a09`   |
| 2       | r22: `delivery_r22_e2df7f14934a487c8c5106697ddb4fc4` |
| 2       | 2b: `delivery_2b_31b99857456c467b843c55011d4fdb6f`   |
| 2       | 2a: `delivery_2a_776ffb98bd444ecf97a58346d1bd07a8`   |

Alla icke-nollradantal före städning nedan är **identiska i båda körningarna**. Övriga tabeller: 0.

| Tabell                 |  2a |  2b | r22 |
| ---------------------- | --: | --: | --: |
| Account                | 102 | 189 |  36 |
| ConsumptionCharge      |  65 | 129 |  25 |
| ConsumptionChargeCheck |  65 | 129 |  25 |
| ConsumptionTariff      |  34 |  63 |  12 |
| CustomerNumberSequence |   1 |   1 |   1 |
| DeliveryDecision       |  32 |  61 |   7 |
| DeliveryDispatch       |   0 |  61 |   7 |
| DeliveryDocument       |  36 |  65 |  12 |
| DeliveryEvent          |  61 | 166 |  12 |
| DeliveryMember         |  64 | 124 |  14 |
| DeliveryObservation    |   0 | 176 |   8 |
| DeliveryPrincipal      |   0 |  64 |  12 |
| Invoice                |  35 |  64 |  10 |
| InvoiceLine            |  66 | 130 |  20 |
| JournalEntry           |  65 | 129 |  25 |
| JournalEntryLine       | 130 | 258 |  50 |
| JournalEntrySequence   |  32 |  63 |  12 |
| Lease                  |  34 |  63 |  12 |
| Meter                  |  34 |  63 |  12 |
| MeterReading           |  65 | 129 |  25 |
| MeterReadingReview     |   0 |   2 |   0 |
| Organization           |  34 |  63 |  12 |
| Property               |  34 |  63 |  12 |
| ReferenceInterestRate  |   1 |   1 |   1 |
| RentNotice             |   3 |   1 |   2 |
| RentNoticeCredit       |   1 |   0 |   0 |
| RentNoticeCreditLine   |   1 |   0 |   0 |
| RentNoticeLine         |   6 |   2 |   4 |
| SyntheticDeliveryClock |   0 |   1 |   1 |
| Tenant                 |  36 |  63 |  12 |
| Unit                   |  34 |  63 |  12 |
| User                   |  35 |  63 |  12 |

Städning: alla privata klienter kopplas ned, sedan barn först: DeliveryObservation → DeliveryDispatch → DeliveryEvent → DeliveryMember → DeliveryDecision → DeliveryDocument. Återstående privat domänschema tas bort med FK-hanterad DROP SCHEMA CASCADE. Proven kontrollerar att schemasamlingen och public-inventariet är oförändrade efteråt.

### Byte-identitet över processer

För varje körning läses snapshot/kommando/body från de sparade besluten. Två nya Node-processer med varsin ny Chromium återskapar exakt samma fullständiga providerbody, inklusive PDF-byte, HTML, text, filnamn och kuvert. Inga sparade rendercacheposter förs till barnen.

| Körning | Förseglare; nya Node-PID | Nya Chromium-PID |
| ------- | ------------------------ | ---------------- |
| 1       | 175622, 185389, 186177   | 185661, 186482   |
| 2       | 195567, 204959, 205757   | 205259, 206044   |

SHA-256 för sparad och båda återframställda providerbody:

- Körning 1, faktura: `a6ccbc927c45ecc92d70ceba1c1b66936785ae02bd97a60e94dbdb3210cc2e2f`.

- Körning 1, avi: `3f852dc60e2e0c5e135afb9c225da7260a9735b31841dc234843b41520877c39`.

- Körning 2, faktura: `ec897413c52d0a810dd3d9dd133a0ca93e77029dcb12324ce5078c18bbfbe47b`.

- Körning 2, avi: `54eca77ff37eabeff14ad1282a0b5f680eb6064ddbe3078b6d012f41b6bcc6ad`.

Olika körningar skapar olika syntetiska beslut och mottagaradresser, så jämförelsen gäller samma beslut inom respektive körning.

### Konflikt och transport

r22-11 byter faktisk deklarerad resursfil A→B, avvisar verklig reproduktion, committar RENDER_IDENTITY_CONFLICT och lämnar snapshot, body och beslutsevent oförändrade. Ingen send tillåts. Efter B→A förblir beslutet blockerat, även i en ny Node-process.

r22-15 separerar detta från tillåtet UNKNOWN-omanrop: syntetisk transport tappar svaret efter acceptans. Ny exekverare använder samma sparade body och attemptId, trots ändrad DB/resurs, utan resursläsning eller rendering. Originalets syntetiska mejl-ID återkommer; en acceptans totalt. För tidigt och efter 23 timmar nekas omanrop. Inget Resend-anrop gjordes.

### Lokal körform

De tre DB-specarna kördes seriellt med TZ=UTC, NODE_ENV=test, NODE_OPTIONS=--experimental-vm-modules, Node 24.11.1 och `--max-old-space-size=1400 --expose-gc`. Lokala ts-jest-inställningar: isolatedModules=true, ES2022/CommonJS, experimentalDecorators, emitDecoratorMetadata, esModuleInterop och react-jsx. CI kör samma isolerade ts-jest-transpilation i ordinarie jest.config.ts och full typkontroll separat.

Jest-rapporternas kontrollsummor (rapporterna är tillfälliga, inte extra committade beviskopior):

- Körning 1: `de6f38de27dc507c1728cf5fd68438b0b0a2764c194b74c9dfb2840b4fa8a8a9`.

- Körning 2: `7ac0ffcf8541fb209c0ab476760d20157cd648dc4070b0456bf912bfcaf68bef`.

Efter de två gröna körningarna verifierades 0 privata scheman, 0 public-tabeller och 0 andra anslutningar. Den egna tillfälliga databasen togs därefter bort; katalogfrågan gav 0 kvarvarande databaser med namnet.

## Basmätning och bevismängd

Godkänd räknare och klassificeringsregler är oförändrade. Arbetskopian mäts
inklusive index och ospårade filer med:

```sh
node scripts/production-lines.mjs 0d048101f291cf352a730100ec96d6b042ed98a4
```

Utfallet är **402 produktionsrader**, 0 binärfiler och inga importspärrfel.
Slutmätningen görs med samma bas och `HEAD`, aldrig `HEAD^`. Tak: 450.

Tillförda bevis i slutträdet: cirka **0,06 MB**, **0 binärfiler**. Endast
provfilen, dess importerade processhjälpare, fryst facitkomplettering och denna
sammanfattning tillkommer. Befintliga 2.1-resurser återanvänds. Inga PDF-/PNG-serier,
fontmiljöer, licenskopior eller upprepade körloggar har lagts till.

2a-provfilen är identisk med basen, SHA-256:
`764fee9c3753dd8ea4bd9d288ed2b8a88b7c3ec29c33c324a256e85da9fa7f62`.
Även 2b- och r21-provfilen samt samtliga migrationer är oförändrade.

Kontrollerat på basen `0d048101`: `delivery-decisions.ts:26` bär resources/team och
`:177` jämför hela request; `delivery-execution.ts:77` binder beslut och dispatch;
`20260911150000_delivery_execution/migration.sql:56` kräver samma transaktion
och samma manifest/team. Nytt är endast den frysta valfria renderingskontexten,
adaptern till de gemensamma renderarna och den förberedda framställningens
kontrollerade bindning. Ingen extra tabell eller migration infördes.

#877, #878, #879, #881 och #882 hade oförändrade head-SHA vid slutkontrollen.
Endast `codex/agent3-rendering-2-2-real` har pushats. PR-bas:
`codex/agent3-rendering-2-2`. Ingen merge, aktivering eller 2c.

CI-körningen på `7e17e4e` passerade samtliga fyra leverans-/renderingssviter
(2a, 2b, r22 och verkliga r21) men avbröts senare i API-sviten med V8 heap-OOM
vid cirka 4,1 GB. Den är inte kanariebevis: kravsteget nåddes aldrig.
Jest får därför `isolatedModules: true`, samma transpilation som de två lokala
gröna körningarna. CI:s fullständiga Typecheck-jobb, samtliga prov och kravsteg
ligger kvar. Ingen heap-, tids- eller radbudget höjdes.
