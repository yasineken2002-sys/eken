# Runbook: Databasbackup & återställning

> ⚠️ **INTE I DRIFT ÄN (ommätt 2026-09-16 mot `30724b17`).** Mekanismen nedan är
> byggd och testad, men jobbet är avstängt i produktion. Mätt i Railway samma dag:
> av 40 variabler på tjänsten `eken` finns **noll** av `BACKUP_ENABLED`,
> `BACKUP_RETENTION_DAYS`, `BACKUP_PRUNE_ENABLED` och de fyra `R2_BACKUP_*` — så
> isoleringsgrinden skulle blockera även med flaggan satt. Noll dumpar har tagits
> av jobbet. Runbooken beskriver alltså hur det ska fungera, inte vad som pågår.
> Se #575.
>
> De två dumpar som finns i `eveno-db-backup-prod` är **manuella** (2026-09-13 och
> 2026-09-15, tagna inför införandet av #896). De är återställningspunkter, inte
> jobbkörningar — se "Gallringen är avstängd" nedan för varför det skiljer.

Eveno är byggt för **daglig full databasbackup** (`pg_dump` custom-format) som laddas
upp till Cloudflare R2 — en annan leverantör än Railway-databasen. Integritetspolicyn
utlovar i dag ingen säkerhetskopiering (variant A); utfästelsen skrivs in när jobbet
körts skarpt och en återställning verifierats.

## Hur det fungerar

- **Jobb:** `BackupService` + `BackupScheduler` (`apps/api/src/backup/`).
- **Schema:** `@Cron('0 3 * * *')` — varje natt 03:00 (serverns tidszon).
- **Steg:** `pg_dump -Fc --no-owner --no-privileges` → temp-fil → upp till R2 under
  `db-backups/eken-<UTC-tidsstämpel>.dump` → gallring **endast om
  `BACKUP_PRUNE_ENABLED=true`** (annars hoppas den över och loggas som avstängd).
- **Fel:** loggas + rapporteras till Sentry. Nästa nattkörning försöker igen.

## Aktivering (produktion)

Jobbet är **avstängt** tills följande env-vars är satta (annars no-op).
Tabellen är den enda sanningskällan för mängden; prosa som räknar dem ska
härledas ur den, inte skrivas för hand.

Kolumnen **i prod** är avläst 2026-09-16 via `railway variable list --json` på
tjänsten `eken` (40 variabler). För de två hemliga lästes bara närvaro; för de
icke-hemliga lästes det faktiska värdet — en namnlista bevisar inte att en flagga
är av eller att jurisdiktionen är rätt.

| Env-var                       | Krav i prod                                    | I prod 2026-09-16 | Vad som lästes  |
| ----------------------------- | ---------------------------------------------- | ----------------- | --------------- |
| `BACKUP_ENABLED`              | **obligatorisk** — `true` aktiverar nattjobbet | SAKNAS            | värde           |
| `R2_BACKUP_BUCKET`            | **obligatorisk** — dedikerad backup-bucket     | SAKNAS            | värde           |
| `R2_BACKUP_ACCESS_KEY_ID`     | **obligatorisk** — bucketbegränsad token       | SAKNAS            | endast närvaro  |
| `R2_BACKUP_SECRET_ACCESS_KEY` | **obligatorisk** — bucketbegränsad token       | SAKNAS            | endast närvaro  |
| `R2_BACKUP_JURISDICTION`      | **obligatorisk här** — bucketen ligger i EU    | SAKNAS            | värde           |
| `R2_BACKUP_ACCOUNT_ID`        | valfri — annars `R2_ACCOUNT_ID`                | SAKNAS            | värde           |
| `BACKUP_PRUNE_ENABLED`        | valfri — **saknas = ingen gallring**           | SAKNAS            | värde           |
| `BACKUP_RETENTION_DAYS`       | valfri — standard 30, inert utan spärren ovan  | SAKNAS            | värde           |
| `DATABASE_URL`                | obligatorisk, redan satt sedan tidigare        | finns             | ingen avläsning |

**Åtta variabler tillhör backupen** (raderna ovan utom `DATABASE_URL`), och
**noll av dem finns**. Fem är obligatoriska för den här bucketen; tre är valfria
— `R2_BACKUP_ACCOUNT_ID`, som annars faller tillbaka på `R2_ACCOUNT_ID`, samt
gallringsflaggan och retentionen, som båda med flit lämnas osatta i den här
införandeordningen. Räkna alltid ur tabellen; prosan ovan är härledd ur den.

`R2_BACKUP_JURISDICTION` står som obligatorisk trots att koden defaultar till
`default`: bucketen `eveno-db-backup-prod` skapades i **EU**, och en bucket
tillhör exakt en jurisdiktion. Utan `eu` frågar klienten på default-endpointen
och får `404 NoSuchBucket` — samma svar som om bucketen inte fanns.

> ⚠️ **Produktionskrav (säkerhet):** i `NODE_ENV=production` **blockeras** jobbet
> (loggar ett fel, kör inte) om det saknar dedikerad backup-token + bucket och
> skulle dela R2-kredential/bucket med dokumentlagringen. Skapa en separat R2 API-
> token scopad enbart till backup-bucketen så att en läckt dokumentlagrings-nyckel
> inte ger tillgång till hela databasdumpen. I dev faller det tillbaka till
> huvudnycklarna (`R2_ACCESS_KEY_ID` m.fl.).

`pg_dump`/`pg_restore` (**postgresql-client-18**) ligger i API-imagen
(`apps/api/Dockerfile`). Pinnen är lastbärande och riktad: en `pg_dump` som är
ÄLDRE än servern vägrar (`aborting because of server version mismatch`), en som är
nyare fungerar. Prod kör PG 18.6. Står det `postgresql-client-16` någonstans är
det en kvarleva — det stod så i den här runbooken fram till 2026-08-28.

## Gallringen är avstängd, och det är ett eget beslut

`runBackup` laddar upp och anropar sedan `pruneOldBackups`. Fram till 2026-09-16
styrdes raderingen bara av ett tal (`BACKUP_RETENTION_DAYS`, default 30) — vilket
betyder att den dag `BACKUP_ENABLED=true` sätts hade radering av äldre
återställningspunkter blivit påslagen i samma sekund som den första dumpen togs,
utan att någon beslutat det och innan en enda skarp körning setts lyckas.

`BACKUP_PRUNE_ENABLED` gör raderingen till en egen beslutspunkt. **Fail-closed:**
osatt, tomt, `false`, felstavat — allt utom exakt `true` betyder att ingenting
raderas, och `DeleteObjectCommand` nås aldrig. Loggraden säger vilket läge som
gällde, så `gallrade 0 gamla` inte längre kan betyda två olika saker:

```
[backup] OK db-backups/eken-…Z.dump (2.1 MB), gallring AVSTÄNGD (BACKUP_PRUNE_ENABLED ≠ "true")
         — inga gamla backuper raderades, och ingen listning av lagringen gjordes
```

**Ett högt retentionstal är inte samma sak.** `BACKUP_RETENTION_DAYS=36500` ser ut
som en spärr men är ett tal: det går att sänka av misstag, det syns inte i en
variabelnamnslista, och raderingsvägen är fortfarande påslagen — den väntar bara.

**De manuella återställningspunkterna skyddas dubbelt.** De bär en commit-SHA i
nyckeln (`eken-20260913T143554Z-3b71e905.dump`) och matchar därför inte jobbets
eget nyckelformat. `isBackupExpired` vägrar tolka en nyckel den inte känner igen,
så de ligger utanför gallringen även om den slås på. Det är pinnat med de
faktiska nycklarna i `backup.service.spec.ts`.

**Följdsatsen, och den är inte gratis:** utan gallring växer bucketen obegränsat.
Innan gallringen någonsin slås på ska det finnas ett uttryckligt retentionsbeslut
och ett golv som garanterar att minst N återställningspunkter alltid behålls.
Inget av det är byggt; det är avsiktligt utanför den här ändringen.

Formen bevakas av `apps/api/scripts/check-backup-prune-gate.mjs` (eget CI-jobb):
varje `new DeleteObjectCommand(` i backupvägen måste ligga i `pruneOldBackups`
bakom grinden, och grinden måste returnera FÖRE första raderingen.

## Aktiveringsordning — och vad som räknas som bevis

Stegen nedan ändrar produktionen och utförs av EN utsedd operatör efter ett
uttryckligt driftbeslut. **Ingen av dem är utförd av den här leveransen.**

### Förutsättningen som inte får hoppas över

**Gallringsspärren finns inte i den revision som kör.** Avläst 2026-09-16:
produktionen kör `30724b17`, och `BACKUP_PRUNE_ENABLED` infördes efter den.
Sätts `BACKUP_ENABLED=true` mot den revisionen är gallringen styrd enbart av
`BACKUP_RETENTION_DAYS` — alltså exakt det läge spärren finns för att undvika.

Ett variabelbyte är därför **inte** en genväg runt införandet. Aktiveringen
kräver att koden först granskas, mergas och **driftsätts genom ett nytt
verifierat startpaket för den slutliga revisionen**.

Att paketet måste vara nytt är inte en formalitet. Tjänstens startkommando är
i dag grindat mot en enda revision (avläst 2026-09-16: startkommando
`sha256:f5a4ab12…`, `GATE_MANIFEST_B64 sha256:c408fee2…`, `expected_revision`
= `30724b17`). En deployment av någon annan revision avvisas av grinden med
exit 11 **innan** något startar. Det gäller även om de nio deklarerade filerna
är oförändrade: revisionsbindningen ensam räcker för att avvisa **fel SHA**.

Men den räcker bara till det. Grindens nio deklarerade filer innehåller **inte**
backupens körbara kod, så ett godkänt grindkvitto bevisar inte byteidentitet för
kompilerad `BackupService`/`BackupScheduler` — alltså inte att gallringsspärren
finns i den container som startade. Den framtida releaseverifieringen ska därför
**separat jämföra de relevanta kompilerade backupfilerna med den granskade
byggartefakten**. Det är ett verifieringskrav på releasen, inte en ändring av
grindpaketet.

### Beroendet till #897, i två lägen

#897 (`codex/saker-appomstart-896`) levererar en **grindad omstart utan
migrering**. Backupaktiveringen behöver ingen migration, så de två passar ihop
— men aktiveringen får inte vila på en tyst förmodan om att #897 redan är inne.

| läge                    | startvägen för slutrevisionen                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#897 är mergad**      | Använd dess omstartsväg. Den startar utan att köra migreringar, vilket är rätt form för en ändring som bara rör env och applikationskod. #897 ändrar `migrate-and-start.sh`, så manifestets filhashar ändras — nytt paket ändå.                                                                                                                                   |
| **#897 är inte mergad** | Starten går via #896:s procedur: nytt grindpaket, `serviceInstanceDeployV2` med `commitSha`. Den vägen kör `migrate-and-start.sh`, alltså `prisma migrate deploy` före appstart. Med noll väntande migrationer är det en no-op (`No pending migrations`) — men det är fortfarande en migrationsväg, och att köra den ska vara ett medvetet val, inte en bieffekt. |

Kontrollera läget innan ordningen påbörjas; anta det inte.

### Ordningen

**Fas A — kodleverans.** #898 granskad och mergad med vanlig merge-commit.
Notera den **exakta** nya main-SHA:n. Båda deployspärrarna förblir avstängda
(Railway git-trigger 0, GitHub Deploy `disabled_manually`); en merge får inte
kunna rulla ut något av sig själv.

**Fas B — revision och CI.** Grön CI på den faktiska main-commiten, inte på
PR-grenens head. Läs träd-SHA och bekräfta att den motsvarar det granskade.

**Fas C — image och grindpaket.** Bygg grindpaketet för slutrevisionen
(`expected_revision` = den nya main-SHA:n), kör den lokala drivrutinen grön mot
en lokalt byggd image av samma träd, och **bevara det tidigare manifestet**.

De förväntade hasharna ska **frysas ur en oberoende granskad byggartefakt innan
de används i startgrinden**. Det kräver ingen provstart: ett offlinefacit går att
beräkna ur artefakten. Det som aldrig får göras är att räkna om facit ur den
kandidat som håller på att starta — då godkänner kandidaten sig själv, och grinden
mäter ingenting.

**Fas D — förbered variablerna utan att utlösa något.** En i taget, hemligheter
via stdin så de aldrig står på kommandoraden:

```bash
railway variable set R2_BACKUP_ACCESS_KEY_ID --stdin --skip-deploys \
  --project <projekt> --environment <miljö> --service eken
```

`--skip-deploys` finns i CLI:ns egen hjälp (`railway variable set --help`,
Railway CLI 5.57.2) och betyder "skip triggering deploys when setting the
variable". Sätt `R2_BACKUP_BUCKET`, `R2_BACKUP_ACCESS_KEY_ID`,
`R2_BACKUP_SECRET_ACCESS_KEY`, `R2_BACKUP_ACCOUNT_ID` och
`R2_BACKUP_JURISDICTION=eu`. **`BACKUP_ENABLED` sätts INTE här** — se fas F.
`BACKUP_PRUNE_ENABLED` och `BACKUP_RETENTION_DAYS` sätts inte alls.

Nyckeln är den **redan godkända** bucketbegränsade R2-nyckeln i Apples
Lösenord. Skapa ingen ny nyckel och ingen ny bucket; objekten i
`eveno-db-backup-prod` är återställningspunkter.

Läs deploymentlistan efter varje variabelbyte. Mätt 2026-09-15 med
git-autodeploy av: en variabeländring skapade **ingen** deployment. Det är en
mätning på den tjänsten den dagen, inte ett plattformslöfte — kontrollera igen.

**Fas E — kodutrullningen.** Efter ett eget uttryckligt driftbeslut: starta
slutrevisionen genom grinden, enligt tabellen ovan. Verifiera **tillämpat**
manifest (startkommando, `restartPolicyType`, healthcheck), att instansen är
RUNNING, och att `/v1/health` svarar med den nya revisionen. Det här är den enda
start som kodleveransen kräver.

**Fas F — aktiveringsomstarten.** Först nu `BACKUP_ENABLED=true`
(`--skip-deploys`), följt av en andra kontrollerad start. Konfigurationen läses
när tjänsten konstrueras, så en körande process plockar aldrig upp värdet av sig
själv.

> **Varför ordningen är låst.** Sätts `BACKUP_ENABLED=true` innan den nya
> revisionen kör, finns ett fönster där en plattformsinitierad omstart skulle
> starta den GAMLA revisionen med backupen påslagen och utan gallringsspärr. Att
> "bevaka fönstret" är ingen spärr — bevakning hindrar inte gammal kod från att
> hinna exekvera. En annan ordning kräver en egen styrkt avskärmning och ett eget
> beslut, inte ett val i stunden.

**Fas G — verifiera förutsättningarna innan första natten.** En namnlista räcker
inte. Läs tillbaka, utan att röja hemligheter:

| ska bevisas                  | hur                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `BACKUP_PRUNE_ENABLED` är av | variabeln saknas, eller har ett värde som inte är `true` — **läs värdet**, inte bara namnet |
| jurisdiktionen är `eu`       | `R2_BACKUP_JURISDICTION` har värdet `eu`                                                    |
| rätt startpaket kör          | tillämpat startkommandos sha256 = paketets, och `/v1/health` `revision` = slutrevisionen    |
| hemligheterna nådde fram     | närvaro + sha256-prefix jämfört mot avläsningen i Apples Lösenord                           |
| deployspärrarna står kvar    | Railway git-triggers = 0, Deploy-workflow `disabled_manually`                               |

Flaggor, bucketnamn och jurisdiktion är **inte** hemligheter och ska läsas ut i
klartext; access key och secret ska aldrig lämna processen. Ett färdigt sådant
läsläge finns i `arbete/backup-aktivering-20260915/prov/las-aktiveringslage.py`.

### Första riktiga körningen (03:00 UTC) — tre nivåer av bevis

| räknas som                    | bevis                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| schemaläggaren kördes         | `cron:daily-backup` i `/v1/health` har `lastRunAt` inom dygnet                                                     |
| en backup SKAPADES            | loggraden `[backup] OK db-backups/eken-…Z.dump (… MB)` **och** objektet finns i R2 med rimlig storlek              |
| backupen är ÅTERSTÄLLNINGSBAR | dumpen hämtad ur R2, sha256 jämförd, `pg_restore` mot ett tomt PG 18-kluster, och acceptanskriterierna nedan gröna |

**Ett grönt hjärtslag är INTE ett bevis för en backup — mätt i produktion
2026-09-16, inte resonerat:**

```
cron:daily-backup  lastRunAt 2026-09-15T03:00:00.015Z  lastOutcome "success"  stale false
```

Backupen är avstängd och har aldrig tagit en enda dump. `dailyBackupUnsafe`
returnerar tyst när `enabled` är falskt och sväljer ett fångat fel, så
`LockService` skriver `lastOutcome: 'success'` i alla tre världarna: jobbet
avstängt, jobbet misslyckat, jobbet lyckat. Det som skiljer dem åt är
färskhetskontrollen 09:00 (`disabled` / `never` / `stale` / `fresh`) och
loggraden ovan — inte hjärtslaget.

Samma avläsning fastställer **tidszonen**: `03:00:00.015Z` är 03:00 UTC, alltså
05:00 svensk sommartid och 04:00 vintertid. Backup-cronen sätter ingen
`timeZone` och `TZ` är osatt i Railway — till skillnad från t.ex. veckobrevet,
som kör `0 18 * * 0` i `Europe/Stockholm` och därför syns som `16:00Z`.

Sex timmar senare ska färskhetskontrollen logga `OK: senaste backup …`. Larmar
den `disabled` är konfigurationen ofullständig. `never` betyder att **inget
objekt i jobbets namnformat hittades** — inget annat. Det bevisar varken att
jobbet har kört eller att något lagrat innehåll går att återläsa; ett jobb som
aldrig schemalagts ger exakt samma svar. Se avsnittet om vad kontrollen mäter.

### Om aktiveringen måste avbrytas

`BACKUP_ENABLED=false` **plus en kontrollerad omstart** gör att nästa nattkörning
inte tar någon dump, inte laddar upp något och inte gallrar något.

Det är vad avstängningen gör. Det är inte en rollback, och följande gäller:

- **Variabeln får effekt först vid omstart.** Konfigurationen läses när tjänsten
  konstrueras. Tills processen startat om kör den vidare med sitt gamla värde.
- **Ingenting som redan hänt ångras.** Uppladdade objekt ligger kvar; ett
  raderat objekt kommer inte tillbaka.
- **Att inget raderats är ett PÅSTÅENDE tills det mätts.** Det finns ingen
  raderingsrevision att läsa i efterhand. Bevis är en objektlista tagen före
  aktiveringen jämförd med en tagen efter — inklusive de två manuella
  återställningspunkterna.
- **Färskhetslarmet blir högljutt**, och det är korrekt: `disabled` varje dygn
  tills backupen är påslagen igen.

Gällande återställningspunkt är fortsatt de två manuella dumparna i
`eveno-db-backup-prod`, till dess att en skarp körning verifierats enligt de tre
bevisnivåerna ovan.

## Vad färskhetskontrollen faktiskt mäter — och inte

`evaluateBackupFreshness` får in **en lista objektnycklar** ur backup-bucketen
och en klocka. Inget annat. Den läser ingen körningshistorik, inget
`_prisma_migrations`, ingen cron-tabell och inte en enda byte av en dumps
innehåll.

Av nycklarna räknas bara de som matchar jobbets eget namnformat
(`eken-<ÅÅÅÅMMDD>T<HHMMSS>Z.dump`); `parseBackupKeyDate` returnerar `null` för
allt annat. Tidpunkten härleds ur **nyckelns text**, inte ur objektets
`LastModified`.

Läs utfallen därefter:

| utfall     | vad det betyder                                          | vad det INTE betyder                                                                        |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `disabled` | konfigurationen blockerar jobbet; R2 lästes inte alls    | att lagringen är tom                                                                        |
| `never`    | noll nycklar i formatet                                  | **att jobbet har kört.** Ett jobb som aldrig schemalagts ger samma svar                     |
| `stale`    | den senaste formatmatchande nyckeln är äldre än tröskeln | att just den dumpen är trasig                                                               |
| `fresh`    | en nyckel i formatet bär en tidsstämpel inom tröskeln    | **att dumpen går att återställa** — varken storlek, innehåll eller `pg_restore` har prövats |

Två praktiska följder. De två **manuella** återställningspunkterna bär en
commit-SHA i nyckeln och matchar därför inte formatet: de räknas inte, och en
natt utan jobbkörning larmar `never` trots att bucketen innehåller två giltiga
dumpar. Och ett `fresh` som bygger på en nyckel utan innehåll — en tom eller
avbruten uppladdning med rätt namn — är fortfarande `fresh`. Återställningsbarhet
bevisas bara av proceduren under "Återställningens acceptanskriterier".

Produktlogiken är oförändrad; det här avsnittet rättar bara beskrivningen av den.

## Verifiera att backuper skapas

Kolla API-loggen efter `[backup] OK db-backups/eken-… (… MB)` runt 03:00, eller
lista i R2-dashboarden under `db-backups/`. Programmatiskt: `BackupService.listBackups()`.

## Återställning

> ⚠️ Återställ **aldrig** rakt över produktion utan en färsk backup och en medveten
> plan. Återställ i första hand till en NY databas och växla över efter verifiering.

1. **Hämta** önskad `.dump` från R2 (`db-backups/`) — R2-dashboard eller `rclone`.
2. **Kör** restore-skriptet (kräver `postgresql-client-18`, se majorversions-
   regeln nedan):

   ```bash
   apps/api/scripts/restore-db.sh eken-20260707T030512Z.dump \
     "postgresql://user:pass@host:5432/eken_restore"
   ```

   Skriptet kör `pg_restore --no-owner --no-privileges --clean --if-exists`.

3. **Verifiera** radantal i nyckeltabeller mot förväntan innan du växlar över:

   ```bash
   psql "$TARGET_URL" -tAc 'SELECT count(*) FROM "Invoice"'
   psql "$TARGET_URL" -tAc 'SELECT count(*) FROM "JournalEntry"'
   psql "$TARGET_URL" -tAc 'SELECT count(*) FROM "RentNotice"'
   ```

## Nycklarna är en del av backupen — dumpen ensam räcker inte

**Mätt 2026-08-28.** En återställd databas är inte en läsbar databas. Fyra kolumner
i schemat bär chiffertext eller peppar-härledda blind-index, och utan nycklarna är
de raderna oåtkomliga hur hel dumpen än är. Vid ett återställningstest bootade API:t
mot den återställda databasen och `PiiCoherenceService` larmade direkt:

```
[pii-coherence] MISSMATCHNING: chiffertexten går inte att dekryptera med
SIGNING_PII_KEY — nyckeln har bytts utan omkryptering.
```

Det var ett **varningslarm, inte fail-fast** — appen startade ändå och `/v1/health`
svarade `ok`. Felet är alltså tyst i drift och syns bara för den som läser boot-loggen.

### DR-artefakter: förvaras out-of-band (lösenordshanterare), aldrig bara i Railway

| Variabel              | Skyddar                                                                                                                                                       | Vid förlust                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNING_PII_KEY`     | AES-256-GCM-envelope i `Tenant.personalNumberEnc`, `Customer.personalNumberEnc`, `SignatureEvidence.personalNumberEnc` + `.signaturePayload` + `.certificate` | **PERMANENT.** Klartexten finns ingen annanstans. Blind-indexet är en HMAC och går inte att vända.                                                               |
| `SIGNING_PII_PEPPER`  | HMAC-blind-index i `Tenant.personalNumberHash`, `Customer.personalNumberHash`, `SignatureEvidence.personalNumberHash`                                         | **Återvinningsbar SÅ LÄNGE nyckeln lever** — hashen räknas om ur klartexten (`scripts/rotate-pii-secrets.ts`, peppar-läget). Utan nyckeln är även den permanent. |
| `PSD2_TOKEN_KEY`      | `BankConsent.accessTokenEnc` / `.refreshTokenEnc`                                                                                                             | **Återvinningsbar via banken:** samtycket måste hämtas om från aggregatorn, hyresgästen/värden får göra om PSD2-flödet. Dyrt, inte förlorat.                     |
| `SIGNING_PII_KEY_OLD` | Inget eget — läsfallback under en pågående nyckelrotation                                                                                                     | Ingen förlust; ska bara finnas medan en rotation pågår och tas bort när den är klar.                                                                             |

Listan är **härledd ur koden**, inte ihopsamlad: sveptes fram ur alla anrop till
`createCipheriv`/`createDecipheriv`/`createHmac` i `apps/api/src` + `packages/shared/src`
(två krypto-tjänster: `signing/signing-crypto.service.ts`, `psd2/bank-consent-crypto.service.ts`),
korsläst mot `config/env.validation.ts` och mot varje kolumn i `schema.prisma`.

> ⚠️ **`SignatureEvidence.signaturePayload` och `.certificate` slutar inte på `Enc`.**
> En kolumn-uppräkning som söker på namnformen missar dem. De är krypterade med
> SAMMA `SIGNING_PII_KEY` — se `buildTargets()` i `scripts/rotate-pii-secrets.ts`,
> som listar dem uttryckligen som `extraEncryptedColumns` av just det skälet.

### Inte DR-artefakter — kan roteras utan att data går förlorad

`JWT_SECRET`, `PLATFORM_JWT_SECRET`, `PLATFORM_JWT_REFRESH_SECRET` (autentiserar
bara; rotation loggar ut alla, förstör inget), `R2_*` och `R2_BACKUP_*` (åtkomst-
kredential, kan utfärdas på nytt i Cloudflare — R2-filerna krypteras inte
klientsidigt), `RESEND_*`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`.

De ska så klart ändå finnas för att systemet ska fungera. Skillnaden är att de går
att **ersätta**; DR-artefakterna går bara att **återfå**.

### Verifiera en säkrad nyckel utan att avslöja den

Prod-hemligheter får aldrig passera en terminal vars utdata sparas (regeln i
`CLAUDE.md`; åtta credentials fick roteras 2026-08-15 av just det skälet). Kopiera
värdet från Railways gränssnitt till lösenordshanteraren och jämför **hash mot hash**:

```bash
read -rs KEY            # skriver inte ut, hamnar inte i historiken
printf '%s' "$KEY" | sha256sum | cut -c1-16
unset KEY
```

Sidan som läser ur Railway gör samma sak utan att värdet når stdout:

```bash
railway variables --service eken --kv \
  | python3 -c 'import hashlib,sys; [print(k, hashlib.sha256(v.encode()).hexdigest()[:16]) for k,v in (l.rstrip("\n").split("=",1) for l in sys.stdin if "=" in l)]'
```

Prefixen ska vara identiska. Ett enda ändrat tecken ändrar prefixet — det är
verifierat, inte antaget.

## Återställningens acceptanskriterier

**Mätt 2026-08-28 mot en riktig produktionsdump.** Kriterierna nedan är inte
principer utan resultatet av att ha kört en hel och en avsiktligt trasig dump genom
samma procedur och sett vilka kontroller som faktiskt skilde dem åt.

### RTO

**1,66 s** (1 659 ms) för `pg_restore` av en 2,0 MB custom-format-dump (88 tabeller,
1 062 rader) till ett tomt kluster — exit 0, noll fel, noll varningar.

Talet gäller **enbart återställningen**. Full DR innefattar också att provisionera
ett kluster och peka om `DATABASE_URL`, och det är inte inräknat. Talet skalar med
datamängden; mät om när prod vuxit.

### Återställ ALLTID mot samma majorversion som prod

Prod kör **PG 18.6**. Den lokala Postgres i codespacet är PG16 — samma dump dit gav:

```
pg_restore: error: could not execute query: ERROR:
  unrecognized configuration parameter "transaction_timeout"     (exit 1)
```

`transaction_timeout` är en GUC som tillkom i PG17. Datan kom faktiskt in (88
tabeller, 1 062 rader), men **exitkoden var nollskild** — en skarp DR-körning hade
sett ut att misslyckas, mitt i en incident. Använd `pgvector/pgvector:pg18` lokalt
(pgvector krävs för `LegalChunkEmbedding`).

### `/v1/health` DUGER INTE som acceptanskriterium

Mot en avsiktligt stympad (90 %) återställning svarade endpointen:

```json
{
  "status": "ok",
  "info": { "database": { "status": "up" } },
  "legalKnowledge": { "chunks": 427, "vectors": 0 }
}
```

`status: ok` och `database: up` — därför att indikatorn bara kör `SELECT 1`, och
databasen _fanns_. Det som avslöjade den var **paritetsfältet**: `chunks: 427` mot
`vectors: 0`. Fältet bär båda talen just för att den som läser ska kunna göra
jämförelsen själv. `status` är inte diskriminerande, `legalKnowledge` är det.

### Minimikravet: radantal PER TABELL och antal index/FK

Ett tabellantal ensamt godkänner en trasig dump. Uppmätt på den stympade kopian:

| Mått                  | Prod      | Stympad | Utfall        |
| --------------------- | --------- | ------- | ------------- |
| tabeller              | 88        | 88      | hade passerat |
| kolumner              | 1090      | 1090    | hade passerat |
| enum-typer            | 77        | 77      | hade passerat |
| **index**             | **333**   | **0**   | **fäller**    |
| **primärnycklar**     | **88**    | **0**   | **fäller**    |
| **främmande nycklar** | **158**   | **0**   | **fäller**    |
| **rader totalt**      | **1 062** | **318** | **fäller**    |

Schemat kom in i sin helhet; allt som ligger sist i arkivet — data, index,
constraints — gjorde det inte. Ett skrivförsök mot den databasen föll på
`42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification`.

**Godkänn en återställning först när allt detta är mätt:**

1. `pg_restore` **exit 0**, noll rader `pg_restore: error`.
2. Radantal **per tabell** mot källan — inte bara totalen.
3. Antal **index, PK, FK och enum-typer** mot källan.
4. `prisma migrate status` → `Database schema is up to date!` (exit 0).
5. API mot den återställda databasen: `/v1/health` **plus** `legalKnowledge.chunks
== legalKnowledge.vectors`, plus minst en skyddad läsning och en skrivning.
6. Nycklarna ur avsnittet ovan finns — annars är PII-kolumnerna oläsbara även om
   1–5 är gröna.

Färdig jämförelse (radantal per tabell + index/FK/enum per objekt) i ett svep:

```bash
psql "$TARGET_URL" -tA -f /dev/stdin <<'SQL'
select 'ROWS  '||t.table_name||' = '||
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.table_name), false, true, '')))[1]::text
from information_schema.tables t
where t.table_schema='public' and t.table_type='BASE TABLE' order by 1;
select 'IDX   '||c.relname||' = '||count(*) from pg_index i join pg_class c on c.oid=i.indrelid
  join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' group by c.relname order by 1;
select 'FK    '||c.relname||' = '||count(*) from pg_constraint co join pg_class c on c.oid=co.conrelid
  join pg_namespace n on n.oid=co.connamespace where n.nspname='public' and co.contype='f' group by c.relname order by 1;
SQL
```

Kör den mot källan och mot målet, `diff` utdatan. Tom diff = godkänt.

## Verifierad restore (bevis)

**2026-08-28, mot en riktig produktionsdump** (`eken-prod-20260828T084632Z.dump`,
2 055 314 byte, `pg_dump -Fc -Z 9`, sha256 `99d3d99874a7de97…`):

- `pg_restore` till tomt PG 18.6-kluster: **exit 0**, 0 fel, 0 varningar, **1,66 s**.
- Måldatabasen bevisat tom före körningen (0 tabeller, 0 relationer, 0 enum-typer).
- Jämförelse prod vs återställd: **341/341 mätpunkter identiska** — 88 radantal,
  88 index-per-tabell, 78 FK-per-tabell, 77 enum-storlekar, 10 aggregat.
- `prisma migrate status`: `Database schema is up to date!`
- API mot den återställda databasen: `/v1/health` = `ok` / `database: up`,
  `legalKnowledge` 427 = 427; register + login + skyddade läsningar 200.
- **Negativkontroll:** samma procedur mot en 90 %-stympad kopia — `pg_restore`
  exit 1, 212 avvikande mätpunkter, `prisma migrate status` exit 1, skrivning
  fälld på `42P10`. Proceduren skiljer bevisligen en hel dump från en trasig.
- Prod jämfördes före och efter hela testet: identisk på alla 341 mätpunkter,
  inga skrivningar.

> Den TIDIGARE beviströraden här beskrev en round-trip av **utvecklings**-databasen
> med **71 tabeller**. Den var inaktuell — schemat har 88 tabeller — och mätte
> dessutom fel databas. Kör om det som står ovan minst kvartalsvis, mot en dump
> hämtad ur R2, och uppdatera datumet. En backup som aldrig testats är ingen backup.
