# Globalt e-postindex för hyresgäster

Migration `20261016164500_tenant_email_lookup` lägger till ett **icke-unikt**
B-tree-index på `Tenant.email`. `@@unique([organizationId, email])` och dess
befintliga index behålls: samma adress får tillhöra flera hyresvärdar, men inte
två hyresgästrader hos samma hyresvärd. Inga konton, lösenord eller sessioner ändras.

Indexet stödjer befintlig lösenordsåterställning och globala e-postuppslag.
**Det löser inte hyresvärdsvalet vid inloggning.** Dagens osorterade `findFirst`
kan välja en annan första rad när frågeplanen ändras. Samordna kontovalsleveransen
innan stacken släpps i produktion; denna mätning är ingen produktionsaktivering.

## Migration och driftsättning

Filen innehåller endast denna SQL-sats, utöver kommentarer:

```sql
CREATE INDEX CONCURRENTLY "Tenant_email_idx" ON "Tenant"("email");
```

`CONCURRENTLY` valdes eftersom produktionens tabellstorlek och skrivlast inte
har mätts här. Vanligt indexbygge blockerar skrivningar. Samtidigt bygge tillåter
skrivningar men kan vänta på äldre transaktioner, ta längre tid och lämna ett
ogiltigt index vid avbrott. Det är ingen garanti om obefintlig driftpåverkan.
Se [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html).

