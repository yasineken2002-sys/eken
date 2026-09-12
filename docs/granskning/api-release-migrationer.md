# Agent 3: migrationsstudie

## Produktionsunderlag — separat från syntetiska prov

Läsning 2026-09-12 kl. **15:01:06.655844 UTC**, repeatable-read/read-only,
snapshot `30140:30140:`, statement_timeout 15 s, lock_timeout 2 s,
idle-in-transaction-timeout 30 s, avslutad med rollback.
API-tjänstens privata databasidentitet jämfördes i minnet med Postgres-tjänstens
databas, användare och autentisering samt den publicerade TCP-proxyn.
Jämförelserna stämde. Inga anslutningssträngar eller hemligheter sparades.
Projekt `poetic-strength`, miljö `production`, API `eken`, databas `railway`.
Servern var primär PostgreSQL **18.6 (Debian 18.6-1.pgdg13+2)**; TLS krävdes.
[SQL-frågorna och transaktionsramen](api-release-production.sql) innehåller bara
metadata/aggregat. Ingen kundrad hämtades.

| Tabell            | Exakt COUNT | Statistikens reltuples | Heap byte | Index byte | Total byte |
| ----------------- | ----------: | ---------------------: | --------: | ---------: | ---------: |
| Organization      |           2 |                      1 |      8192 |      98304 |     114688 |
| Meter             |           1 |             okänt (-1) |      8192 |      65536 |      81920 |
| MeterReading      |           0 |             okänt (-1) |         0 |      40960 |      49152 |
| ConsumptionCharge |           0 |             okänt (-1) |         0 |      40960 |      49152 |
| Invoice           |           0 |             okänt (-1) |         0 |      98304 |     106496 |
| RentNotice        |           2 |                      2 |      8192 |     180224 |     196608 |
| RentNoticeLine    |           0 |             okänt (-1) |         0 |      32768 |      40960 |

MeterReadingReview, ConsumptionChargeCheck, DeliveryDocument, DeliveryDecision,
DeliveryMember, DeliveryEvent, DeliveryPrincipal, DeliveryDispatch och
DeliveryObservation **saknades**. De redovisas inte som tomma tabeller.
Inget behörighetsfel eller timeout inträffade. Storlekarna är katalogmätningar,
reltuples är uppskattning; COUNT är exakt inom snapshoten.

184 migrationer var lyckat tillämpade och **samtliga 184 checksummor matchade
den frysta basens filer**. En ytterligare historisk post var uttryckligen
rolled_back: `20260429222436_tenant_email_unique`, applied_steps_count=0,
rolled_back_at 2026-04-29 23:52:44.049441 UTC. Ingen oavslutad, icke återställd
migration fanns. De fem studerade migrationerna var inte tillämpade.
Historiskt skäl till den återställda posten: **INGEN DOKUMENTERAD ORSAK** i
det avgränsade läsunderlaget; denna studie klassar inte om historiken.

Samtliga 47 undersökta index var valid/ready, samtliga 155 undersökta constraints
validerade. Befintliga PK-index på id var giltiga för Organization, MeterReading,
ConsumptionCharge, Invoice och RentNotice. De nya unika nycklarna innehåller
dessa globala id. Dubbletter för (organizationId,id) var exakt 0 i de fyra
berörda befintliga dokument-/förbrukningstabellerna. Orphan MeterReading→Organization,
ConsumptionCharge→MeterReading och korsad organisation mellan charge/reading var 0.
Tomma child-tabeller gör dessa sista kontroller triviala i just snapshoten;
det är inget löfte om framtida data. `append_only_guard()` fanns.

Låsaggregatet visade 76 beviljade AccessShare-lås och inga väntande lås i den
undersökta databasen; **de egna läsningarnas lås ingår**. Sex andra sessioner
var synliga, ingen blockerad och ingen med transaktion äldre än 30 sekunder.
Det är ett ögonblicksvärde, ingen mätning av normal belastning.

## Migrationsmängd och risk per fil

