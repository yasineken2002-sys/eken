# Införandeunderlag: bankfixarna #891 och #892

Oberoende införandegranskning. **Ingen merge, deploy, aktivering eller
framåtpropagering har utförts.** Ingenting nedan är en beställning; det är ett
beslutsunderlag för ägaren och Codex.

Allt som står som mätt är mätt av den här granskningen 2026-09-13 mellan 13:14Z
och 13:27Z. Källa och tidpunkt står vid varje tal. Det som inte gått att belägga
står under **OVERIFIERAT** och säger vilket bevis som saknas — det har inte
ersatts med utvecklingsdatabasen.

---

## 0. Sammanfattning för den som bara läser ett stycke

Tre saker avgör införandet, och de pekar åt olika håll.

1. **Varje merge till `main` är en produktionsdeploy av API:t inom sekunder, och
   `prisma migrate deploy` kör 2,5–3 minuter innan CI ens svarat.** Mätt på fyra
   raka mergar. Det finns ingen grind mellan merge-knappen och produktionens
   schema — Railways egen "Wait for CI" (`checkSuites`) finns men är avstängd.
   Under utrullningen kör **gammal kod mot nytt schema i ~69 sekunder** (mätt på
   tre utrullningar; den gamla containern går hela dräneringstaket varje gång).
   Slutsatsen: det får ske **en enda** merge till `main` för hela stacken, och
   först när kombinationen är komplett.
2. **Den uppmätta sprängradien är nära noll.** Produktionen har 2 organisationer,
   0 rader i `BankStatementImport`, 0 banktransaktioner, 0 fakturor och 2
   annullerade hyresavier. Backfillen kommer att sätta värde på **noll rader**,
   och färskhetsgrinden kommer inte att pausa någon. Den riskbild Codex beskriver
   i sin egen införandespärr är korrekt som mekanik men gäller en datamängd som
   inte finns ännu.
3. **Det finns ingen aktuell återställningsbar backup.** Produktionen larmar om
   det själv varje dygn: *"databasbackupen kör INTE i produktion … Det finns
   dessutom ingen dump alls i lagringen."* Den färskaste dumpen som existerar är
   manuell, 16 dygn gammal, 48 migrationer efterlämnad och aldrig
   återställningstestad. Det är den invändning som väger tyngst, och den gäller
   oavsett hur liten den här ändringen är.

Utöver det finns ett kodfynd som inte är ett merge-hinder men kräver ett medvetet
ägarbeslut: **importmarkören är enkelriktad och har ingen väg tillbaka i
produkten** (4.9).

Rekommendationen i korthet: **slå ihop hela stacken uppåt, låt kombinationen få
egen CI, merga en gång, utanför kravtrappans cronfönster** — och ta ett medvetet
beslut om backupfrågan innan, eftersom den inte är specifik för de här PR:erna
men blir synlig av dem.

---

## 1. Arbetssätt och avgränsning

Egen worktree `arbete/claude-inforandeunderlag` på egen gren
`docs/bankfix-inforandeunderlag`, skapad från uppmätt `origin/main`
(`3b71e905d866f461f6b07211bc89b3fa88505200`). Codex arbetskopior och grenar har
inte rörts. Endast dokumentation ändras i den här leveransen.

Ingen rebase, reset, amend, force-push eller lokal provmerge har körts. Inga
tunga byggen eller testsviter har startats — Codex bygger samtidigt på samma
maskin.

Produktionsläsningar har gjorts read-only (`SET default_transaction_read_only =
on`) och enbart som aggregat. Inga kunduppgifter, dokument-ID:n eller
hemlighetsvärden förekommer i underlaget. Där ett variabelvärde behövde
bekräftas jämfördes hash mot hash enligt regeln i `CLAUDE.md`.

---

## 2. Den verkliga leveransvägen — mätt

### 2.1 Utgångsläge

| Sak | Värde | Källa och tid (UTC) |
| --- | --- | --- |
| `origin/main` | `3b71e905d866f461f6b07211bc89b3fa88505200` | `git fetch origin` i `repository.git`, 13:15Z |
| Produktionens revision | `3b71e905d866f461f6b07211bc89b3fa88505200` | `GET /v1/health` fältet `revision`, 13:16Z |
| Senaste produktionsdeploy | `73ada601…`, skapad 2026-09-12T15:53:17.052Z | Railway GraphQL `deployments`, 13:18Z |
| Appen lyssnade | 2026-09-12T15:55:38.319Z (+2 min 21 s) | Railway-loggen för samma deploy |
| Cronmotorns start | 2026-09-12T15:55:37.665Z | `/v1/health` fältet `cron.bootAt` |

**Produktionen kör alltså exakt `main`.** Ingen glidning att ta hänsyn till.

### 2.2 PR:erna

| PR | Gren | Bas | HEAD | Läge | CI |
| --- | --- | --- | --- | --- | --- |
| #891 | `codex/betalningsfarskhet-skydd` | `main` | `ed993decf799b6d0d32322471dc7ba4f1e526c38` | utkast, MERGEABLE/CLEAN | **61/61 pass** (körning 34751046040) |
| #892 | `codex/betalningsfarskhet-filfel` | `codex/betalningsfarskhet-skydd` | `39084309279b5bb300b7a783652777fd88f62fdd` | utkast, MERGEABLE/CLEAN | **61/61 pass** (körning 34756463607) |
| #889 | `codex/betalningsfarskhet-reproduktion` | `main` | `88d5fc38d760359375351e66746230dd4a483a41` | utkast, BLOCKED | **2 fail / 59 pass** (`Tests`, `CI passed`) |
| #886 | `codex/agent3-api-release-grind` | `main` | `316507fd8b5acaece65608b9cacd7c045d6d4e34` | utkast | 61/61 pass |
| #890 | `codex/api-release-tokenkontrakt` | `codex/agent3-api-release-grind` | `942306d794f06145eb1cea374395118487e77eb8` | utkast | 61/61 pass |

Belopps-PR:en: grenen `codex/bankimport-strikta-belopp` finns **bara lokalt**
(`73ea9f606aee…`, 13:06Z), är inte pushad till `origin` och har ingen PR. Den
ligger en commit ovanför #892:s HEAD, och den commiten är hittills bara
testförebevis. **Numret och utfallet är alltså okända och gissas inte här.**

### 2.3 Vad en merge till `main` faktiskt utlöser

Mätt via Railway-API:t 13:17–13:18Z, projekt `poetic-strength`, miljö
`production`:

```
deploymentTrigger   branch = main      checkSuites = FALSE
serviceInstance     watchPatterns = [] preDeployCommand = null
                    healthcheckPath = /v1/health   healthcheckTimeout = 300
                    numReplicas = null, region = null   (inga överskrivningar)
deploy-manifestet   numReplicas = 1 (multiRegionConfig.us-west2)
                    overlapSeconds = null   drainingSeconds = null
tjänstvariabel      RAILWAY_DEPLOYMENT_DRAINING_SECONDS finns; värdets hash
                    är identisk med hashen av "60"
```

Att deployen hinner före CI är mätt på **fyra raka mergar**, inte härlett:

| squash-sha | migrate deploy på prod | ny kod live | main-CI klar efter |
| --- | --- | --- | --- |
| `3b71e905` | 15:55:36.478Z | 15:55:38.3Z | **+3 min 02 s** |
| `e483daaf` | 14:57:08.03Z | 14:57:10.0Z | **+3 min 10 s** |
| `676d0368` | 14:02:58.95Z | 14:03:00.8Z | **+2 min 32 s** |
| `975db9c5` | 13:40:40.6Z | 13:40:43.1Z | **+2 min 34 s** |