Behåll **en enda sats i migrationsfilen**: inga `SET`, `BEGIN`, `DO` eller
ytterligare DDL. Den låsta Prisma 5.22-motorn skickar filen som en
[`simple_query`](https://raw.githubusercontent.com/prisma/prisma-engines/605197351a3c8bdd595af2d2a9bc3025bca48ea2/schema-engine/connectors/sql-schema-connector/src/flavour/postgres/connection.rs).
Flera satser i ett sådant meddelande får ett implicit transaktionsblock, där
`CONCURRENTLY` inte tillåts. Se [PostgreSQLs protokollregel](https://www.postgresql.org/docs/16/protocol-flow.html#PROTOCOL-FLOW-MULTI-STATEMENT).

Driftsätt genom den separata, granskade engångsmigratorn i
[Säker appomstart](safe-app-restart.md#införandeordning--separat-godkännande-krävs):
exakt grön releaseidentitet, verifierad databas, en migrator, `NEVER` och ingen
appstart som reservväg. Kontrollera hela mängden väntande migrationer före
`migrate deploy`; kommandot tillämpar alla väntande filer. Ändra inte gamla
migrationer och använd inte `IF NOT EXISTS` för att dölja ett befintligt index.

Efteråt ska `Tenant_email_idx` vara giltigt och färdigt, icke-unikt och över
exakt `email`; organisationsindexet ska fortfarande vara giltigt och unikt.
Kontrollera även migrationskvittot. Grön schemadriftsvakt räcker inte ensam:
den loggar additiv drift utan att fälla. Rådiffen får inte innehålla någon
`CREATE`/`DROP` för `Tenant_email_idx`.

## Om bygget avbryts

Stoppa införandet och invänta att den egna migratorn verkligen har avslutats.
Kontrollera pågående indexbyggen och långvariga transaktioner; även återhämtningen
kan behöva vänta. Avsluta inte andra verksamhetstransaktioner som en genväg.
Ingen automatisk omkörning eller blind `migrate resolve`. Läs rätt databas,
indexdefinition och migrationshistorik först:

```sql
SELECT current_database(), current_schema();
SELECT c.relname, i.indisvalid, i.indisready, i.indisunique,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = 'public."Tenant"'::regclass
  AND c.relname IN ('Tenant_email_idx', 'Tenant_organizationId_email_key');

SELECT migration_name, started_at, finished_at, rolled_back_at, logs
FROM "_prisma_migrations"
WHERE migration_name = '20261016164500_tenant_email_lookup'
ORDER BY started_at DESC;
```

Om det nya indexet är **ogiltigt** och har exakt den förväntade definitionen,
ta bort endast det indexet med en separat autocommit-sats:

```sql
DROP INDEX CONCURRENTLY public."Tenant_email_idx";
```

Verifiera att det är borta. Markera därefter just den misslyckade migrationen
med `prisma migrate resolve --rolled-back 20261016164500_tenant_email_lookup`
och kör den godkända migratorn igen. `resolve` ändrar migrationshistoriken;
det utför ingen SQL-återställning. Den låsta motorns
[migrationsbeskrivning](https://raw.githubusercontent.com/prisma/prisma-engines/605197351a3c8bdd595af2d2a9bc3025bca48ea2/schema-engine/ARCHITECTURE.md)
beskriver dessa skilda steg.

Om indexet redan är giltigt, definitionen avviker eller historiken är oväntad:
använd inte borttagningssekvensen utan utred utfallet. Ett giltigt exakt index
med saknat migrationskvitto kan behöva verifierad `resolve --applied` i stället.
Rör aldrig `Tenant_organizationId_email_key`. Kontrollera katalog och historik
igen efter återhämtningen.

## Lokalt mätt 2026-10-16

90 000 syntetiska hyresgästrader: 30 organisationer med 3 000 rader var. Detta
är **inte** ett komplett fastighetsflöde med 3 000 lägenheter. Apple M1/8 GB,
PostgreSQL 16.15, Prisma 5.22 och Node 24.19.0; en tung process åt gången med
Node-heapgräns 1 536 MB. Normal planner efter `ANALYZE`, fem varma frågor per
fall. Tiderna är PostgreSQLs exekveringstid, inte API-svarstid; bcrypt ingår inte.

| SQL-fall                                 | Median före, ms | Median efter, ms | Buffertträffar före → efter¹ |
| ---------------------------------------- | --------------: | ---------------: | ---------------------------: |
| Login, delad adress, `LIMIT 1`           |           0,009 |            0,009 |                        1 → 4 |
| Login, adress `index-30-2999`, `LIMIT 1` |           0,047 |            0,009 |                       15 → 4 |
| Login, saknad adress                     |           5,774 |            0,007 |                    2 063 → 3 |
| Återställning, delad adress, 30 träffar  |           9,719 |            0,033 |                   2 063 → 33 |
| Återställning, saknad adress             |           9,699 |            0,006 |                    2 063 → 3 |
| Login med uttrycklig organisation        |           0,009 |            0,008 |                        4 → 4 |

¹ Buffertarna kommer från den sparade exempelplanen, inte en median.
Adressens namn betyder inte att raden ligger sist fysiskt. Ingen slutsats om
alla inloggningar, kalla cacher eller produktionslast följer av tabellen.
Nya indexet upptog 4 497 408 byte i denna fixtur.

Riktig `migrate deploy` avbröts kontrollerat i fasen `waiting for writers before
build`: Prisma `P3018`, PostgreSQL `57014`, index `indisvalid=false` och
`indisready=false`. En annan rad kunde uppdateras medan bygget väntade.
Kataloginspektion, `DROP INDEX CONCURRENTLY`, explicit `resolve --rolled-back`
och ny deploy gav därefter giltigt index. Omkörningens kommandotid var 473 ms,
inklusive Prisma-start; detta är ingen isolerad indexbyggtid. Samma adress hos
30 organisationer bevarades, ny organisationsöverskridande dubblett accepterades
och dubblett inom samma organisation gav `P2002`. Slutantalet var 90 000 rader.

Fullt shadow-driftprov gav endast den redan kända vector/HNSW-driften, inget
om `Tenant_email_idx`. Råunderlaget är `portal-email-index-before.json`,
`portal-email-index-after.json` och `portal-email-index-migration-result.json`
i arbetsytans `eveno-slutbygge-20261016/`. Det manuella reproduktionsskriptet
`apps/api/scripts/probe-tenant-email-index.mjs` har lägena `seed`, `before` och `after`
och tillåter endast den egna lokala databasen `eveno_portal_email_index_test`.
Det ska inte riktas mot kunddata. Belastnings-/bcryptresultat redovisas separat.

Kör från `apps/api` med explicit `DATABASE_URL` till den egna loopback-databasen
och `NODE_OPTIONS=--max-old-space-size=1536`. Skriptet läser ingen miljöfil.
`seed` kräver tomma Tenant- och Organization-tabeller. `before` kräver att det
nya indexet saknas, `after` att det är giltigt; båda kräver en resultatfil:

```sh
node scripts/probe-tenant-email-index.mjs seed
node scripts/probe-tenant-email-index.mjs before /tmp/tenant-email-before.json
# Tillämpa endast den granskade migrationen via egen testmiljös migrator.
node scripts/probe-tenant-email-index.mjs after /tmp/tenant-email-after.json
```

För före-mätningen ska testdatabasen innehålla basens migrationer utan den nya
filen; använd en separat baskopia. Ta inte bort ett index i en befintlig
verksamhetsdatabas för att skapa en baslinje.

Efter migrationen var även samtliga **10/10 befintliga DB-prov** i
`tenant-auth.forgot-password.db.spec.ts` gröna på den isolerade databasen, med
riktig bcrypt, kontoisolering, återkallelse och felinjektion. Inga riktiga mejl
skickades. Prisma validate, ESLint för mätsonden och rådiffens befintliga
schemadriftslogik var gröna. Full svit körs i CI på leveransens exakta commit.