GitHubs kompletta PR-fillistor omfattade 23/23, 27/27, 37/37, 11/11 respektive
14/14 filer. Exakt base…head-diff gav en tillagd migration per PR. Filerna
lästes ur respektive head, inte ur dagens main eller en gammal inventering.
De fördes inte in i arbetsgrenen och ändrades inte.

| PR   | Exakt head                               | Migrationskatalog                           | SHA-256                                                          |
| ---- | ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| #861 | 46c77508c52b38439b26cb47b8815991301fec88 | 20260908203000_meter_reading_review         | a2322a881d3714e7b34b5616d0bfee8d995d2619ffdb836e318eab42cbedd25d |
| #864 | 82e4c4a0bfd022dd6855d553d6ea8b301e351c41 | 20260909090000_consumption_review_follow_up | 6acb35e6a626fb8313d218b5161121cd04823b336f3b01c9593bbb85c5e19aa4 |
| #877 | 9f879291dd039e404ba80b7266fbd53842a0b42b | 20260910160000_consumption_charge_gate      | b8f9a1d96353c988c4eaf4cd02439ff6bb91d1541e0c535c36bbae31228bf472 |
| #878 | 0973272d5eb8f6f8285ec8c98f039a47f6ec568b | 20260911120000_delivery_decisions           | 9f0cce76b95d7c5eb4a950145a33004dde4b5157092ebbf39507eca1be05c80b |
| #879 | 5ae9906b152307eae0d79eec719d4303a042742c | 20260911150000_delivery_execution           | 50435b76059ad3f6269d50aad5c6e083de57dc9c4a27180bde5d5f38962a1f8d |

Exakta PR-baser i samma ordning:
`a16b2e33d17bfd8688cc1f41e3a16bac99ff0fc4`,
`d22d1fbd910f6b491d6010689f379e951912f049`,
`3fa4b55128143d5bd70f696178679f2a99f22f29`,
`9f879291dd039e404ba80b7266fbd53842a0b42b`,
`0973272d5eb8f6f8285ec8c98f039a47f6ec568b`.

| Fil / kodbelagd risk                                                                                                                                                                                     | Rekommendation                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #861 SQL:19 bygger vanligt MeterReading-index (SHARE); :22–23 FK-lås även på Organization/MeterReading; :26 kräver append_only_guard. Ingen explicit BEGIN.                                              | Datavolymen är liten i snapshoten, men blockera inte på obundet låsväntande. Kontrollera aktuell PK, transaktioner och sessionsgränser inför drift. Syntetiskt databasavbrott verifierar rollback för faktisk Prisma-anropsform; avsaknad av BEGIN är inget separat bevis. |
| #864 SQL:2–7 är en ALTER TABLE Organization med ACCESS EXCLUSIVE. Konstanta defaultvärden kräver ingen stor backfill, men låset stoppar även läsningar.                                                  | Dränera långlivade transaktioner, även läsare. Ta hänsyn till att nya läsningar kan köas bakom väntande DDL.                                                                                                                                                               |
| #877 SQL:4 ändrar MeterReadingReview; :5–6 bygger ConsumptionCharge-index med SHARE; :44–51 installerar skrivtriggers. SQL:33–42 serialiserar även gamla skrivningar per organisation efter migrationen. | Högst samtidighetsrisk: migratorns Charge→Reading-låsordning korsar gamla recordReading:s Reading→Charge. Använd en ägarstyrd övergång utan samtidiga gamla skrivtransaktioner och verifierade tidsgränser. Ingen automatisk övergång till CONCURRENTLY föreslås.          |
| #878 SQL:3–5 bygger vanliga Invoice/RentNotice/Check-index och skapar FK/triggerkontrakt. SQL:76:s globala SHARE ROW EXCLUSIVE gäller framtida register(), inte själva migrationen.                      | Skilj migrationslåsen från den senare registreringens runtime-lås. Migrationen ger inte äldre dokument grund och kopplar inte in utskicksmekanismen.                                                                                                                       |
| #879 SQL:5 binder Organization; :20 ändrar DeliveryEvent med ACCESS EXCLUSIVE; :107–195 ersätter eventfunktionen. HUMAN-default bevarar utelämnat authorityKind, SERVICE har nya krav.                   | Prova framåtschema med den faktiskt körande gamla appen. Det ersätter inte framtida inkopplingsprov av DeliveryDispatch, providerutfall eller hela #878-kontraktet.                                                                                                        |