Inga andra spärrar finns att missa, kontrollerat 13:30Z:
`gh api repos/…/environments` ger 8 miljöer, **samtliga** med
`protection_rules: []` och `deployment_branch_policy: null`.
`allow_auto_merge: false` → ingen merge queue. Railway: `projectTokens: []`,
`project.members: []`, `teamId: null`, plan *hobby* → ingen RBAC och inga
deployment approvals; en sökning i Railways GraphQL-schema efter `approval` ger
**noll träffar** — funktionen finns inte att slå på. Och `deploy.yml` innehåller
bara `gate`, `deploy-web`, `deploy-admin`, `deploy-portal`: **inget API-jobb
alls.** CI-grinden i `deploy.yml` skyddar frontend, aldrig Railway.

**Hålet är ett fältbyte brett.** `checkSuites` är Railways egen "Wait for CI",
den finns, och den är den enda spärr som faktiskt hade stängt det här. Att slå på
den är en driftändring och ligger utanför den här uppgiften — men den bör stå med
som ett alternativ för ägaren, eftersom den gör hela avsnitt 3:s
ordningsdisciplin till mekanik i stället för till en rutin någon måste minnas.

Av detta följer, och det stämmer med det som redan står mätt i `CLAUDE.md`:

- **API:t (Railway).** Varje push till `main` ger en deploy, oavsett vad commiten
  rör — `watchPatterns: []` betyder ingen sökvägsfiltrering. `checkSuites` är
  **avstängd**, inte frånvarande: funktionen finns, men Railway väntar inte på
  GitHubs checkar. Deployen startar ett par sekunder efter merge; main-CI blir
  klar fyra–fem minuter senare.
- **Migrationen.** `apps/api/scripts/migrate-and-start.sh` kör
  `prisma migrate deploy` och *därefter* `node dist/main.js`, i **samma**
  container. Det finns ingen `preDeployCommand`. Schemat ändras alltså före den
  nya servern startar, och medan den gamla fortfarande betjänar trafik.
- **Webb/admin/portal (Vercel).** Grindade hela vägen: `deploy.yml` triggas på
  `workflow_run` när CI är klar på `main`, ett `gate`-jobb fäller på
  `conclusion ≠ success`, och varje deployjobb checkar ut CI:ns granskade sha.
  Ett grönt deployjobb kan ändå betyda att `turbo-ignore` hoppade över appen —
  det syns bara i loggen.
- **Worker- och cronprocesser.** Det finns **inga separata processer**. Alla
  `@Cron`-jobb och alla BullMQ-`@Processor` körs in-process i samma
  API-container (`ScheduleModule.forRoot()` aktiveras när
  `NODE_ENV=production`). En enda replika. "Stoppa gamla workers" är alltså
  identiskt med "den gamla containern avslutas", inget separat moment.

### 2.4 Kravtrappans cronfönster

`@Cron`-uttrycken saknar `timeZone`, och containern kör UTC. Det är avläst direkt
ur produktionsloggen i dag, inte härlett:

```
2026-09-13T10:00:05Z  [RentReminderService] Hyrespåminnelser: 0 skickade …
2026-09-13T11:00:07Z  [RentReminderService] Inkasso-redo: 0 klara …
2026-09-13T12:00:01Z  [RentBadDebtService]  Befarad kundförlust: 0 omklassade …
```

Kontrollprov åt andra hållet: jobb som **har** `timeZone: 'Europe/Stockholm'`
(`notifications.service.ts:549`, `'0 7 * * 1-5'`) körde `05:00:00.819Z`. Jobb
med tidszon ligger på Stockholm, jobb utan på UTC.

| Jobb | Uttryck | Nästa körning efter 13:27Z 2026-09-13 |
| --- | --- | --- |
| `escalateOverdueRentNotices` (påminnelseavgift) | `0 10 * * *` | 2026-09-14 10:00Z |
| `escalateRemindedToInkassoReady` | `0 11 * * *` | 2026-09-14 11:00Z |
| `reclassifyProbableLosses` (befarad kundförlust) | `0 12 * * *` | 2026-09-14 12:00Z |

(= 12:00 / 13:00 / 14:00 svensk sommartid.)

Det ger ett konkret, verifierbart deployfönster (avsnitt 6).

### 2.5 #886/#890 är inte en driftgrind

Förslagen är **kodförslag**, inte drift. `apps/api/scripts/release-gate.cjs`
säger det själv i sin första rad: *"Inaktiv kandidat. Inget startup-script eller
Railway-kommando anropar denna fil."* Det #886 lägger till i `ci.yml` är två
CI-steg som verifierar ett manifest; ingenting i den ändringen rör
`deploymentTrigger.checkSuites`, som är avstängd i Railway och mätt avstängd i
dag 13:17Z.

**Att #886 och #890 har grön CI säger alltså ingenting om att API-deployen skulle
vara grindad.** Den är det inte, varken före eller efter en merge av dem. De får
inte räknas som en förutsättning som är uppfylld.

### 2.6 Vem och vad kan utlösa en produktionsdeploy

Allt utgår från **ett enda konto** (`gh api …/collaborators` ger en rad;
`project.members` är tom).

| Väg | Går CI-grinden? |
| --- | --- |
| Merge/push till `main` via GitHub | `CI passed` krävs på shan — men **Railway väntar inte**, deployen startar ~2 s efter merge |
| Railway-konsolens *Redeploy* / `railway redeploy` | **kringgår helt** |
| `railway up` från valfri katalog | **kringgår helt — deployar oincheckad lokal kod** |
| `railway restart` | ingen ny kod, men ny `migrate deploy` och ny SIGTERM-cykel |
| `railway ssh` / `railway connect` | skriver till prod utan deploy alls |

Ingen av dem skiljer sig åt i spåren: `meta.reason` är `'deploy'` på samtliga sex
senaste deployer. **Under steg 1–4 i planen (avsnitt 6) får ingen av de fyra
nedersta vägarna användas**, eftersom de kringgår hela ordningen.

### 2.7 Två luckor i grenskyddet som inte gäller den här stacken men bör noteras

Rulesetet `main` (aktivt, tom bypass-lista) har exakt två regler: `deletion` och
`required_status_checks` med `CI passed`. Det betyder:

- **Ingen `pull_request`-regel** — ingen granskning krävs för att merga.
- **Ingen `non_fast_forward`** — force-push till `main` är inte blockerad.
- **`strict_required_status_checks_policy: false`** — grenen behöver inte vara à
  jour med `main`. CI kan alltså ha granskat ett annat träd än det som hamnar på
  `main` och deployas.

Den sista är den som är relevant här: eftersom stacken mergas sist av allt är
risken att `main` hinner röra sig under steg 1–4. **Kontrollera därför att
`origin/main` fortfarande är `3b71e905…` omedelbart före steg 5** — annars ska
kombinationen få `main` inmergad och en ny CI-körning innan den går in.

---

## 3. Stacken — plan utan osäkra mellanlägen

### 3.1 Stackens verkliga form

Kedjan är **linjär**, inte ett träd:

```
main (3b71e905)
  └─ e48685fc  dc437566  b86cd2ae  88d5fc38   ← #889:s commits
      └─ 6fb08495 … ed993dec                  ← #891:s HEAD
          └─ 4fb6cbce  7f87ade0  39084309     ← #892:s HEAD
              └─ 73ea9f60 (lokal, belopp — pågår)
```

**Fynd som måste upp på bordet: #891 innehåller #889:s commits.** `88d5fc38` —
#889:s HEAD — är en förfader till `ed993dec`. Direktivet "#889 ska inte mergas"
går att följa som PR-handling, men *innehållet* i reproduktionsbeviset når `main`
ändå, via #891. Det är sannolikt avsett (ett rött reproduktionsprov som blir ett
grönt regressionsprov när fixen är på plats — reproduktionsfilen växer från 1 489
till 1 573 rader i stacken), men det ska bekräftas uttryckligen av ägaren och
inte upptäckas efteråt.

Följden: **#889 ska stängas, inte mergas och inte heller lämnas öppen** när
stacken gått in. Efter en squash-merge är dess commits inte längre förfäder till
`main` som sha:er, och PR:en blir en förvirrande dubblett av innehåll som redan
ligger inne.

### 3.2 Varför ett mellanläge inte får gå ut