#877–#879 har uttrycklig BEGIN/COMMIT; #864 är en enda ALTER-sats.
Prismas faktiska felutfall och katalog avgör återställningen per fil.
PostgreSQL kan behandla flera satser i ett simple-query-meddelande som en
gemensam implicit transaktion även utan BEGIN.
[PostgreSQL: flera satser](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-MULTI-STATEMENT).
Vanligt CREATE INDEX tar SHARE; starkare DDL-lås kan tillkomma.
[PostgreSQL: låslägen](https://www.postgresql.org/docs/18/explicit-locking.html).

## Syntetisk metod och mätresultat

Prisma **5.22.0**, PostgreSQL **18.6 (Debian 18.6-1.pgdg12+2)**,
egen container `agent3-api-release-pg`, endast loopbackport 55483.
Image: `pgvector/pgvector@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a`.
Syntetiska anslutningsuppgifter finns endast i riggen. Ingen fsync-/WAL-
avstängning användes. Senare testdatabaser fick verbose serverfel för SQLSTATE.
184 basmigrationer applicerades med verklig Prisma på rena utgångsdatabaser.
De fem PR-filerna extraherades oförändrade till temporära Prisma-kataloger.
Relationsriktiga fixturer utgick från produktionsaggregaten: 2 organisationer,
1 mätare, 0 avläsningar/debiteringar/fakturor och 2 avier, med nödvändiga
syntetiska Property/Unit/Tenant/Lease-föräldrar. Inga produktionsrader kopierades.

Varje felsond fick en egen kopia av rätt migreringsprefix. Normal körning,
400 ms lock_timeout, pg_terminate_backend, SIGTERM till klientgruppen,
vanlig omkörning och katalog efter fel mättes. Katalogjämförelsen omfattar
relationer, kolumner/defaults, index valid/ready, constraints, triggers,
funktionskroppar, typer/enumetiketter samt separata \_prisma_migrations-poster/checksummor.
Icke-destruktiva gamla API-läsningar samt riktiga recordReading-skrivningar
kördes samtidigt i normala sonder. Ingen e-post/provider eller produktions-API
anropades. HTTP/worker/rendering/utskick är inte kompatibilitetsbevisade här.

Två rena utgångsdatabaser: `api_release_1789229757_a` och
`api_release_1789229757_b`. Slutfört **2026-09-12 16:47:58.748418 UTC**.
A fortsatte från ett katalog- och radantalsverifierat tvåmigrationsprefix efter
rättning av riggens cykelbarriär; dess åtta redan avslutade sonder behölls.
En senare felkodskontroll kompletterades med serverlogg, och just den sonden
kördes om i en ny klon. B kördes därefter från en ny tom databas.
Avbrutna förprov och den felplacerade katalogläsningen räknas inte som bevis.

| Exakt radantal, båda omgångarna | Före | Efter fem migrationer | Efter gamla API-sonden |
| ------------------------------- | ---: | --------------------: | ---------------------: |
| Organization                    |    2 |                     2 |                      2 |
| Meter                           |    1 |                     1 |                      1 |
| MeterReading                    |    0 |                     0 |                      1 |
| ConsumptionCharge               |    0 |                     0 |                      1 |
| Invoice                         |    0 |                     0 |                      1 |
| RentNotice                      |    2 |                     2 |                      2 |

**40 sonder:** fem filer × normal/lock_timeout/backendavbrott/SIGTERM × två
omgångar. Varje normalfall och den avslutande framåtschemaproben körde verklig
gammal recordReading (inklusive idempotent upprepning), findMeter/findCharge,
avi-läsning/uppdatering samt faktura-create/read med gamla Prisma-klienten:
7 positiva assertions per sond, 12 lyckade sådana sonder totalt.
Gammal tjänstekod och Prisma-schema kontrolleras mot den frysta basen.

Millisekunder nedan är **A / B**. Totalen omfattar Prisma-start, SQL och den
avsiktliga barriären; den är inte ren SQL-exekveringstid. Väntan och beviljad
låshålltid är separata observerade spann från pg_locks/pg_blocking_pids.

| PR   |             Total ms | Väntspann på barriären ms | Beviljat lås på barriärens mål, spann ms        |
| ---- | -------------------: | ------------------------: | ----------------------------------------------- |
| #861 | 77811.500 / 4628.406 |         645.347 / 305.465 | MeterReading SHARE: 12.445 / 0 (en observation) |
| #864 | 11918.392 / 4425.580 |         302.849 / 305.863 | Organization ACCESS EXCLUSIVE: 63.229 / 265.955 |
| #877 |  2141.166 / 2641.655 |         304.170 / 303.153 | MeterReading: ingen beviljad observation fångad |
| #878 |  1797.631 / 2266.952 |         300.592 / 301.202 | RentNotice SHARE: 37.382 / 15.769               |
| #879 |  2228.950 / 2044.719 |         305.285 / 315.356 | DeliveryEvent ACCESS EXCLUSIVE: 14.104 / 96.474 |

Tidigare tagna lås kan hållas under väntan på nästa tabell: #877 höll
ConsumptionCharge SHARE och MeterReadingReview ACCESS EXCLUSIVE i observerat
311.997/313.905 ms; #878 Invoice SHARE 355.455/327.563 ms; #879 Organization
SHARE ROW EXCLUSIVE 328.820/426.761 ms. Det visar varför endast det sista låset
inte beskriver migrationsrisken.

Spannen är **nedre gränser**, inte exakta förvärvs-/frigörandetider. Önskad
pollning var 5 ms; största faktiska samplingsluckan i normalfallen var
645.347 ms i A och 53.189 ms i B. Ett nollspann betyder en observation och
saknad observation betyder okänd hålltid, aldrig låsfrihet. Nya, ännu
ocommittade katalogobjekt är inte fullständigt synliga för observationssessionen.
Den delade maskinens I/O-/schemaläggningsvariation och 300 ms avsiktlig barriär
förklarar varför dessa tider inte får användas som produktions-SLO.

Extra SQL-läs-/skrivsonder redovisas separat från gamla API:t. De vanliga
skrivsonderna kunde vänta cirka 285–563 ms bakom DDL. UPDATE på DeliveryEvent
avvisades i båda #879-normalfallen med **23001**, enligt det redan installerade
append-only-skyddet. Det är en väntad avvisning på en ny tabell, inte ett
misslyckat gammalt API-anrop eller bevis att alla generiska UPDATE är tillåtna.

| Fel/omkörning                          | Resultat i båda omgångarna, samtliga fem filer                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400 ms lock_timeout                    | Katalogen återställd, inklusive typer/enumetiketter; oavslutad Prisma-post med steps=0. PostgreSQLs grundfel verifierat via CLI-55P03 eller PID-bunden serverlogg.                                               |
| pg_terminate_backend                   | Katalogen återställd; oavslutad Prisma-post.                                                                                                                                                                     |
| SIGTERM till Prisma-klientgruppen      | SQL-schemat hann committa efter barriärsläpp, medan Prisma-posten förblev oavslutad. Processavbrott bevisar alltså inte SQL-rollback.                                                                            |
| Vanlig omkörning efter ovanstående fel | Nekad med P3009 i samtliga 30 felsonder.                                                                                                                                                                         |
| Omkörning efter lyckad migration       | Exit 0, identisk katalog, ingen ny schemaeffekt.                                                                                                                                                                 |
| Isolerad återhämtning efter fel        | Endast efter katalogbevis: resolve --rolled-back vid återställd katalog, annars --applied vid exakt lyckad katalog; därefter verklig migrate deploy. Inga ogiltiga index eller ovaliderade constraints återstod. |

För de explicita transaktionerna kan följdfelet ”current transaction is aborted”
skymma grundfelet i Prisma. CLI-exit eller en tom logs-kolumn i migrationshistoriken
är därför inte ensamma tillräckliga. Riggen kräver också att migratorns lås
försvunnit före katalog/återhämtning. Ingen automatisk resolve byggs in i releasen.

Två samtidiga Prisma-starter gav **0/0** i båda omgångarna. pg_locks visade
advisory-väntare 9103 blockerad av 9100 i A, och 9575 av 9572 i B. Efteråt fanns
exakt fem unika lyckade migrationsposter med rätt checksummor. Detta serialiserar
migrationer, inte vilken Railway-release som senare blir routad.

#877:s separata cykelprov behöll gamla API:ts verkliga transaktionstimeout.
pg_blocking_pids visade **8796↔8799** respektive **9290↔9292**. Serverloggen band
migratorns BEGIN/CREATE TYPE-sats till ”deadlock detected” 16:41:10.429 UTC
(PID 8796) respektive uttrycklig **40P01** 16:46:17.180 UTC (PID 9290).
Migratorn gav exit 1, gamla API:t exit 0; katalogen återställdes, men en oavslutad
#877-post återstod. Gamla API:ts avläsning/debitering/faktura committades.
**Även denna lilla datamängd har alltså en verklig samtidighetsrisk.**

Reproduktion: riggen är `apps/api/test-fixtures/release/migration-study_test.py`,
med `old-api.test-fixtures.cjs`, verklig Prisma 5.22.0, psycopg2 och den separata
loopback-containern. Den vägrar återanvända ett befintligt databasnamn.
Råresultatets SHA-256 är
`34c3f83b1a3b32fc221d0eda18914e05ae9d96c3ef8bc07b09387fb96cbcb893`.
Råloggar och databasfiler läggs inte i PR:n. CI kräver de 20 grindproven och
manifestbyggprovet; denna frysta migrationsstudie är separat lokalt isolationsbevis,
inte ett påstående att CI eller hela gamla produktbeteendet är migrationsbevisat.

## Återställning och driftbeslut

Tre olika saker får inte sammanblandas:

1. **SQL-rollback:** databastransaktionens fel kan återställa katalogen, men
   \_prisma_migrations kan fortfarande blockera omkörning med P3009.
2. **Gammal app på nytt schema:** de angivna gamla metoderna/Prisma-anropen kan
   fungera mot framåtschema. Det ångrar inga typer, index eller triggers.
3. **Databasåterläsning:** kräver ett lämpligt backupunderlag, återställningsplan
   och ägarbeslut om databortfall/driftstopp. Ingen produktionsåterställning provades.

Railways läsande volymmetadata visade en backup skapad
**2026-08-23 02:08:57.880 UTC**, 58 MB used, giltig till
2026-09-22 02:08:57.560 UTC, och **inga backupscheman**. API:ts konfiguration
hade inga BACKUP-variabler. Ingen färsk återläsningsövning eller PITR-förmåga
verifierades. Den äldre volymbackupens existens bevisar inte tillräcklig
aktualitet, databas-konsistens eller en fungerande återläsning i dag.
Starta inte skarp migrationsövergång med detta som enda obeprövat underlag.

Rekommendationerna är inför en separat ägarstyrd inkoppling. SQL-filerna,
driften och de frysta PR:erna lämnas orörda. En redeploy ångrar ingen migration.
Se [releaseövergången](api-release-grind.md) för app-only-återstart, samtidiga
releaser, oförändrad aktiv startup-väg och kvarstående operativa bevis.

Separat migrationsgranskare kontrollerade slutrapporten mot båda omgångarnas
råresultat, serverlogg och checksumman. Inga blockerande fynd återstod inom
den uttryckliga avgränsningen. Det är inget operativt klartecken.