`#891` ensam i produktion betyder: importförsöket registreras och pausar krav vid
saknat datum — men **#892:s rättning saknas**, alltså kan en CSV med giltigt
datum och ogiltigt belopp fortfarande flytta fram täckningsdatumet och släppa
igenom en avgift. Det är precis den defekt (F19) som #892 finns till för, och
den står redovisad som *öppen risk* i #891:s egen rapport.

Eftersom varje merge till `main` deployar direkt, är "vi mergar #891 nu och #892
om en stund" inte en pappersövergång utan ett skarpt produktionsläge under hela
mellantiden, plus **två** migrate-körningar och **två** containerbyten. Det ska
inte ske.

### 3.3 Rekommenderad ordning — sammanför uppåt, merga en gång

Alla steg utom det sista rör **inte** `main` och utlöser **ingen** deploy.

| # | Åtgärd | Målgren som behöver klartecken | Vad som händer |
| --- | --- | --- | --- |
| 1 | Belopps-PR öppnas med bas `codex/betalningsfarskhet-filfel` | — | Ingen deploy. CI kör på belopps-PR:en. |
| 2 | Merga belopps-PR **in i** `codex/betalningsfarskhet-filfel` | `codex/betalningsfarskhet-filfel` (#892:s gren) | Ingen deploy. #892:s CI kör om med beloppsrättningen inne. |
| 3 | Merga **#892 in i** `codex/betalningsfarskhet-skydd` | `codex/betalningsfarskhet-skydd` (#891:s gren) | Ingen deploy. **#891:s CI kör nu på hela kombinationen mot `main`.** |
| 4 | Granska #891:s slutdiff mot `main` och läs CI **på HEAD-shan**, inte på PR-numret | — | Detta är den samlade granskningen och kombinationens egen CI. |
| 5 | Merga #891 till `main` | `main` | **En** deploy, **en** `prisma migrate deploy`, **ett** containerbyte. |
| 6 | Stäng #889 och #892-resterna, radera grenar manuellt | — | Ingen deploy. |

Två målgrenar behöver alltså uttryckligt klartecken innan `main`:
`codex/betalningsfarskhet-filfel` (steg 2) och `codex/betalningsfarskhet-skydd`
(steg 3).

**Historiken bevaras** genom att steg 2 och 3 görs som *merge-commits*, inte
squash och inte rebase. De granskade sha:erna (`ed993dec`, `39084309`,
belopps-HEAD) blir kvar som förfäder och går att peka på i efterhand. Hur steg 5
görs mot `main` är ägarens val; repots mätta konvention är squash (alla tio
senaste mainline-commits har formen `… (#NNN)`), och det är också den form som
`/v1/health`-verifieringen i avsnitt 6 utgår från.

### 3.4 Två fällor som är mätta och inte får upprepas

- **`--delete-branch` får inte användas på en PR som är bas för en annan.**
  `CLAUDE.md` dokumenterar det mätt (#447): den beroende PR:en stängs automatiskt
  och går **inte** att återöppna — `gh pr reopen` och `gh pr edit --base` avvisas
  båda på en stängd PR. Repots `delete_branch_on_merge` är `false` (avläst
  13:25Z), så automatiken är av, men CLI-flaggan kan fortfarande skickas för
  hand. Radera grenar först i steg 6.
- **`gh pr checks <nummer>` kan svara om en äldre körning.** Efter varje push och
  varje merge in i grenen: fråga på **shan**, inte på numret. Annars ser en
  helgrön lista ut som ett godkännande av fel commit.

### 3.5 Alternativ om ägaren hellre vill ha #892 som PR mot `main`

I stället för steg 3: `gh pr edit 892 --base main` medan #892 är **öppen**, och
merga #892. Kedjan är linjär, så diffen blir densamma. Nackdelen är att
granskningshistoriken ligger på #891, och att #891 då måste stängas utan merge —
lätt att förväxla med "den gick aldrig in". Det är därför andrahandsvalet.

### 3.6 Villkoret som ännu inte är uppfyllt

Belopps-PR:en är ett **öppet beroende**. Den finns inte på `origin`, den har
inget nummer, och dess enda commit ovanför #892 är hittills förebevis. Ingen
slutlig bedömning av kombinationen kan göras förrän dess levererade HEAD och CI
finns. Steg 1–6 ovan är ordningen; startsignalen är Codex leverans.

---

## 4. Migrationen och de gamla processerna

### 4.1 Vad migrationen faktiskt gör

`apps/api/prisma/migrations/20260913090000_payment_import_start/migration.sql`,
en enda ny migration i hela stacken (`main` har 184 migrationskataloger, stacken
185, diffen är exakt den här). **Den införs av #891** (commit `87c6685a`); #892
tillför ingen migration alls — dess diff mot #891 rör fem filer, ingen under
`prisma/`:

1. `ALTER TABLE "Organization" ADD COLUMN "paymentImportStartedAt" TIMESTAMP(3);`
2. Backfill: `UPDATE "Organization" … FROM (SELECT "organizationId",
   MIN("uploadedAt") FROM "BankStatementImport" GROUP BY 1)`.
3. `CREATE FUNCTION payment_import_started_immutable()` + `CREATE TRIGGER … BEFORE
   UPDATE OF "paymentImportStartedAt" ON "Organization"` som fäller med
   `ERRCODE 23514` om ett redan satt värde ändras.

Backfillen ligger alltså **inuti migrationen**, inte som ett separat jobb.

### 4.2 Produktionens faktiska tillstånd (read-only, 13:21Z)

| Mätpunkt | Värde |
| --- | --- |
| PostgreSQL | 18.6 |
| Tabeller / rader totalt / storlek | 106 / 1 562 / 26 MB |
| `Organization` | **2** |
| — med `paymentDataThrough` satt | **0** (båda NULL) |
| — `paymentDataStaleDays` | 3 för båda |
| — `paymentDataStaleAlertedAt` satt | 0 |
| `BankStatementImport` | **0 rader** |
| `BankTransaction` / `BankConsent` | 0 / 0 |
| `RentNotice` | 2, **båda `CANCELLED`** |
| `Invoice` / `JournalEntry` | 0 / 12 |
| `Tenant` / `Lease` / `User` | 2 / 2 / 2 |
| `paymentImportStartedAt` finns redan? | **Nej** (0 kolumner) |
| `_prisma_migrations` avslutade | **184** — exakt lika många som `main` har kataloger |

**Vad det betyder konkret:** backfillen träffar noll rader eftersom
`BankStatementImport` är tom. Båda organisationerna får `paymentImportStartedAt =
NULL`. Med NULL-markör och NULL-täckningsdatum är utfallet av `evaluate()`
`stale: false` — grinden engagerar **inte**. **Ingen organisation pausas av den
här migrationen.** Och det finns inga aktiva hyresavier för kravtrappan att
eskalera: de två som finns är annullerade.

### 4.3 Den rullade migrationsraden är inte ett hinder — mätt, inte antaget

`_prisma_migrations` har 185 rader men bara **184 distinkta migrationsnamn**.
Skillnaden är `20260429222436_tenant_email_unique`, som finns i **två** rader
(läst 13:33Z):

```
started 2026-04-29 22:32:12Z   finished NULL              rolled_back 23:52:44Z   steps 0
started 2026-04-29 23:58:56Z   finished 23:58:57Z         rolled_back NULL        steps 1
```

Migrationen föll alltså på `23505`, rullades tillbaka manuellt med
`prisma migrate resolve`, och kördes sedan om med lyckat utfall. Det är viktigt
att det är **två** rader: hade bara den tillbakarullade funnits hade migrationen
räknats som *pending* och `migrate deploy` hade försökt köra om den och fallit
igen. Nu är 184 distinkta namn = 184 kataloger på `main` → **inga väntande
migrationer**, och stacken lägger till exakt en.

Den är däremot **precedensen** för vad ett migrationsfel kostar här:
återställning krävde ett manuellt `migrate resolve` plus en omkörning — en och en
halv timme mellan de två raderna — inte en automatik. Se avsnitt 5.3.

### 4.4 Hur gamla producenter och workers stoppas

Eftersom crons och köworkers körs in-process i den enda API-containern finns det
inget separat moment att stoppa. Sekvensen vid en Railway-utrullning är:

1. Ny container byggs och startar. `prisma migrate deploy` kör → **schemat är
   nytt medan den gamla containern fortfarande betjänar trafik och kör crons**.
2. Den nya servern lyssnar och `/v1/health` går grönt → Railway markerar deployen
   som online.
3. **Först då** får den gamla containern SIGTERM. `app.enableShutdownHooks()` i
   `main.ts` ger en SIGTERM-lyssnare; Bulls `close()` börjar med `pause(true)`
   och slutar hämta **nya** jobb i samma ögonblick. Taket är
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` = 60 s (verifierat via hash), därefter
   SIGKILL.

**Överlappsfönstret — nytt schema med gammal kod — är mätt, inte uppskattat.**
Ur Railway-loggarna för de tre senaste utrullningarna:

```
ny container: migrate deploy klar   15:55:36.478Z
ny container: API lyssnar           15:55:38.319Z   (+1,84 s)
GAMMAL container: SIGTERM           15:55:43.188Z   (+4,87 s efter listen)
GAMMAL container: Stopping          15:56:45.416Z   (+62,23 s efter SIGTERM)
                                    ───────────────
ÖVERLAPP (nytt schema ↔ gammal kod)      68,94 s
```

De två föregående utrullningarna gav **67,93 s** och **68,56 s**. Den gamla
containern gick **hela dräneringstaket** i alla tre fallen (62,23 / 61,81 /
61,96 s) och stoppades vid taket — vilket bekräftar de 60 sekunderna empiriskt.

Två saker följer av det, och de är viktigare än talet självt:

- **Kommentaren i `main.ts:194` gäller inte drift.** Den säger att 2 564 ms är
  golvet för en ren stängning. I produktion exiterar processen inte själv — den
  blir stoppad vid taket, varje gång. Under ~62 sekunder kan gammal kod alltså
  fortfarande fullborda BullMQ-jobb och HTTP-requests **mot det nya schemat**.
- **69 s är en undre gräns.** Alla tre mätta utrullningarna loggade `No pending
  migrations to apply`. Fönstret öppnar när den **första DDL:en committar**, inte
  när migrationsskriptet är klart, och förlängs med migrationens egen körtid. För
  den här migrationen är körtiden mikrosekunder (metadata-only `ADD COLUMN`,
  `UPDATE` på två rader), så ~69 s är en god uppskattning — men det är en
  uppskattning, och den håller bara så länge tabellen inte är låst av något annat
  (se 4.8, punkt 1).

**Vad gammal kod kan göra i det fönstret:**

- Den kan **inte** skriva `paymentImportStartedAt` — den känner inte kolumnen, och
  Prisma listar kolumner explicit, så den extra kolumnen stör inte gamla
  `SELECT`. Triggern fyrar bara på `UPDATE OF` just den kolumnen och kan därför
  inte träffas av gammal kod.
- Den **kan** ta emot en första bankimport utan att registrera markören. Följden
  vore att organisationen har importhistorik men `paymentImportStartedAt = NULL`
  — och då engagerar grinden inte; hålet från #889 skulle leva kvar för just den
  organisationen tills nästa importförsök på ny kod sätter markören.
- Den **kan** köra kravtrappans crons utan pausgrinden, om utrullningen råkar
  sammanfalla med 10:00Z, 11:00Z eller 12:00Z.

**Åtgärden är ordning, inte teknik:** merga utanför cronfönstret, och se till att
ingen import körs under utrullningen. Med två användare i produktion är det en
avstämning, inte ett driftmoment.

### 4.5 När kan backfillen köras efter sista gamla importen?

Frågan har ett obekvämt men entydigt svar: **backfillen går inte att schemalägga
separat.** Den ligger i migrations-SQL:en och körs därför exakt när den nya
containern startar — mitt i övergången, inte efter den. Det enda sättet att
uppfylla "backfill efter sista gamla importen" med den här migrationen är att
säkerställa att **ingen import pågår eller startar under utrullningsfönstret**.

Mot den uppmätta produktionen är det trivialt: `BankStatementImport` är tom, inga
bankkopplingar finns (`BankConsent = 0`), och de enda vägarna in är autentiserade
`POST`-anrop från två användare. Det finns ingen schemalagd köproducent på den
här basen — PSD2-synken startas av ett uttryckligt behörigt `POST /psd2/sync`.

Vill man ha garantin i mekanik i stället för i avstämning krävs en ändring som
inte finns i dag (t.ex. att lyfta backfillen till ett separat, idempotent
efterjobb). **Det är ett ägarbeslut, och den här granskningen föreslår det inte
som villkor för just den här leveransen**, eftersom det som kan missas i dag är
noll rader.

### 4.6 Vilka skrivningar riskerar annars att missas

Med dagens data: inga. Generellt, när data väl finns:

- En första import som landar på gammal kod under överlappsfönstret → markören
  sätts aldrig av backfillen (den har redan kört) och inte av koden (den är
  gammal) → organisationen får importhistorik med NULL-markör → grinden pausar
  inte.
- Gamla, ospårade CSV/BgMax-försök som aldrig gav en `BankStatementImport`-rad
  kan aldrig backfillas. Det är avsiktligt och står i migrationens egen kommentar
  ("Ospårade gamla CSV/BgMax-fel fabriceras inte") — men det betyder att NULL
  efter införandet inte är ett bevis för att inget försök gjorts historiskt.

### 4.7 Hur man bevisar att rätt version tar trafik och kör jobben

Tre oberoende avläsningar, alla mot `/v1/health` och databasen — inga skrivningar:

```bash
# 1. Kör prod innehållet? (likhet är fel fråga med parallella strömmar)
PROD=$(curl -fsS https://eken-production.up.railway.app/v1/health \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["revision"])')
git merge-base --is-ancestor <squash-shan> "$PROD" \
  && echo "innehållet är ute" || echo "inte inne — deployen är inte klar"

# 2. Är det den NYA processen som äger schemaläggningen?
#    cron.bootAt ska vara senare än merge-tidpunkten.
curl -fsS https://eken-production.up.railway.app/v1/health \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["cron"]["bootAt"])'

# 3. Finns någon gammal backend kvar som kan skriva?
#    Ingen client backend får ha backend_start före den nya containerns bootAt.
psql "$DATABASE_PUBLIC_URL" -At -c "SET default_transaction_read_only = on;
  SELECT backend_start FROM pg_stat_activity
  WHERE datname = current_database() AND backend_type='client backend'
  ORDER BY backend_start LIMIT 5;"
```

Punkt 3 är belagd som körbar (avläst 13:27Z; `pg_stat_activity` svarar via
`DATABASE_PUBLIC_URL`) och är det närmaste ett direkt bevis för att gamla
processer inte längre kan skriva. Med en enda replika räcker den för frågan
"finns någon kvar nu".

**Vad som inte går att belägga, och det ska sägas rakt ut:**

- **Att en gammal BullMQ-körning inte hann skriva klart under de ~62
  dräneringssekunderna.** Railways logg ger plattformens händelse
  (`Stopping Container`), inte processens död, och det finns inget replik-API att
  fråga när `numReplicas = 1`. Det beviset saknas.
- **Att kravtrappan är pausad eller inte, i förväg och för alla organisationer.**
  `/v1/health` listar 13 låsta cronjobb (`cron-heartbeat.ts:45-59`), och
  kravtrappans tre jobb är **inte** bland dem — de är klass B och har inget
  hjärtslag. `/v1/health` kan alltså aldrig svara på om kravtrappan körde. Det
  som finns är en per-org-läsning
  (`GET /v1/notifications/overdue-reminders/preview` → `.freshness.stale`) och
  loggen i efterhand. Ingen av dem är en förhandskontroll.
- **Det finns ingen paus-spak.** "Pausad" är inte en operatörsknapp utan en härledd
  per-org-grind. Enda sätten att stoppa kravtrappan är att ändra `NODE_ENV` (som
  ändrar en mängd annat) eller att göra varje organisations betalningsdata
  inaktuell. **Det finns alltså ingen säker "pausa före merge"-åtgärd** — vilket
  är just därför tidsvillkoret i 6.1 är formulerat som ett cronfönster och inte
  som ett stopp.

**`status: ok` är inte ett acceptanskriterium.** Det är mätt i
`docs/runbooks/db-backup-restore.md`: hälsoindikatorn kör `SELECT 1` och svarade
`ok` mot en 90 % stympad databas.

### 4.8 Fynd från den oberoende databasgranskningen

En separat granskare läste migrationen, schemadiffen, `payment-freshness/`,
`reconciliation/`, `psd2/`, `apps/api/scripts/`, seeds och `ci.yml`. Fynden
nedan är kontrollerade av mig där de gick att kontrollera.

**Bekräftat och ofarligt:**

- `ALTER TABLE … ADD COLUMN` utan default är metadata-only i PG 11+ — ingen
  tabellomskrivning. `UPDATE`:n rör två rader. Körtiden är mikrosekunder.
- Inget namnkrock: repots övriga triggers tillhör `append_only_*`-familjen, och
  `check-append-only.mjs` har ett uttryckligt motprov på att en trigger utan det
  prefixet inte räknas. Den nya triggern fäller alltså ingen vakt.
- Gammal kod är kompatibel med nya schemat: det finns **noll** `SELECT *` i
  `apps/api/src` och `apps/api/prisma`, och schema-drift-vakten är rent CI
  (`ci.yml:1256-1302`), inte en boot-kontroll.
- Ingen befintlig kodväg kan träffa triggern. Samtliga `Organization`-skrivare
  genomsökta; **enda** skrivaren av kolumnen är
  `payment-freshness.service.ts:100`, grindad av `if (!org.paymentImportStartedAt)`
  under exklusivt advisory-lås — `OLD` är alltid NULL där.

**Tre fynd som bör åtgärdas eller uttryckligen accepteras:**

1. **Inget `lock_timeout`.** `ALTER TABLE` tar `ACCESS EXCLUSIVE` på
   `Organization` medan den **gamla** containern fortfarande tar trafik. En öppen
   transaktion som håller lås på tabellen blockerar `ALTER`:n, och `ALTER`:n köar
   i sin tur upp varje efterföljande läsare bakom sig — med
   `healthcheckTimeout = 300` finns gott om tid för det att bli en stall i
   stället för ett fel. `SET LOCAL lock_timeout = '3s';` som första sats kostar
   ingenting och gör värsta fallet till ett rent, snabbt misslyckande.
   *Riskklass, inte uppmätt utfall — ingen profil över långa transaktioner mot
   `Organization` finns.*
2. **Explicit `BEGIN;`/`COMMIT;` är unikt i hela migrationshistoriken** — en
   träff av 185. Prisma skickar filen som en simple-query-batch, som PostgreSQL
   redan lägger i en implicit transaktion; den explicita `COMMIT;` avslutar den
   tidigt. Här är den sista satsen, så atomiciteten är oskadd — men invarianten
   "hela skriptet är atomiskt" är tyst upphävd för allt någon senare lägger
   **efter** `COMMIT`. Ta bort dem; de köper ingenting.
3. **Triggern skyddar inte `INSERT`.** `BEFORE UPDATE OF` fyrar bara på
   uppdateringar. Irrelevant i dag — ingenting skapar organisationer med markören
   satt — men gränsen bör vara skriven, inte antagen.

**En korrigering av min egen beskrivning i 4.6:** backfillkällan är
**strukturellt** ofullständig, inte bara tom. `BankStatementImport` skrivs bara
av PDF-importen (`bank-statement-import.service.ts:92`) och PSD2-synken
(`psd2-sync.service.ts:158`). **CSV- och BgMax-importer skapar aldrig en rad
där.** En organisation som importerat CSV i månader skulle alltså få `NULL` av
backfillen även med full historik. Migrationens egen kommentar erkänner det
("Ospårade gamla CSV/BgMax-fel fabriceras inte"), men följden är värd att säga
rakt ut: **backfillen kan aldrig bli fullständig för CSV/BgMax-organisationer**,
oavsett när den körs. Båda luckorna — den strukturella och den tidsmässiga —
failar dock **öppet**: grinden förblir av. De kan fördröja att skyddet engagerar,
aldrig blockera något.

### 4.9 Markören är enkelriktad, och det finns ingen väg tillbaka i produkten

Det här är granskningens tyngsta kodfynd, och det gäller oavsett datamängd.

`recordImportStarted` committar markören i en **egen transaktion före** validering
och parsning — det är avsiktligt och står i #891:s designrapport. Följden:

- Ett enda misslyckat uppladdningsförsök, eller en PSD2-sync som inte ger daterade
  transaktioner, sätter `paymentImportStartedAt` **permanent**. Triggern avvisar
  varje försök att nollställa den med `23514`.
- Med markör satt och `paymentDataThrough = NULL` ger `evaluate()` `stale: true`
  → påminnelseavgift, ränta, inkasso-redo och automatisk befarad kundförlust
  pausas.
- **Enda vägen ur pausen är en import som går helt igenom.**
  `paymentDataThrough` skrivs på exakt ett ställe
  (`payment-freshness.service.ts:225`, `recordPaymentDataThrough`), och det anropas
  bara från lyckad ingest. Det finns **ingen** admin-, inställnings- eller
  plattformsväg som sätter fältet — `organization-select.ts:108-109` är läsning,
  och `platform-organizations.service.ts` vitlistar det inte i sitt `data`-bygge.
  Verifierat med genomsökning 13:35Z.
- **#892 skärper detta.** Efter rättningen hoppas `advancePaymentFreshness` över
  helt om **någon** rad i filen är felaktig. En trasig rad i en CSV räcker alltså
  för att pausen ska bestå tills en helt ren fil importeras.
- **`23514` är inte felmappat någonstans i koden** (genomsökt: noll träffar på
  `23514` och `PAYMENT_IMPORT_START_IMMUTABLE` utanför migrationen och proven).
  Skulle det någonsin fyra bubblar det som ett rått `P2010`/500.

**Det här är inte ett fel i fixen — det är dess avsedda beteende**, och #891:s
egen rapport säger det: *"Historiska försök + NULL kan även pausa någon som senare
arbetat manuellt; införandet kräver en läsande inventering och separat
ägarbeslut, inget tyst undantag."* Den läsande inventeringen är gjord i det här
underlaget, och svaret är att den i dag inte träffar någon (0 importrader, 0 orgs
med markör). **Men ägarbeslutet återstår**, och det bör tas nu snarare än när en
kund ringer: en organisation som gör ett misslyckat importförsök och därefter går
tillbaka till manuell avstämning blir pausad för alltid, utan väg tillbaka annat
än en direkt databasändring.

Minsta rimliga komplement, om ägaren vill ha en väg tillbaka: en plattformsstyrd
åtgärd som sätter `paymentDataThrough` uttryckligt (med aktör och spår), eller att
triggern tillåter nollställning från en behörig väg. **Ingen av dem finns i
stacken, och den här granskningen föreslår dem inte som villkor för merge** —
bara som ett beslut som bör fattas medvetet.

---

## 5. Återhämtning och kvarvarande risker

### 5.1 Fyra saker som inte är samma sak

| Nivå | Läge i dag | Belägg |
| --- | --- | --- |
| **Tidigare lyckat återläsningsprov** | **JA.** 2026-08-28, mot en riktig produktionsdump: `pg_restore` exit 0, 1,66 s, 341/341 mätpunkter identiska, `prisma migrate status` grönt, API startade mot den återställda databasen. Negativkontroll mot en 90 %-stympad kopia föll på 212 mätpunkter — proceduren skiljer bevisligen en hel dump från en trasig. | `docs/runbooks/db-backup-restore.md` |
| **Aktuell återställningsbar backup** | **NEJ.** Se 5.2. | mätt 13:19Z |
| **Kompatibel appåtergång** | **JA, men enkelriktad.** Gammal kod (`3b71e905`) är kompatibel med det nya schemat: extra kolumn stör inte Prisma, och triggern kan bara fyra på en kolumn som gammal kod aldrig skriver. En app-rollback fungerar alltså. | kodläsning + migrationens trigger-villkor |
| **Återställning av databasen** | **Separat, manuell och riktad.** Det finns ingen down-migration — inte för den här och inte för någon i repot (`find migrations -name '*.sql' ! -name 'migration.sql'` är tom). Att backa schemat kräver handskriven SQL plus `prisma migrate resolve`. **Ordningen är inte fri:** se 5.1b. | `apps/api/prisma/migrations/` |

**En appåtergång återställer inte databasen.** Efter en rollback av appen ligger
kolumnen, backfillen och triggern kvar. Det är i det här fallet ofarligt — men
det är inte en rollback, det är ett halvt tillstånd.

### 5.1b Asymmetrin: koden får backas, schemat får inte backas först

De två riktningarna är **inte** symmetriska, och det är lätt att göra fel i en
incident:

- **Backa koden, behåll schemat → ofarligt.** Gammal kod nämner aldrig kolumnen.
- **Backa schemat, behåll koden → garanterad produktionsincident.** Den nya koden
  selekterar kolumnen explicit på tre ställen
  (`payment-freshness.service.ts:33-40`, `:95`, `:200`). Utan kolumnen får varje
  färskhetsläsning och varje kravcron `42703` — ingen graceful degradation finns.

**Regeln blir därför: app först, schema sedan.** En schemabackning får aldrig
köras medan den nya containern lever. I normal drift kan fallet inte inträffa
(`set -eu` + `migrate deploy` före `exec` betyder att ny kod aldrig startar mot
gammalt schema), men det gäller inte en manuell återställning under press.

### 5.2 Backupläget — den tyngsta invändningen

Produktionen **säger det själv i loggen**, varje dag kl. 09:00Z:

```
2026-09-13T09:00:07Z ERROR [BackupFreshnessService] [backup-freshness] LARM:
databasbackupen kör INTE i produktion — BACKUP_ENABLED är inte satt till "true"
— nattjobbet är avstängt. Det finns dessutom ingen dump alls i lagringen.
```

- Produktionens tjänstvariabler (namnlistning, inga värden, 13:19Z) innehåller
  **ingen** `BACKUP_ENABLED`, `R2_BACKUP_BUCKET`, `R2_BACKUP_ACCESS_KEY_ID` eller
  `R2_BACKUP_SECRET_ACCESS_KEY`. `backup.scheduler.ts:62` gör
  `if (!this.backup.enabled) return`.
- **Att slå på backupen kräver fyra variabler, inte en.** `enabled` faller på
  *första* villkoret (`BACKUP_ENABLED === 'true'`), så isoleringsgrinden har
  aldrig ens utvärderats. Prod har `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY` och `R2_BUCKET_NAME` men **noll** `R2_BACKUP_*`. Sätter
  någon bara `BACKUP_ENABLED=true` faller jobbet i stället på isoleringsgrinden
  (fallback till huvudnycklarna ⇒ tre överlapp) och förblir avstängt — nu med en
  annan orsakstext. Det är en fälla värd att skriva ned innan någon "bara slår
  på" backupen fem minuter före en migration.
- **`/v1/health` säger ändå `cron:daily-backup … lastOutcome: "success"`** och
  `stale: false` (`lastRunAt: 2026-09-13T03:00:00.024Z`).
  `LockService.skrivHjärtslag` skriver hjärtslaget när innehavaren är klar —
  lyckad **eller** kastad — och en tom no-op är "klar". `success` betyder alltså
  *"cron-ticket fyrade och funktionen returnerade"*, inte *"en backup togs"*. Det
  är exakt fällan som `CLAUDE.md` beskriver: **en rad i en statuslista är ett
  spår, inte ett faktum.** Den raden får inte läsas som att backup finns.

Det som finns är två manuella dumpar på en utvecklardator
(`/workspaces/prod-backups`), båda med verifierad sha256 mot sina `.sha256`-filer
och med `.log`-filer som slutar normalt:

| Fil | Datum | Ålder i dag |
| --- | --- | --- |
| `eken-prod-20260713T083710Z.dump` | 2026-07-13 | 62 dygn |
| `eken-prod-20260828T084632Z.dump` | 2026-08-28 | **16 dygn** |

Och sedan den färskaste togs har **48 migrationer** applicerats i produktion —
schemat har gått från 88 till 106 tabeller (mätt 13:26Z).

**Slutsats: det finns ingen återställningspunkt för dagens produktion.** Går
migrationen fel under de mätta ~69 sekunderna är det närmaste man kommer en
16 dygn gammal dump med ett annat schema, på en laptop, som aldrig
återställningstestats. Det är inte ett fel som de här PR:erna orsakar, och det är
inte något den här uppgiften ska bygga — men det är den enskilt tyngsta
invändningen mot att köra något schemarörande, och ägaren bör ta ställning till
det uttryckligen **innan**, inte efteråt. Databasen är 26 MB; en dump är minuter,
inte ett projekt.

**Denna uppgift har varken hämtat eller skapat någon ny produktionsdump.**

### 5.3 Vad som händer vid fel

| Scenario | Faktiskt utfall | Åtgärd |
| --- | --- | --- |
| **Migrationsfel** | SQL:en har egen `BEGIN`/`COMMIT` → ingen halvt applicerad kolumn. `migrate-and-start.sh` kör `set -eu`, så nollskild exit stoppar starten: **den nya containern startar aldrig**. Railway rullar inte ut en container som inte blir frisk, och **den gamla fortsätter serva** — mätt beteende, 2026-08-18. | Läs Railway-loggen. `_prisma_migrations` får en rad med `finished_at = NULL` som **blockerar alla kommande deployer** tills någon kör `prisma migrate resolve`. Precis det som hände 2026-04-29. |
| **Avbruten migrator** (container dödas mitt i) | Transaktionen rullas tillbaka av PostgreSQL. Raden i `_prisma_migrations` kan ändå ligga kvar som ofärdig. | Samma som ovan: manuellt `migrate resolve --rolled-back`, sedan ny deploy. |
| **Misslyckad appstart** (migrationen gick igenom, servern startar inte) | Hälsokontrollen faller, deployen markeras misslyckad, **gamla containern fortsätter serva** — men nu mot det **nya** schemat. Prod och `main` glider isär tyst; `/v1/health` svarar `ok` hela tiden. | Enda beviset är `revision`-fältet. `restartPolicyType = ON_FAILURE`; manifestet löser `maxRetries = 3` ur `railway.toml`. |
| **Blandade gamla/nya versioner** | Med `numReplicas = 1` finns ingen blandning i **trafiken** — men det sekventiella överlappsfönstret i 4.4 är mätt till **~69 s**, varav ~62 s är dränering där gammal kod fortfarande fullbordar jobb mot nytt schema. | Ordning: merga utanför cronfönstret, ingen import under utrullningen. |
| **Oväntad återupptagning av gamla jobb** | Bulls `maxStalledCount` är uttryckligen satt i `app.module.ts`; ett jobb vars worker försvann körs om **från början**. Kravtrappans effekter är idempotenta via verifikat-`sourceId`, men den garantin är #891:s och inte prövad av den här granskningen. | `docs/runbooks/aterupptagningsmotorns-tystnad.md` och `/v1/health`-fälten `cron.staleCount` / `resumption`. |

### 5.4 De redan kända riskerna — vad fixen förbättrar och vad som kvarstår

| Risk | Vad stacken gör | Kvarstår efter merge |
| --- | --- | --- |
| **`matchError` efter lagring** | Ingenting. #892 klassificerar uttryckligen på **utfall**: en returnerad sparad bankrad räknas som godkänd inläsning, och `matchError` som inträffar *efter* lagring behåller sin befintliga policy. | **JA.** En betalning kan lagras, inte matchas, och ändå flytta fram täckningsdatumet och släppa igenom en avgift. **Kräver eget beslut.** |
| **Aktuellt/felaktigt förnyat datum** | #892 stoppar hela körningens datumförnyelse när någon relevant rad saknar giltigt datum/belopp eller inte når bekräftat ingestutfall. Mätt: F19 går från "datum 2026-09-13, avgift 60 kr" till "datum NULL, paus". | **Delvis.** `parseFloat` accepterar numeriska prefix — `123skräp` tolkas som 123, importeras, och datumet flyttas fram (F32, mätt). Det är beloppsrättningens område och alltså **belopps-PR:ens** ansvar, inte #892:s. |
| **Ofullständig banktäckning** | Ingenting, och det sägs rakt ut: ett registrerat datum är inte ett fullständighetsbevis, och `paymentDataThrough` beskrivs nu som *registrerat* importdatum i stället för *komplett* betalningsdata. | **JA.** Konton, blad och rader som aldrig kom med syns inte. **Kräver eget beslut.** |
| **Historiska försök + NULL kan pausa någon som arbetat manuellt** | Markören sätts av backfillen ur `MIN(uploadedAt)`. | **Inaktuellt i dag** (0 importrader), men **blir aktuellt** när data finns. #891:s rapport kräver själv "en läsande inventering och separat ägarbeslut". |

**Grön CI är inte bevis för ett säkert bankflöde.** 61/61 gröna jobb på #891 och
#892 mäter att koden bygger, typar och passerar sviterna — inte att banktäckningen
är komplett eller att matchningen är rätt. De tre kvarstående posterna ovan är
inte testfel; de är medvetet utanför den här leveransens omfattning.

---

## 6. Införandeunderlag

### 6.1 Ordning, förutsättningar, ansvar och stoppvillkor

| Steg | Åtgärd | Ansvarig | Förutsättning / bevis före steget | Verifierbart stoppvillkor |
| --- | --- | --- | --- | --- |
| **0** | Beslut om backup | **Ägaren** | Läget i 5.2 är läst | Går inte vidare förrän ägaren antingen tagit en färsk dump och verifierat den enligt runbookens sex acceptanskriterier, **eller** uttryckligen kvitterat att en migration körs utan återställningspunkt |
| **1** | Belopps-PR levereras och öppnas mot `codex/betalningsfarskhet-filfel` | **Codex** | PR-numret finns, HEAD-sha är känd | `gh pr checks <sha>` grön på HEAD-shan |
| **2** | Merga belopps-PR in i `codex/betalningsfarskhet-filfel` (merge-commit, **utan** `--delete-branch`) | Ägaren | Steg 1 grönt | #892:s CI kör om; grön **på den nya HEAD-shan** |
| **3** | Merga #892 in i `codex/betalningsfarskhet-skydd` (merge-commit, **utan** `--delete-branch`) | Ägaren | Steg 2 grönt | #891:s CI kör om; **61/61 grönt på den nya HEAD-shan** |
| **4** | Granska slutdiffen `origin/main...#891-HEAD` | Ägaren + Codex | Steg 3 grönt | Diffen innehåller exakt en migration och inga främmande filer |
| **5** | Merga #891 till `main` | Ägaren | Steg 4 klart, `origin/main` fortfarande `3b71e905…` (se 2.7), **och** klockan utanför 09:45–12:15 UTC | Se 6.2 |
| **6** | Stäng #889, städa grenar | Ägaren | Steg 5 verifierat | `gh pr list` visar inga öppna PR:er med bas i den här stacken |

**Tidsvillkoret i steg 5** kommer ur 2.4: kravtrappans crons fyrar 10:00Z, 11:00Z
och 12:00Z, och utrullningen tar ett par minuter. Utanför det fönstret kan ingen
kravcron råka köra på gammal kod med nytt schema.

**Ingen import får köras under utrullningen** (4.5). Fönstret är mätt till ~69
sekunder från att migrationen committar till att den gamla containern stoppas.
Med två användare är det en avstämning, inte ett driftmoment.

**Under steg 1–5 får `railway up`, `railway redeploy`, `railway restart` och
`railway ssh` inte användas** (2.6). De kringgår hela ordningen och syns inte som
något annat i spåren.

### 6.2 Verifiering efter merge — i den här ordningen

1. **Innehållet ute:** `git merge-base --is-ancestor <squash-sha> <prod-revision>`
   — fråga på innehåll, inte likhet (parallella strömmar kan låta prod hoppa förbi
   din sha).
2. **Ny process äger schemat:** `/v1/health` → `cron.bootAt` senare än
   merge-tidpunkten, och `cron.staleCount == 0`.
3. **Migrationen tog:** read-only mot databasen — kolumnen finns, triggern och
   funktionen finns, och `_prisma_migrations` har 185 avslutade rader.
4. **Backfillens utfall stämmer med förväntan:** båda organisationerna ska ha
   `paymentImportStartedAt IS NULL`, eftersom `BankStatementImport` är tom. Ett
   annat utfall betyder att en import skedde under fönstret och ska utredas.
5. **Inga gamla backends kvar:** `pg_stat_activity` enligt 4.7.
6. **Grinden beter sig som avsett:** `evaluateForOrg` ska ge `stale: false` för
   båda organisationerna. Ingen paus, inga larm, `paymentDataStaleAlertedAt`
   fortsatt NULL.

Punkt 4 och 6 är de som skiljer "migrationen kördes" från "migrationen gjorde rätt
sak". `/v1/health` ensam duger inte (5.1).

### 6.3 Återhämtningsväg

| Läge | Väg |
| --- | --- |
| Migrationen föll | Gamla containern servar fortfarande. Läs Railway-loggen, kör `prisma migrate resolve --rolled-back 20260913090000_payment_import_start`, rätta, deploya om. **Ingen ny merge behövs för att komma tillbaka** — den gamla versionen är redan den som kör. |
| Appen startar inte efter grön migration | `revision`-fältet avslöjar det. Railway-rollback till föregående deploy återställer **appen**; kolumnen och triggern ligger kvar och är ofarliga för gammal kod. |
| Beteendet är fel efter utrullning | App-rollback via Railway räcker för att stoppa den nya logiken. Databasen backas **inte** av det, och behöver oftast inte backas. Vill man ändå backa schemat: **först** app-rollback (annars `42703`, se 5.1b), **sedan** `DROP TRIGGER payment_import_started_immutable ON "Organization"; DROP FUNCTION payment_import_started_immutable(); ALTER TABLE "Organization" DROP COLUMN "paymentImportStartedAt";` följt av `prisma migrate resolve`. `DROP COLUMN` tar `ACCESS EXCLUSIVE` och flaggas som destruktiv av `annotate-added-migrations.mjs`. Med 0 backfillade rader förloras ingen data av det i dag. |
| En organisation blev pausad och kan inte komma ur det | Enda produktvägen är en import som går helt igenom (4.9). Finns ingen sådan fil krävs en direkt databasändring — det är i dag ingen dokumenterad procedur. |
| Data är skadad | **Ingen väg som håller i dag** — se 5.2. Det är därför steg 0 finns. |

### 6.4 Öppna frågor som kräver Codex eller ägaren

1. **Ägaren:** Ska en färsk, verifierad dump tas före migrationen? (5.2)
2. **Ägaren:** Bekräfta uttryckligen att #889:s commits får följa med in i `main`
   via #891, och att #889 stängs utan merge. (3.1)
3. **Ägaren:** Vilken merge-metod till `main` i steg 5 — squash enligt repots
   konvention, eller merge-commit för att bevara de granskade sha:erna? (3.3)
4. **Codex:** Belopps-PR:ens nummer, levererad HEAD och CI-utfall. Ingen slutlig
   bedömning kan ges utan dem. (3.6)
5. **Codex:** Bekräfta att beloppsrättningen stänger F32 (`123skräp` → 123), eller
   säg att den kvarstår. (5.4)
6. **Ägaren:** De två riskerna som ingen PR i stacken rör — `matchError` efter
   lagring och ofullständig banktäckning — behöver eget beslut, inte tystnad.
   (5.4)
7. **Ägaren:** Ska backfillen lyftas ur migrationen till ett separat idempotent
   jobb innan produktionen har riktig importdata? Inte nödvändigt i dag; blir det
   när `BankStatementImport` inte längre är tom. (4.5)
8. **Ägaren:** Ska Railways `checkSuites` ("Wait for CI") slås på? Det är ett
   fältbyte och skulle göra hela ordningsdisciplinen i avsnitt 3 till mekanik i
   stället för rutin. Det är en driftändring och ligger utanför den här uppgiften.
   (2.3)
9. **Ägaren:** Behöver den pausade organisationen en väg tillbaka i produkten —
   en behörighetsstyrd åtgärd som sätter `paymentDataThrough`, eller en trigger
   som tillåter nollställning från en behörig väg? I dag finns ingen. (4.9)
10. **Codex:** Ska `SET LOCAL lock_timeout = '3s';` läggas först i migrationen, och
    `BEGIN;`/`COMMIT;` tas bort? Två små ändringar i samma fil, båda i #891.
    (4.8)

---

## 7. Invändningar mot planen

1. **"#889 mergas inte" är sant om PR:en och osant om innehållet.** Dess fyra
   commits ligger i #891. Det ska bekräftas, inte antas.
2. **#886/#890 får inte räknas som en driftgrind.** Filen säger själv att den är
   inaktiv, och `checkSuites` är mätt avstängd i dag. Grön CI på dem ändrar
   ingenting om API-deployens ordning.
3. **Backupfrågan är det enda som verkligen bör stoppa.** Allt annat i det här
   införandet är litet och reversibelt. En migration mot en databas utan
   återställningspunkt är det inte, hur liten migrationen än är.
4. **Införandespärren i #891:s egen rapport är formulerad för en produktion som
   inte finns.** "Stoppa/dränera gamla producenter och kravworkers, kör backfill
   efter sista gamla importen" beskriver ett flerinstansigt system med
   importtrafik. Det verkliga systemet är en replika, in-process-crons och noll
   importrader. Att bygga ett stopp/dränerings-moment för det vore att lägga
   procedur ovanpå en risk som inte finns — men formuleringen blir korrekt den dag
   data finns, och bör stå kvar som villkor för **då**, inte för nu.
5. **Backfillen går inte att schemalägga separat med dagens migration.** Påståendet
   "backfill körs efter sista gamla importen" går i dag bara att uppfylla genom
   avstämning, inte genom mekanik. Det ska sägas rakt ut i stället för att lova en
   ordning som SQL:en inte kan hålla.
6. **Backupens av-läge har fel orsak i runbooken, och det spelar roll.**
   Runbooken pekar på isoleringsgrinden; i verkligheten faller `enabled` redan på
   `BACKUP_ENABLED`. Den som "bara slår på backupen" före migrationen får den
   fortfarande avstängd, nu med en annan orsakstext. Fyra variabler krävs. (5.2)
7. **Det finns ingen paus-spak och ingen förhandskontroll av kravtrappan.**
   Planen kan därför inte innehålla ett steg som "pausa kravtrappan före merge" —
   det går inte. Tidsvillkoret är det enda som faktiskt fungerar. (4.7)
8. **Grenskyddet garanterar inte att CI granskade det träd som deployas.**
   `strict_required_status_checks_policy` är `false`. Kontrollen av `origin/main`
   omedelbart före steg 5 är därför inte pedanteri. (2.7)
9. **`/v1/health` och gröna bockar räcker inte som acceptans.** Hälsoindikatorn
   svarade `ok` mot en 90 % stympad databas (mätt), `cron:daily-backup` säger
   `success` om ett jobb som inte tar någon dump (mätt i dag), och ett grönt
   `Deploy Web` kan betyda att appen hoppades över. Acceptanskriterierna i 6.2
   är valda för att vara diskriminerande.

---

## 8. OVERIFIERAT — vilket bevis som saknas

| Fråga | Varför den inte är besvarad | Exakt bevis som behövs |
| --- | --- | --- |
| Överlappsfönstret vid en **riktig** migration | De tre mätta utrullningarna loggade alla `No pending migrations to apply`. ~69 s är därför en **undre gräns** — fönstret öppnar när första DDL:en committar | `[start] running prisma migrate deploy` / `migrations done` och den gamla containerns `Stopping Container`, fångade **under** den här deployen |
| Om den gamla containern exiterar eller `SIGKILL`:as | `Stopping Container` inföll vid exakt dräneringstaket i alla tre fallen, vilket pekar mot SIGKILL, men Railways logg skiljer inte processexit från plattformshändelse | En exit-kod eller en avslutningsrad ur processen själv |
| Om en gammal BullMQ-körning hann skriva klart under dräneringen | Plattformens händelse är inte processens död, och med `numReplicas = 1` finns inget replik-API att fråga | Saknas — ingen mekanism finns i dag |
| Om `@nestjs/schedule` slutar fyra crons i den gamla containern efter SIGTERM | Inte undersökt. Ett kravtrappe-jobb kl. 10:00:00Z mitt i ett deployfönster kan i teorin fyra i **båda** containrarna; jobben är klass B och skyddas bara av `updateMany`-claims, inte av Redis-lås | Ett prov som mäter cronbeteende efter SIGTERM — eller att helt enkelt hålla tidsvillkoret i 6.1 |
| Att `lock_timeout`-risken är reell här | Ingen profil över långa transaktioner mot `Organization` finns | `pg_stat_activity` med `state = 'idle in transaction'` och `query_start` under en normal timme |
| Prisma 5.22:s faktiska hantering av explicit `BEGIN`/`COMMIT` | Ingen DB-skrivning fick göras. Argumentet bygger på PostgreSQL:s implicita multi-satstransaktion | En shadow-DB-replay — sekunder |
| Att schema-drift-vakten ignorerar trigger + funktion | Slutlett ur att Prisma inte modellerar triggers, inte mätt | `migrate diff --from-migrations` mot kombinationens HEAD i CI |
| Att `/workspaces/prod-backups`-dumparna går att återställa | Bara datum, storlek, sha256 och loggens sista rad kontrollerade | `pg_restore --list` plus en provåterställning enligt de sex kriterierna i `db-backup-restore.md` |
| Att en `pg_dump` av **dagens** produktion går att återläsa | Ingen ny dump har hämtats eller skapats — uttryckligen utanför uppgiften | Se ovan |
| Att kravtrappans effekter är idempotenta vid omkörning efter stall | Ligger i #891:s egen bevisplan; inte omprövat här, och inga tunga körningar fick startas | #891:s DB-prov för verifikat-`sourceId` på kombinationens slutliga HEAD |
| Belopps-PR:ens innehåll och utfall | Grenen finns bara lokalt i Codex worktree, ingen PR | Levererad HEAD + CI |
| Om #886:s nya CI-jobb blir obligatoriska för merge | `ci-passed`:s `needs`-lista lästes på `main`, inte i PR-grenen | `needs`-listan i PR-grenens `ci.yml` |
| Om rulesetet blockerar direkt push/force-push till `main` | Skulle kräva ett faktiskt push-försök mot `main` | Inte gjort, och ska inte göras för att ta reda på det |
| Kravtrappans verkliga beteende mot riktig kunddata efter merge | Produktionen har inga aktiva hyresavier (2 st, båda annullerade) | Kan först mätas när det finns data att mäta på |

---

*Mätningarna i det här dokumentet är gjorda 2026-09-13 mellan 13:14Z och 13:27Z
mot `origin/main = 3b71e905d866f461f6b07211bc89b3fa88505200` och produktionens
revision, som var densamma. Ingen skrivning har gjorts mot produktionen, inga
migrationer har körts, ingen merge och ingen deploy.*
