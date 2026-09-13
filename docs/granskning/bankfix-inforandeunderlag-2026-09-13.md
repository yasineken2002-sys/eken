# Införandeunderlag: bankfixarna #891, #892 och #893

**Revision 3 — rättad 2026-09-13.** Ändringslogg i avsnitt 9. Revision 2
rättade Codex åtta invändningar; revision 3 rättar fem kvarstående fel, varav tre
var mina egna motsägelser: att #893 vore ogranskad, att ingen gren bar
kombinationen, och att övergångsrisken "inte finns".

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
   Under utrullningen kör **gammal kod mot nytt schema**: tre utrullningar gav
   68,9 / 67,9 / 68,6 s, och den gamla containern gick hela dräneringstaket varje
   gång. Det är tre observationer, **inte en gräns** för nästa utrullning.
   Slutsatsen: det får ske **en enda** merge till `main` för hela stacken, och
   först när kombinationen är komplett.
2. **Den uppmätta sprängradien var nära noll vid mättillfället.** 13:21Z hade
   produktionen 2 organisationer, 0 rader i `BankStatementImport`, 0
   banktransaktioner, 0 fakturor och 2 annullerade hyresavier. Med det tillståndet
   träffar backfillen **noll rader** och färskhetsgrinden pausar ingen. **Det är
   en ögonblicksbild, inte en egenskap**: den ska mätas om omedelbart före steg 5,
   och den gör inte övergångsrisken obefintlig — mätningen visar själv ett
   överlappsfönster där två kodversioner arbetar mot samma databas (4.4). Codex
   införandespärr är korrekt som mekanik; det som är litet här är sannolikhet och
   omfattning, inte riskens existens.
3. **Det finns ingen *aktuell* återställningspunkt.** Det nattliga backupjobbet
   kör inte — produktionen larmar om det själv varje dygn. Inventeringen
   (avsnitt 5.2) hittade tre äldre artefakter: en Railway-volymögonblicksbild
   från 2026-08-23 som **löper ut 2026-09-22**, och två manuella dumpar från
   2026-08-28 respektive 2026-07-13. Den från 28 augusti **är** återläsningstestad
   med 341/341 mätpunkter, och det lokala exemplarets sha256 stämmer mot
   runbookens registrerade värde — men den är 16 dygn och 48 migrationer gammal.
   Det gamla provet bevisar proceduren, inte dagens återställningspunkt. Det är
   den invändning som väger tyngst, och den gäller oavsett hur liten ändringen
   är.

Utöver det finns ett kodfynd som inte är ett merge-hinder men kräver ett medvetet
ägarbeslut: **importmarkören är enkelriktad och har ingen väg tillbaka i
produkten** (4.9).

Rekommendationen i korthet: **slå ihop hela stacken uppåt, låt kombinationen få
egen CI, merga en gång, utanför kravtrappans cronfönster** — och ta ett medvetet
beslut om backupfrågan innan, eftersom den inte är specifik för de här PR:erna
men blir synlig av dem.

**Underlaget är inte en körbar införandeinstruktion.** Codex har godkänt #893:s
kod inom beställd omfattning (2.2), och kombinationens innehåll finns redan samlat
på #893:s gren (3.6). Två saker saknas fortfarande och kan inte skrivas fram från
skrivbordet: en aktuell återläst backup, och en konkret avskärmningsprocedur för
gamla skrivare med verifierbara stoppvillkor (4.7). Därutöver återstår
sammanföringen till avsedd målgren och verifieringen av slutligt kodträd, aktuell
main-bas och tillhörande CI. Cronfönstret i 6.1 är en försiktighetsåtgärd, inte
ett bevis för att inga gamla jobb kan skriva.

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
| **#893** | `codex/bankimport-strikta-belopp` | `codex/betalningsfarskhet-filfel` | `87bd9b8dc677deb6ff6d12c589d3af5053b5d7e8` | utkast, MERGEABLE/CLEAN | **61/61 pass** (körning 34760333195) |

**Beloppsrättningen är levererad sedan revision 1 skrevs.** PR **#893** öppnades
13:36:49Z mot #892:s gren. Verifierat av mig 2026-09-13 ca 14:05Z, oberoende av
Codex redovisning:

- HEAD `87bd8…` → `87bd9b8dc677deb6ff6d12c589d3af5053b5d7e8`, bas
  `codex/betalningsfarskhet-filfel`, 5 ändrade filer (+843 / −24).
- CI-körning `34760333195` står på **exakt den shan**, `event: pull_request`,
  `status: completed`, `conclusion: success`, och samtliga **61 jobb** har
  `conclusion: success` — noll misslyckade, noll `null`.

**Codex har sedan dess kodgodkänt #893 inom beställd omfattning**, på exakt
`87bd9b8dc677deb6ff6d12c589d3af5053b5d7e8`. Underlaget för godkännandet, som
Codex redovisat det:

- Codex har läst **produktdiffen och importmetoden**.
- En **separat granskare** har granskat testfaciten.
- **Faktisk CI-logg** är verifierad, inte bara checklistans färg: 61 gröna jobb,
  **6 132 API-prov**, **291 nya beloppsobservationer** med **288 testnamn**, samt
  **båda F32-utfallen**.

**Det är ett kodgodkännande — inte ett merge- eller driftgodkännande.** Den här
granskningen har inte själv läst #893:s diff och gör inget eget kodutlåtande;
ovanstående är Codex redovisning, och det som är oberoende verifierat härifrån är
PR-metadata och CI-körningen. Villkoren i 3.6 och 6.4 kvarstår i den del de gäller
sammanföring, slutligt kodträd, main-bas och CI.

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
Rulesetet har noll `merge_queue`-regler → ingen merge queue (2.7). Railway:
`projectTokens: []`,
`project.members: []`, `teamId: null`, plan *hobby* → ingen RBAC och inga
deployment approvals; en sökning i Railways GraphQL-schema efter `approval` ger
**noll träffar** — funktionen finns inte att slå på. Och `deploy.yml` innehåller
bara `gate`, `deploy-web`, `deploy-admin`, `deploy-portal`: **inget API-jobb
alls.** CI-grinden i `deploy.yml` skyddar frontend, aldrig Railway.

**`checkSuites` är en användbar spärr, men den ersätter inte planen.** Railways
egen dokumentation (läst 2026-09-13) anger reglerna, och de är inte
"grön CI krävs":

> *"A workflow that **fails** skips the deployment immediately. A workflow that is
> **skipped** or reports **neutral** never blocks. A workflow that is
> **cancelled** blocks the deployment only if no other workflow on the same commit
> succeeded. If at least one other workflow passed, the cancelled run is ignored
> and the deployment proceeds. If the workflows have not all finished after two
> hours, the deployment is skipped."*

Två saker gör det relevant just här: `deploy.yml` kör också på `main`, så det
finns mer än ett workflow per commit — en **avbruten** CI-körning skulle alltså
kunna ignoreras om `deploy.yml` gick igenom. Och `migration-annotation` ligger
med flit utanför `ci-passed`:s grind.

Att slå på `checkSuites` är en driftändring, ligger utanför den här uppgiften, och
**får inte räknas som en ersättning för aktuellt backupbevis, granskad kombination
eller en säker versionsövergång.** Den bör stå med som ett alternativ för ägaren,
med de begränsningarna utskrivna — inte som "hålet är ett fältbyte brett".

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

Rulesetet `main` (aktivt, tom bypass-lista) har exakt två regeltyper:
`["deletion", "required_status_checks"]` med `CI passed`. Noll regler av typen
`merge_queue` (avläst 14:08Z). **Det är beviset för att ingen merge queue är
inkopplad — inte `allow_auto_merge: false`, som är en annan inställning.**
Klassisk branch protection gick inte att läsa med den här tokenen
(`Resource not accessible by integration`); `CLAUDE.md` uppger den som avstängd,
mätt i #405, och det är inte omprövat här. Av rulesetet följer:

- **Ingen `pull_request`-regel** — ingen granskning krävs för att merga.
- **Ingen `non_fast_forward`-regel** — inget i rulesetet blockerar force-push till
  `main`. Att faktiskt pröva det med en push är uteslutet; konfigurationsbevis ska
  läsas, inte provas.
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
| 1 | **#893 är kodgodkänd** av Codex på `87bd9b8d` (2.2) | — | Ingen deploy. Klart. Steget kvarstår i tabellen som förutsättning för steg 2. |
| 2 | Merga **#893 in i** `codex/betalningsfarskhet-filfel` | `codex/betalningsfarskhet-filfel` (#892:s gren) | Ingen deploy. #892:s CI kör om med beloppsrättningen inne. |
| 3 | Merga **#892 in i** `codex/betalningsfarskhet-skydd` | `codex/betalningsfarskhet-skydd` (#891:s gren) | Ingen deploy. **#891:s CI kör nu på hela kombinationen mot `main`.** |
| 4 | Granska #891:s slutdiff mot `main` och läs CI **på HEAD-shan**, inte på PR-numret | — | Detta är den samlade granskningen och kombinationens egen CI. |
| 5 | Merga #891 till `main` | `main` | **En** deploy, **en** `prisma migrate deploy`, **ett** containerbyte. |
| 6 | Stäng #889 efter verifierad integration | — | Ingen deploy. **Ingen gren behöver raderas** — Codex har svarat att grenradering inte ingår. |

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
  hand. Och enligt Codex svar ska ingen gren raderas alls i den här leveransen —
  det enklaste är därför att aldrig skicka flaggan.
- **`gh pr checks <nummer>` kan svara om en äldre körning.** Efter varje push och
  varje merge in i grenen: fråga på **shan**, inte på numret. Annars ser en
  helgrön lista ut som ett godkännande av fel commit.

### 3.5 Alternativ om ägaren hellre vill ha #892 som PR mot `main`

I stället för steg 3: `gh pr edit 892 --base main` medan #892 är **öppen**, och
merga #892. Kedjan är linjär, så diffen blir densamma. Nackdelen är att
granskningshistoriken ligger på #891, och att #891 då måste stängas utan merge —
lätt att förväxla med "den gick aldrig in". Det är därför andrahandsvalet.

### 3.6 Vad som faktiskt kvarstår

**Rättat i revision 3.** Revision 2 påstod att "ingen gren bär i dag #891 + #892
+ #893 samtidigt". Det var fel, och det motsade dokumentets egen beskrivning av
stacken som linjär i 3.1. Läsande ancestry-kontroll 2026-09-13:

```
git merge-base --is-ancestor <main>    <#891-HEAD>   → JA
git merge-base --is-ancestor <#891>    <#892-HEAD>   → JA
git merge-base --is-ancestor <#892>    <#893-HEAD>   → JA
git merge-base <#893-HEAD> <main>                    → 3b71e905  (= aktuell main)
```

**#893:s gren `codex/bankimport-strikta-belopp` innehåller alltså redan hela
kombinationen** — 17 commits ovanför `main`, 39 filer, +4 628 / −113. Och eftersom
kedjan är linjär och basen är en förfader testade CI-körningen `34760333195` på
`87bd9b8d` i praktiken just den kombinationens innehåll.

Det gör **inte** att sammanföringen är gjord. Kvar står:

1. **Sammanföring till avsedd målgren.** Innehållet ligger på den översta grenen i
   stacken; det är inte samma sak som att #892 och #891 bär det, eller att någon
   PR mot `main` visar det. Ordningen i 3.3 är fortfarande den som ska köras.
2. **Verifiering av slutligt kodträd.** Trädet efter sammanföringen ska vara det
   granskade trädet — inte "härlett ur att det borde bli samma".
3. **Verifiering mot aktuell main-bas.** CI på `87bd9b8d` kördes med
   `codex/betalningsfarskhet-filfel` som bas, inte med `main`. `main` stod stilla
   på `3b71e905` vid mätningen, men det är ett ögonblicksvärde: rör sig `main`
   krävs ny bas, ny CI och ny slutdiff.
4. **Tillhörande CI på den sammanförda HEAD-shan**, frågad på shan och inte på
   PR-numret (3.4).

Ingen slutlig bedömning kan ges förrän 1–4 finns, tillsammans med de två
kvarstående villkoren i 6.4 (aktuell backup, avskärmningsprocedur).

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

**Vad det betyder konkret:** `UPDATE`-satsen i migrationen uppdaterar **noll
organisationer**, eftersom källan `BankStatementImport` är tom. Båda
organisationerna behåller det `NULL` som `ADD COLUMN` gav dem — backfillen sätter
alltså inget värde alls, den träffar ingen rad. Med NULL-markör och
NULL-täckningsdatum ger `evaluate()` `stale: false` → grinden engagerar **inte**.
**Ingen organisation pausas av den här migrationen.** Och det finns inga aktiva
hyresavier för kravtrappan att eskalera: de två som finns är annullerade.

**Detta är ett ögonblicksvärde, inte en egenskap.** Noll importrader vid
mätningen 13:21Z bevisar inte att inget importförsök kan påbörjas senare — vare
sig före, under eller efter utrullningen. Varje slutsats nedan som vilar på
tomheten är därför villkorad av att tillståndet mäts om omedelbart före steg 5.

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
61,96 s) och stoppades vid taket.

**Det är tre observationer, inte en gräns.** Varken en undre eller en övre gräns
för nästa utrullning går att härleda ur dem, och i revision 1 påstod jag
felaktigt att ~69 s var en undre gräns. Vad som faktiskt följer:

- **Kommentaren i `main.ts:194` gäller inte drift.** Den säger att 2 564 ms är
  golvet för en ren stängning med tomma köer. I produktion exiterade processen
  inte själv i något av de tre fallen — den stoppades vid taket. Railways
  dokumentation beskriver just den sekvensen: ny deploy aktiv → överlapp →
  SIGTERM → dränering → *"forcefully stopped with a SIGKILL"*. Under den
  dräneringen kan gammal kod fortfarande fullborda BullMQ-jobb och HTTP-requests
  **mot det nya schemat**.
- **Alla tre mätta utrullningarna loggade `No pending migrations to apply`.**
  Fönstret öppnar när den **första DDL:en committar**, inte när migrationsskriptet
  är klart, och förlängs med migrationens egen körtid. **Den körtiden är inte
  uppmätt för den här migrationen** och ska inte gissas — låsväntan på
  `Organization` (4.8, punkt 1) kan dominera den helt.
- **En replika betyder inte att bara en kodversion arbetar.** Mätningen visar
  motsatsen: under dräneringen lever två kodversioner samtidigt mot samma
  databas. Att trafiken dirigeras till den nya säger inget om vad den gamla
  processens crons och köworkers gör under tiden.

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

Mot den uppmätta produktionen är utgångsläget gynnsamt: `BankStatementImport` är
tom, inga bankkopplingar finns (`BankConsent = 0`), och de enda vägarna in är
autentiserade `POST`-anrop från två användare. Det finns ingen schemalagd
köproducent på den här basen — PSD2-synken startas av ett uttryckligt behörigt
`POST /psd2/sync`.

**Men det gynnsamma utgångsläget är inte en avskärmning, och cronfönstret i 6.1
är en försiktighetsåtgärd — inte ett bevis.** Att tabellerna var tomma 13:21Z
säger ingenting om vad som kan starta under utrullningen. Det som saknas, och som
den här granskningen inte kan skriva fram från skrivbordet, är **en konkret
procedur med verifierbara stoppvillkor för de relevanta skrivarna**: vilka
ingångar som stängs eller bevakas, hur det verifieras att de är stängda, och hur
det verifieras att de öppnats igen efteråt. I den här miljöns storlek kan den
proceduren vara mycket enkel — men den måste finnas och får inte bygga på att
tabellerna var tomma tidigare.

Att flytta backfillen till ett separat idempotent efterjobb skulle flytta
**tidpunkten**, inte lösa problemet: det löser varken saknad historik för
ospårade CSV/BgMax-försök (4.8) eller frågan om vilka skrivare som är aktiva. Det
är alltså ingen avskärmning i sig.

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

Punkt 3 är belagd som **körbar** (avläst 13:27Z; `pg_stat_activity` svarar via
`DATABASE_PUBLIC_URL`), men i revision 1 övertolkade jag den. `backend_start`
anger **anslutningens ålder, inte appversionen**. En gammal process som
återansluter — eller vars pool öppnar en ny anslutning under dräneringen — får en
färsk `backend_start` och blir osynlig för kontrollen. Frågan "finns det backends
äldre än bootAt" är alltså värd att ställa, men ett negativt svar är **inte** ett
bevis för att ingen gammal process kan skriva.

**Vad som inte går att belägga, och det ska sägas rakt ut:**

- **Att en gammal BullMQ-körning inte hann skriva klart under dräneringen.**
  Railways logg ger plattformens händelse (`Stopping Container`), inte processens
  död, och det finns inget replik-API att fråga när `numReplicas = 1`. Det
  beviset saknas.
- **Att ingen gammal skrivare kan återansluta.** Se ovan: ingen av de
  tillgängliga avläsningarna skiljer appversion. Det som skulle krävas är en
  versionsmarkör i anslutningen — `application_name` är tom i dag (avläst
  13:27Z) — eller en procedur som stänger ingångarna i stället för att observera
  dem.
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
  tabellomskrivning. `UPDATE`-satsen träffar noll rader mot dagens källa.
  Körtiden är **inte uppmätt** och uppskattas inte här.
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
   stället för ett fel.

   **Rättat efter Codex granskning:** i revision 1 skrev jag "som första sats".
   Det är fel. `SET LOCAL` gäller bara inom en transaktion, så raden hör hemma
   **efter `BEGIN;`**. Och `lock_timeout` begränsar **varje enskild låsväntan**,
   inte migrationens totala tid — tre sekunder är alltså inte ett tak för
   migrationen. Ett valt värde bör dessutom ha ett mätt återhämtningsförlopp:
   vad händer när timeouten löser ut mitt i en deploy? Det är inte prövat här.
   *Riskklass, inte uppmätt utfall — ingen profil över långa transaktioner mot
   `Organization` finns.*
2. **Explicit `BEGIN;`/`COMMIT;` är unikt i hela migrationshistoriken** — en
   träff av 185. Prisma 5.22 skickar filen som en simple-query-batch
   (`postgres/connection.rs`), som PostgreSQL redan lägger i en implicit
   transaktion; den explicita `COMMIT;` avslutar den tidigt. Här är den sista
   satsen, så atomiciteten är oskadd.

   **Rättat efter Codex granskning: rekommendationen att ta bort dem är
   tillbakadragen.** Att gränsen är implicit i övriga migrationer gör inte den
   här filens explicita gräns felaktig, och en borttagning löser inte det som
   faktiskt är problemet — glappet mellan committad SQL och migrationshistoriken
   (5.3). Behåll dem. Det som kvarstår som en anmärkning är bara att den som
   någon gång lägger till satser **efter** `COMMIT` ska veta att de inte är
   atomiska med resten.
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
| **Kompatibel appåtergång** | **Schemakompatibel — men det är inte samma sak som återställt skydd.** Gammal kod (`3b71e905`) tolererar den extra kolumnen: Prisma räknar upp kolumner, och triggern kan bara fyra på en kolumn som gammal kod aldrig skriver. **Men en rollback återinför exakt de fel som stacken rättar** — färskhetshålet (#889) och F19/F32. Dessutom kör rollback-imagen `migrate deploy` vid start, så en ofärdig migrationsrad kan stoppa även återgången. Se 5.1b. | kodläsning + migrationens trigger-villkor |
| **Återställning av databasen** | **Separat, manuell och riktad.** Det finns ingen down-migration — inte för den här och inte för någon i repot (`find migrations -name '*.sql' ! -name 'migration.sql'` är tom). Att backa schemat kräver handskriven SQL plus `prisma migrate resolve`. **Ordningen är inte fri:** se 5.1b. | `apps/api/prisma/migrations/` |

**En appåtergång återställer inte databasen.** Efter en rollback av appen ligger
kolumnen, eventuella markörer och triggern kvar. Det är inte en rollback, det är
ett halvt tillstånd — och det ska inte kallas ofarligt. En app-rollback ska
beskrivas med målimage, variabler, migrationshistorikens tillstånd och vilket
skydd som därmed försvinner för de riskutsatta vägarna, inte som en knapp.

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

**Och rollback-imagen är inte passiv.** Den kör samma
`migrate-and-start.sh`, alltså `prisma migrate deploy` innan servern startar.
Ligger det en ofärdig rad i `_prisma_migrations` stoppas alltså **även
återgången** — rollback är inte en väg runt ett migrationsproblem, den går rakt
igenom det.

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

#### Vad inventeringen faktiskt hittade

I revision 1 skrev jag att dumpen från 28 augusti *"aldrig återställningstestats"*
och att *"det finns ingen återställningspunkt"*. **Båda var fel**, och den första
motsade dessutom mitt eget avsnitt 5.1. Rättat:

Larmets *"ingen dump alls i lagringen"* avser **appens egen R2-lagring**, som är
den enda `BackupService` känner till. Det utesluter alltså inte artefakter
utanför den — och inventeringen nedan hittade två sådana.

Inventerat 2026-09-13 ca 14:00–14:10Z, tre källor: Railways volym-API,
produktionens tjänstvariabler och katalogen `/workspaces/prod-backups`.

| Artefakt | Datum | Ålder | Läge |
| --- | --- | --- | --- |
| Railway-volymögonblicksbild `Pre-Security-Patch Backup` (id `087bcafc…`) på `postgres-volume` | 2026-08-23T02:08:57Z | 21 dygn | **Löper ut 2026-09-22.** Skapad av plattformen (`creatorId: null`), `scheduleId: null` → engångs, inget schema. `volumeInstanceBackupScheduleList` är **tom** → inga återkommande volymbackuper. Aldrig återläsningstestad. |
| `eken-prod-20260828T084632Z.dump` (lokalt) | 2026-08-28T08:46:32Z | **16 dygn** | 2 055 314 byte. sha256 `99d3d99874a7de97…` stämmer **både** mot filens `.sha256` och mot det värde runbooken registrerade vid provet — det lokala exemplaret är alltså bevisligen samma artefakt som testades. |
| `eken-prod-20260713T083710Z.dump` (lokalt) | 2026-07-13 | 62 dygn | `.sha256` verifierad. |

**Dumpen från 28 augusti ÄR återläsningstestad**, och det står i runbooken på den
granskade main-commiten: `pg_restore` exit 0 på 1,66 s mot ett tomt PG 18.6-kluster,
**341/341 mätpunkter identiska**, `prisma migrate status` grönt, API startade mot
den återställda databasen — plus en negativkontroll mot en 90 %-stympad kopia som
föll på 212 mätpunkter. **Proceduren är alltså bevisad diskriminerande.**

Vad det gamla provet däremot **inte** bevisar är dagens återställningspunkt: sedan
dumpen togs har 48 migrationer applicerats och schemat gått från 88 till 106
tabeller (mätt 13:26Z).

**Avgränsning av påståendet:** det här är vad som inventerats i de tre källorna
ovan. Det är inte ett påstående om att ingen annan kopia kan finnas någon
annanstans — bara att ingen aktuell återställningspunkt har gått att belägga.

**Slutsats: det finns ingen *aktuell* återställningspunkt.** Går migrationen fel
under utrullningen är det närmaste man kommer antingen en volymögonblicksbild från
23 augusti som löper ut om nio dygn och aldrig provats, eller en 16 dygn gammal
dump med 18 tabeller färre än dagens schema. Kravet står därför kvar: **en aktuell
dump, återläst och verifierad enligt runbookens sex acceptanskriterier, innan
migrationen körs.** Databasen är 26 MB. Codex har svarat att alternativet att
kvittera bort detta inte rekommenderas, och den här granskningen delar den
bedömningen.

**Denna uppgift har varken hämtat eller skapat någon ny produktionsdump.**

### 5.3 Vad som händer vid fel

| Scenario | Faktiskt utfall | Åtgärd |
| --- | --- | --- |
| **Migrationsfel** (SQL:en faller) | SQL:en har egen `BEGIN`/`COMMIT` → ingen halvt applicerad kolumn. `migrate-and-start.sh` kör `set -eu`, så nollskild exit stoppar starten: **den nya containern startar aldrig**. Railway rullar inte ut en container som inte blir frisk, och **den gamla fortsätter serva** — mätt beteende, 2026-08-18. | Läs Railway-loggen. `_prisma_migrations` får en rad med `finished_at = NULL` som **blockerar alla kommande deployer, inklusive en rollback-image** (5.1b). Åtgärden är den i 5.3b — inte ett reflexmässigt `resolve`. |
| **Avbruten migrator** (container dödas mitt i) | **Utfallet är okänt, inte "tillbakarullat".** Se 5.3b. | Se 5.3b. |
| **Misslyckad appstart** (migrationen gick igenom, servern startar inte) | Hälsokontrollen faller, deployen markeras misslyckad, **gamla containern fortsätter serva** — men nu mot det **nya** schemat. Prod och `main` glider isär tyst; `/v1/health` svarar `ok` hela tiden. | Enda beviset är `revision`-fältet. `restartPolicyType = ON_FAILURE`; manifestet löser `maxRetries = 3` ur `railway.toml`. |
| **Blandade gamla/nya versioner** | Med `numReplicas = 1` finns ingen blandning i **trafiken** — men det sekventiella överlappsfönstret i 4.4 är mätt till **~69 s**, varav ~62 s är dränering där gammal kod fortfarande fullbordar jobb mot nytt schema. | Ordning: merga utanför cronfönstret, ingen import under utrullningen. |
| **Oväntad återupptagning av gamla jobb** | Bulls `maxStalledCount` är uttryckligen satt i `app.module.ts`; ett jobb vars worker försvann körs om **från början**. Kravtrappans effekter är idempotenta via verifikat-`sourceId`, men den garantin är #891:s och inte prövad av den här granskningen. | `docs/runbooks/aterupptagningsmotorns-tystnad.md` och `/v1/health`-fälten `cron.staleCount` / `resumption`. |

### 5.3b En avbruten migrator lämnar ett OKÄNT tillstånd — inte ett tillbakarullat

Det här är den rättelse från Codex granskning som ändrar en instruktion, och den
är verifierad mot Prisma 5.22:s källa (läst 2026-09-13):

`apply_migrations.rs` kör i ordningen **`record_migration_started` →
`apply_script` → `record_migration_finished`**. SQL:en körs alltså **före**
`finished_at` skrivs. Eftersom den här migrationens sista sats är `COMMIT;` kan
DDL:en, backfillen och triggern vara **fullt committade** medan raden i
`_prisma_migrations` saknar `finished_at` — om processen dör i glappet däremellan.
Prisma kan inte skilja det fallet från ett verkligt SQL-fel: båda ser ut som
`finished_at IS NULL AND rolled_back_at IS NULL`.

**Kör därför inte rutinmässigt `prisma migrate resolve --rolled-back` efter ett
avbrott.** Gör det på ett tillstånd där SQL:en faktiskt gick igenom, och nästa
deploy försöker applicera migrationen igen — som då faller på att kolumnen redan
finns. Det gör läget sämre, inte bättre.

**Ordningen är: mät först, välj sedan — och tre befintliga objekt räcker inte.**
Revision 2 skrev att "svarar 1–3 ja är migrationen applicerad". Det var för
grovt: att en kolumn, en funktion och en trigger *finns* säger ingenting om att de
har rätt **definition**, att backfillen körts, eller att historiken är hel. En
halvvägs applicerad eller manuellt lappad databas kan ge tre ja.

Kontrollera var för sig, read-only, och jämför mot migrationsfilen — inte mot
minnet:

| # | Kontroll | Vad som jämförs |
| --- | --- | --- |
| 1 | Kolumnen `Organization."paymentImportStartedAt"` | Att den finns **och** har rätt typ och nullbarhet (`timestamp(3)`, nullable) |
| 2 | Funktionen `payment_import_started_immutable` | **Kroppens definition** (`prosrc`), inte bara namnet — villkoret `IS DISTINCT FROM`, `ERRCODE 23514` |
| 3 | Triggern `payment_import_started_immutable` på `Organization` | Att den är `BEFORE UPDATE **OF** "paymentImportStartedAt"`, `FOR EACH ROW`, och pekar på rätt funktion |
| 4 | **Backfillutfallet** | Per organisation: `paymentImportStartedAt` mot `MIN("uploadedAt")` ur `BankStatementImport`. Noll rader i källan ⇒ noll satta markörer. Avviker utfallet är migrationen inte den som körts |
| 5 | **Checksumman** | `_prisma_migrations.checksum` för `20260913090000_payment_import_start` mot filens. Skiljer den sig är det inte den här migrationen som kördes |
| 6 | **Samtliga** historikrader för migrationsnamnet | Inte den senaste, inte ett totalantal — alla. `started_at`, `finished_at`, `rolled_back_at`, `applied_steps_count` för var och en (jfr 4.3, där ett namn har två rader) |

**Beslutsregeln:**

- **Alla sex stämmer, och exakt en historikrad saknar `finished_at`** → migrationen
  är applicerad men obokförd. Rätt åtgärd: `migrate resolve --applied`.
- **Inget av schemaobjekten finns, backfillen har inte körts, och historikraden är
  ofärdig** → migrationen är inte applicerad. Rätt åtgärd:
  `migrate resolve --rolled-back`.
- **Allt annat — blandat, oklart eller motsägelsefullt utfall — är fortsatt
  stopp.** En avvikande definition, en checksumma som inte stämmer, ett
  backfillutfall som inte följer källan, eller fler historikrader än väntat
  betyder att tillståndet inte är det migrationen beskriver. Då skrivs ingenting,
  och tillståndet utreds först. Att välja "den mest sannolika" av de två
  åtgärderna på ett oklart underlag är hur ett återställbart läge blir ett
  oåterkalleligt.

**Den här granskningen har inte kört något `resolve`-kommando**, och beslutsregeln
ovan är en beskrivning av vad som ska mätas — inte ett utfört ingrepp.

`migrate resolve` **ändrar historiken, inte schemat eller datan.** Och en lyckad
migration går inte att märka som återställd: `mark_migration_rolled_back.rs`
avvisar det med `CannotRollBackSucceededMigration` när `finished_at` är satt (och
med `CannotRollBackUnappliedMigration` när raden saknas). Instruktionen i revision
1 var därför delvis omöjlig att följa.

### 5.4 De redan kända riskerna — vad fixen förbättrar och vad som kvarstår

| Risk | Vad stacken gör | Kvarstår efter merge |
| --- | --- | --- |
| **`matchError` efter lagring** | Ingenting. #892 klassificerar uttryckligen på **utfall**: en returnerad sparad bankrad räknas som godkänd inläsning, och `matchError` som inträffar *efter* lagring behåller sin befintliga policy. | **JA.** En betalning kan lagras, inte matchas, och ändå flytta fram täckningsdatumet och släppa igenom en avgift. **Kräver eget beslut.** |
| **Aktuellt/felaktigt förnyat datum** | #892 stoppar hela körningens datumförnyelse när någon relevant rad saknar giltigt datum/belopp eller inte når bekräftat ingestutfall. Mätt: F19 går från "datum 2026-09-13, avgift 60 kr" till "datum NULL, paus". | **Delvis.** `parseFloat` accepterar numeriska prefix — `123skräp` tolkas som 123, importeras, och datumet flyttas fram (F32, mätt). Det är beloppsrättningens område och alltså **#893:s** ansvar, inte #892:s. **#893 är kodgodkänd av Codex på `87bd9b8d`, och båda F32-utfallen är verifierade i CI-loggen** (2.2). Risken flyttar därmed från "öppen" till "rättad i den godkända koden, ännu inte i drift". |
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
| **1** | ~~Kodgranska #893~~ — **klart** | Codex | PR, HEAD `87bd9b8d` och 61/61 CI på exakt shan — verifierat (2.2) | **Uppfyllt:** Codex kodgodkännande inom beställd omfattning, med läst produktdiff, separat granskad testfacit och verifierad CI-logg. Inte ett merge- eller driftgodkännande. |
| **2** | Merga belopps-PR in i `codex/betalningsfarskhet-filfel` (merge-commit, **utan** `--delete-branch`) | Ägaren | Steg 1 grönt | #892:s CI kör om; grön **på den nya HEAD-shan** |
| **3** | Merga #892 in i `codex/betalningsfarskhet-skydd` (merge-commit, **utan** `--delete-branch`) | Ägaren | Steg 2 grönt | #891:s CI kör om; **61/61 grönt på den nya HEAD-shan** |
| **4** | Granska slutdiffen `origin/main...#891-HEAD` | Ägaren + Codex | Steg 3 grönt | Diffen innehåller exakt en migration och inga främmande filer |
| **5** | Merga #891 till `main` | Ägaren | Steg 4 klart, `origin/main` fortfarande `3b71e905…` (se 2.7), **och** klockan utanför 09:45–12:15 UTC | Se 6.2 |
| **6** | Stäng #889 | Ägaren | Steg 5 verifierat enligt 6.2 | `gh pr list` visar inga öppna PR:er med bas i den här stacken. Grenar lämnas kvar. |

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

1. **Rätt release kör — och varken ancestry eller en delmängdsdiff räcker.**
   `--is-ancestor` svarar bara att din commit ligger bakåt i historien; en senare
   commit kan ha återställt bort rättningen och ändå ha din sha som förfader.
   **Revision 2:s förslag att diffa två kataloger var också för smalt** — en tom
   diff över `payment-freshness` och `reconciliation` bevisar ingenting om schema,
   effektvägar, beroenden eller driftkonfiguration. Verifiera i stället **hela**
   den godkända releasen:

   ```bash
   PROD=$(curl -fsS https://eken-production.up.railway.app/v1/health \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["revision"])')
   git diff --stat "$PROD" <godkänd-sha>          # ska vara TOM
   ```

   En tom heldiff är kriteriet. Är den inte tom ska **varje** skillnad redovisas
   och godkännas var för sig — inte förklaras bort. Ytorna som måste ingå i den
   bedömningen, och som en katalogbegränsad diff missar:

   | Yta | Varför den måste med |
   | --- | --- |
   | `apps/api/prisma/schema.prisma` + `prisma/migrations/` | Schemat är det som inte går att backa (5.1b, 6.3) |
   | Effektvägarna: `apps/api/src/avisering/`, `apps/api/src/psd2/`, `apps/api/src/ai/tools/` | Kravtrappans tre crons och importmarkörens anropare ligger här, inte i de två katalogerna |
   | `apps/web/src/` | Kombinationen rör fyra webbfiler; en text som säger fel sak om paus är ett kundsynligt fel |
   | `package.json`, `pnpm-lock.yaml` | Ett beroendebyte ändrar den byggda artefakten utan att röra en rad kod |
   | `apps/api/Dockerfile`, `apps/api/scripts/migrate-and-start.sh` | Startsekvensen är det som kör migrationen |
   | `railway.toml`, `railway.json` | Driftkonfiguration: hälsokontroll, omstartspolicy, byggare |
   | `.github/workflows/` | En ändrad grind ändrar vad "grön CI" betyder |

   **Mätt på dagens kombination** (`main…#893-HEAD`, 39 filer, +4 628 / −113):
   den rör `apps/api/src` (25 filer), `docs/granskning` (7), `apps/web/src` (4),
   `apps/api/prisma` (2) och `docs/revision-status.md` — och **ingen** fil under
   `Dockerfile`, `railway*`, `.github/` eller `package.json`/`pnpm-lock.yaml`. Det
   är ett gynnsamt utfall, men det är en mätning på `87bd9b8d` och **ska göras om
   på det sammanförda trädet**, inte antas gälla.

   Har `main` eller driftsversionen gått vidare sedan godkännandet krävs ny bas,
   ny CI och ny bevisbedömning — inte en ny ancestry-fråga.
2. **Ny process äger schemat:** `/v1/health` → `cron.bootAt` senare än
   merge-tidpunkten, och `cron.staleCount == 0`.
3. **Migrationen tog:** read-only mot databasen. Ett totalantal rader räcker
   **inte** (tabellen har redan 185 rader mot 184 distinkta namn, 4.3). Kontrollera
   på namn: `20260913090000_payment_import_start` ska finnas med `finished_at`
   satt, `rolled_back_at` NULL och en `checksum` som stämmer mot filen — och
   schemaobjekten var för sig: kolumnen, funktionen och triggern.
4. **Backfillens utfall stämmer med förväntan:** båda organisationerna ska ha
   `paymentImportStartedAt IS NULL`, eftersom `BankStatementImport` är tom. Ett
   annat utfall betyder att en import skedde under fönstret och ska utredas.
5. **Inga gamla backends kvar:** `pg_stat_activity` enligt 4.7.
6. **Grinden beter sig som avsett:** `evaluateForOrg` ska ge `stale: false` för
   båda organisationerna. Ingen paus, inga larm, `paymentDataStaleAlertedAt`
   fortsatt NULL.

Punkt 1 skiljer "en commit med rätt förfader" från "rätt release". Punkt 4 och 6
skiljer "migrationen kördes" från "migrationen gjorde rätt sak". `/v1/health`
ensam duger inte till någondera (5.1).

### 6.3 Återhämtningsväg

| Läge | Väg |
| --- | --- |
| Migrationen föll eller migratorn avbröts | Gamla containern servar fortfarande. **Mät tillståndet enligt 5.3b innan något skrivs** — utfallet kan vara "applicerad men obokförd". Välj `migrate resolve --applied` eller `--rolled-back` efter mätningen, aldrig reflexmässigt. **Ingen ny merge behövs för att komma tillbaka** — den gamla versionen är redan den som kör. |
| Appen startar inte efter grön migration | `revision`-fältet avslöjar det. Railway-rollback till föregående deploy återställer **appen**; kolumnen och triggern ligger kvar och är ofarliga för gammal kod. |
| Beteendet är fel efter utrullning | App-rollback via Railway stoppar den nya logiken — men återinför de fel stacken rättar, och rollback-imagen kör själv `migrate deploy` (5.1/5.1b). Beskriv målimage, variabler och historikens tillstånd innan den används. **Databasen ska normalt inte backas.** Schemat är additivt; kolumnen och triggern är inerta för gammal kod. |
| Någon vill ändå reversera schemat | **Det finns ingen verifierad återställningsväg, och revision 1:s DROP-kedja är struken.** Skälen: (a) noll backfillade rader *före* införandet säger ingenting om markörer som satts *efter* det — en `DROP COLUMN` kan alltså förstöra data som tillkommit; (b) `migrate resolve --rolled-back` är **avvisat** på en lyckad migration (`CannotRollBackSucceededMigration`, 5.3b), så steget "följt av `prisma migrate resolve`" var inte utförbart. Schemareversering är en **separat, prövad och uttryckligen beslutad åtgärd** — den ska inte stå som en rad i en återhämtningstabell. |
| En organisation blev pausad och kan inte komma ur det | Enda produktvägen är en import som går helt igenom (4.9). Finns ingen sådan fil krävs en direkt databasändring — det är i dag ingen dokumenterad procedur. |
| Data är skadad | **Ingen väg som håller i dag** — se 5.2. Det är därför steg 0 finns. |

### 6.4 De tio frågorna — Codex svar och vad som återstår

Codex har besvarat samtliga tio frågor från revision 1. Svaren är återgivna i
sak nedan, med vad som faktiskt kvarstår efter dem.

| # | Fråga | Codex svar | Kvarstår |
| --- | --- | --- | --- |
| 1 | Aktuell backup före migration? | **Ja.** Ska finnas och återläsningen verifieras före produktionsmigrationen. Alternativet att kvittera bort det rekommenderas inte. Ingen dump eller lagringskonfiguration är utförd eller beställd. | Åtgärden. Den är inte gjord. |
| 2 | Får #889:s innehåll följa med? | **Ja, avsett.** De bevarade reproduktionsproven och deras historik ska följa med #891; förbudet gällde separat merge av den avsiktligt röda PR:en. Slutdiffen ska visa just det avsedda innehållet. #889 kan stängas efter verifierad integration; ingen gren behöver raderas. | Kontrollen av slutdiffen i steg 4. Not: steg 6 i 6.1 ska alltså läsas som "stäng #889", inte "radera grenar". |
| 3 | Mergeform? | Inom stacken **vanliga merge-commits utan grenradering**. Till `main` följs den verifierade repopolicyn; ingen anledning att ändra policy för den här leveransen. Ordningsförslag, inte tillstånd att merga. | Inget. Frågan är stängd. |
| 4 | Belopps-PR? | **#893**, HEAD `87bd9b8d`, CI 34760333195. | Inget — verifierat oberoende, se 2.2. |
| 5 | Är F32 rättad? | **Ja, och kontrollen är gjord.** Codex har kodgodkänt #893 på `87bd9b8d` inom beställd omfattning: läst produktdiff och importmetod, separat granskare på testfaciten, verifierad CI-logg med båda F32-utfallen (2.2). | Inget i kodfrågan. Merge- och driftgodkännande är separata beslut. |
| 6 | Matchfel och banktäckning? | **Kvarstår som separata produktgränser.** Ingen tyst acceptans av att gröna prov innebär kompletta betalningsuppgifter eller säkra automatiska krav. En förbättrad felspärr är inte ett fullständigt bankflöde. | Eget beslut, utanför den här leveransen. |
| 7 | Flytta backfillen? | **Ingen sådan ändring beställs nu.** Övergångsproceduren ska klarläggas först. Ett efterjobb flyttar tidpunkten men löser inte saknad historik och är inte i sig avskärmning. | Övergångsproceduren (4.5). |
| 8 | Slå på Wait for CI? | **Rekommenderas som egen driftåtgärd**, med begränsningarna i 2.3. Ingen inställning ändras av granskningen. | Driftåtgärden, och verifiering av dess faktiska regler. |
| 9 | Manuell väg ur paus? | **Inte som administrativ bypass.** Radera inte faktumet att en import påbörjats och fabricera inget täckningsdatum. Ska manuell avstämning kunna ge klartecken behöver den ett eget kontrakt: vad som verifierats, till vilket datum, av vem och med vilket underlag. Separat produktuppgift. | Produktuppgiften. 4.9 ska läsas med den avgränsningen: ingen bypass föreslås. |
| 10 | `lock_timeout` och transaktionsgräns? | **Behåll explicit transaktion nu.** Pröva behov och effekt av begränsad låsväntan isolerat innan någon ändring beställs; ett valt värde ska ha ett mätt återhämtningsförlopp. | Ett isolerat prov. 4.8 är rättat efter detta. |

**Kvar som villkor före en samlad merge**, sammanfattat:

1. Aktuell dump, återläst och verifierad (fråga 1).
2. Konkret avskärmningsprocedur för gamla skrivare med verifierbara stoppvillkor
   (fråga 7, avsnitt 4.5/4.7).
3. Sammanföring till avsedd målgren, plus verifierat slutligt kodträd, aktuell
   main-bas och tillhörande CI (3.6).

**Uppfyllt sedan revision 2:** Codex kodgodkännande av #893 (fråga 5). Kvar av de
fyra villkoren är alltså tre.

---

## 7. Invändningar mot planen

1. **"#889 mergas inte" är sant om PR:en och osant om innehållet.** Dess fyra
   commits ligger i #891. Det ska bekräftas, inte antas.
2. **#886/#890 får inte räknas som en driftgrind.** Filen säger själv att den är
   inaktiv, och `checkSuites` är mätt avstängd i dag. Grön CI på dem ändrar
   ingenting om API-deployens ordning.
3. **Backupfrågan väger tyngst, men den är inte ensam.** I revision 1 skrev jag
   att den var "det enda som verkligen bör stoppa". Det var för snävt: också
   slutkombinationen, versionsövergången och återhämtningen måste vara
   verifierade innan detta är en körbar instruktion (se 6.4:s kvarstående
   villkor). En
   migration mot en databas utan aktuell återställningspunkt är dessutom inte
   reversibel bara för att migrationen är liten.
4. **Att tabellerna är tomma är ett ögonblicksvärde, inte ett skydd.** Flera
   slutsatser i det här underlaget vilar på mätningen 13:21Z. Den ska göras om
   omedelbart före steg 5, och den ersätter inte en avskärmningsprocedur.
5. **Införandespärren i #891:s egen rapport är skriven för en större produktion —
   men den gäller.** "Stoppa/dränera gamla producenter och kravworkers, kör
   backfill efter sista gamla importen" beskriver ett flerinstansigt system med
   importtrafik, och det verkliga systemet är en replika med in-process-crons och
   noll importrader vid mätningen. **Revision 2 drog en slutsats för långt av
   det** och skrev att ett stopp-/dräneringsmoment vore "procedur ovanpå en risk
   som inte finns". Den formuleringen är struken. Risken finns: mätningen visar
   själv ett överlappsfönster där två kodversioner arbetar mot samma databas
   (4.4), och noll importrader vid ett mättillfälle är inte ett skydd mot att en
   import startar. Det som är litet här är **sannolikheten och omfattningen**,
   inte riskens existens. Avskärmningen ska därför vara verifierbar, inte
   bortresonerad — den får vara enkel i den här miljöns storlek, men den ska
   finnas.
6. **Backfillen går inte att schemalägga separat med dagens migration.** Påståendet
   "backfill körs efter sista gamla importen" går i dag bara att uppfylla genom
   avstämning, inte genom mekanik. Det ska sägas rakt ut i stället för att lova en
   ordning som SQL:en inte kan hålla.
7. **Backupens av-läge har fel orsak i runbooken, och det spelar roll.**
   Runbooken pekar på isoleringsgrinden; i verkligheten faller `enabled` redan på
   `BACKUP_ENABLED`. Den som "bara slår på backupen" före migrationen får den
   fortfarande avstängd, nu med en annan orsakstext. Fyra variabler krävs. (5.2)
8. **Det finns ingen paus-spak och ingen förhandskontroll av kravtrappan.**
   Planen kan därför inte innehålla ett steg som "pausa kravtrappan före merge" —
   det går inte med dagens kod. **Men tidsvillkoret i 6.1 räcker inte i stället.**
   Revision 2 skrev att det "är det enda som faktiskt fungerar", vilket läses som
   att det är tillräckligt. Det är det inte: cronfönstret flyttar bara en av de
   skrivvägar som kan vara aktiva under övergången, och det säger ingenting om
   importer, köjobb eller HTTP-anrop. Cronfönstret är en **försiktighetsåtgärd**;
   den verifierbara avskärmningen (4.5/4.7) kvarstår som villkor. (4.7)
9. **Grenskyddet garanterar inte att CI granskade det träd som deployas.**
   `strict_required_status_checks_policy` är `false`. Kontrollen av `origin/main`
   omedelbart före steg 5 är därför inte pedanteri. (2.7)
10. **`/v1/health` och gröna bockar räcker inte som acceptans.** Hälsoindikatorn
   svarade `ok` mot en 90 % stympad databas (mätt), `cron:daily-backup` säger
   `success` om ett jobb som inte tar någon dump (mätt i dag), och ett grönt
   `Deploy Web` kan betyda att appen hoppades över. Acceptanskriterierna i 6.2
   är valda för att vara diskriminerande.

---

## 8. OVERIFIERAT — vilket bevis som saknas

| Fråga | Varför den inte är besvarad | Exakt bevis som behövs |
| --- | --- | --- |
| Överlappsfönstret vid en **riktig** migration | De tre mätta utrullningarna loggade alla `No pending migrations to apply`. De 68,9 / 67,9 / 68,6 s är **observationer, varken undre eller övre gräns** | `[start] running prisma migrate deploy` / `migrations done` och den gamla containerns `Stopping Container`, fångade **under** den här deployen |
| Migrationens egen körtid | Inte uppmätt. Revision 1 uppgav "mikrosekunder"; det var en uppskattning och är struket | Tidsstämplarna kring `migrate deploy` i deployloggen, eller en replay mot en kopia |
| Att ingen gammal skrivare kan återansluta under dräneringen | `pg_stat_activity.backend_start` mäter anslutningens ålder, inte appversionen; `application_name` är tom | En avskärmningsprocedur som stänger ingångarna, eller en versionsmarkör i anslutningen |
| Om den gamla containern exiterar eller `SIGKILL`:as | `Stopping Container` inföll vid exakt dräneringstaket i alla tre fallen, vilket pekar mot SIGKILL, men Railways logg skiljer inte processexit från plattformshändelse | En exit-kod eller en avslutningsrad ur processen själv |
| Om en gammal BullMQ-körning hann skriva klart under dräneringen | Plattformens händelse är inte processens död, och med `numReplicas = 1` finns inget replik-API att fråga | Saknas — ingen mekanism finns i dag |
| Om `@nestjs/schedule` slutar fyra crons i den gamla containern efter SIGTERM | Inte undersökt. Ett kravtrappe-jobb kl. 10:00:00Z mitt i ett deployfönster kan i teorin fyra i **båda** containrarna; jobben är klass B och skyddas bara av `updateMany`-claims, inte av Redis-lås | Ett prov som mäter cronbeteende efter SIGTERM — eller att helt enkelt hålla tidsvillkoret i 6.1 |
| Att `lock_timeout`-risken är reell här | Ingen profil över långa transaktioner mot `Organization` finns | `pg_stat_activity` med `state = 'idle in transaction'` och `query_start` under en normal timme |
| Prisma 5.22:s faktiska hantering av explicit `BEGIN`/`COMMIT` | Källan är läst (`postgres/connection.rs`, simple query) och PostgreSQL:s multi-satsregel är dokumenterad, men beteendet är inte kört | En shadow-DB-replay — sekunder |
| Vad som faktiskt händer när `lock_timeout` löser ut mitt i en deploy | Inte prövat. Ett valt värde ska enligt Codex ha ett mätt återhämtningsförlopp | Ett isolerat prov med en riktig blockerare |
| Att Railway-volymögonblicksbilden från 2026-08-23 går att återställa | Endast dess metadata är läst (id, datum, `expiresAt`, storlekar) | En provåterställning till en separat volym — inte gjord, inte beställd |
| Att schema-drift-vakten ignorerar trigger + funktion | Slutlett ur att Prisma inte modellerar triggers, inte mätt | `migrate diff --from-migrations` mot kombinationens HEAD i CI |
| Att `/workspaces/prod-backups`-dumparna går att återställa | Bara datum, storlek, sha256 och loggens sista rad kontrollerade | `pg_restore --list` plus en provåterställning enligt de sex kriterierna i `db-backup-restore.md` |
| Att en `pg_dump` av **dagens** produktion går att återläsa | Ingen ny dump har hämtats eller skapats — uttryckligen utanför uppgiften | Se ovan |
| Att kravtrappans effekter är idempotenta vid omkörning efter stall | Ligger i #891:s egen bevisplan; inte omprövat här, och inga tunga körningar fick startas | #891:s DB-prov för verifikat-`sourceId` på kombinationens slutliga HEAD |
| #893:s produktdiff — **oberoende av Codex** | Codex har kodgodkänt den (läst produktdiff och importmetod, separat granskare på testfaciten, verifierad CI-logg). **Den här granskningen har inte läst diffen** och gör inget eget kodutlåtande; det som är verifierat härifrån är PR-metadata och CI-körningen | En egen läsning, om ägaren vill ha två oberoende kodutlåtanden i stället för ett |
| Det sammanförda trädet | Kombinationens **innehåll** finns redan på #893:s gren (3.6, ancestry verifierad), men sammanföringen till avsedd målgren är inte gjord | Trädet efter steg 3, dess heldiff mot prod-revisionen (6.2 punkt 1) och CI på den sammanförda shan |
| Kombinationen mot **aktuell** main-bas | CI 34760333195 kördes med `codex/betalningsfarskhet-filfel` som bas. `main` stod stilla på `3b71e905` vid mätningen, men det är ett ögonblicksvärde | En CI-körning vars bas är den `main` som faktiskt gäller vid steg 5 |
| Om #886:s nya CI-jobb blir obligatoriska för merge | `ci-passed`:s `needs`-lista lästes på `main`, inte i PR-grenen | `needs`-listan i PR-grenens `ci.yml` |
| Om klassisk branch protection är av | GitHub-tokenen fick inte läsa `branchProtectionRules` (`Resource not accessible by integration`). `CLAUDE.md` uppger den som av, mätt i #405 | En token med rätt behörighet — **inte** ett push-försök |
| Kravtrappans verkliga beteende mot riktig kunddata efter merge | Produktionen har inga aktiva hyresavier (2 st, båda annullerade) | Kan först mätas när det finns data att mäta på |

---

## 9. Ändringslogg

### Revision 3 — 2026-09-13

Fem kvarstående fel rättade. Tre av dem var motsägelser inom dokumentet självt.

| # | Fel i revision 2 | Rättelse |
| --- | --- | --- |
| 1 | #893 beskrevs som ogranskad på fem ställen | **Rättat** i 0, 2.2, 3.3, 5.4, 6.1 och 6.4. Codex har kodgodkänt #893 inom beställd omfattning på `87bd9b8d`: läst produktdiff och importmetod, separat granskare på testfaciten, verifierad CI-logg (61 gröna jobb, 6 132 API-prov, 291 nya beloppsobservationer med 288 testnamn, båda F32-utfallen). Genomgående utskrivet att det är ett **kodgodkännande, inte ett merge- eller driftgodkännande**, och att den här granskningen inte gör något eget kodutlåtande. |
| 2 | "Ingen gren bär #891 + #892 + #893 samtidigt" | **Rättat** i 3.6 och 8 — och det motsade 3.1:s egen beskrivning av stacken som linjär. Läsande ancestry-kontroll visar att #893 bygger på #892 som bygger på #891, med `main` som merge-bas. Kombinationens **innehåll** finns alltså redan. Kvar är sammanföringen till avsedd målgren samt verifiering av slutligt kodträd, aktuell main-bas och tillhörande CI. |
| 3 | §5.3b: "svarar 1–3 ja är migrationen applicerad" | **Rättat.** Tre befintliga objekt betyder inte att migrationen är korrekt applicerad. Kontrollen omfattar nu sex punkter — exakta definitioner för kolumn, funktion och trigger, backfillutfallet mot källan, checksumman och **samtliga** historikrader för namnet — med en uttrycklig beslutsregel där **oklart eller motsägelsefullt utfall är fortsatt stopp**. Inga `resolve`-kommandon har körts. |
| 4 | §7 påstod att övergångsrisken "inte finns" och att tidsvillkoret "är det enda som fungerar" | **Båda struket.** Punkt 5 säger nu att risken finns — dokumentets egen mätning visar ett överlappsfönster — och att det som är litet är sannolikhet och omfattning, inte riskens existens. Punkt 8 säger att cronfönstret är en försiktighetsåtgärd som inte ersätter verifierbar avskärmning. Tomma tabeller behandlas genomgående som ögonblicksbild. |
| 5 | §6.2 verifierade releasen med en diff över två kataloger | **Rättat.** Kriteriet är nu en **tom heldiff** mellan prod-revisionen och den godkända shan, med en uttrycklig lista över ytor en katalogbegränsad diff missar: schema och migrationer, effektvägarna i `avisering/`, `psd2/` och `ai/tools/`, webbfilerna, beroenden, `Dockerfile`/startskript, `railway.*` och `.github/workflows/`. Dagens kombination är mätt mot den listan (39 filer, inga bygg- eller driftfiler berörda) med notisen att mätningen ska göras om på det sammanförda trädet. |

### Revision 2 — 2026-09-13, efter Codex granskning

Codex granskade revision 1 (`b59ca32a`) och invände mot åtta punkter. Sju var
berättigade och är rättade; den åttonde är skärpt. Inget som rättats har tagits
bort utan att skälet står kvar.

| # | Codex invändning | Hur den behandlats |
| --- | --- | --- |
| 1 | Överlapp och tomma tabeller övertolkade | **Rättat.** ~69 s är nu tre observationer, inte en gräns (4.4). Påståendet att en replika betyder en kodversion är struket. "Mikrosekunders migrationstid" struket och flyttat till OVERIFIERAT. Backfillens utfall omformulerat till "uppdaterar noll organisationer" (4.2), med uttrycklig notis om att tomhet är ett ögonblicksvärde. |
| 2 | Avskärmning är fortfarande ett villkor | **Rättat.** Cronfönstret kallas nu en försiktighetsåtgärd, inte ett bevis (4.5). `pg_stat_activity.backend_start` nedgraderat: det mäter anslutningens ålder, inte appversionen (4.7). Kravet på en konkret procedur med verifierbara stoppvillkor tillagt och upptaget bland villkoren i 6.4. |
| 3 | Backupbeviset är äldre, inte obefintligt | **Rättat — detta var en motsägelse i mitt eget dokument.** §5.2 påstod "aldrig återställningstestad" medan §5.1 återgav provet. Dumpen från 2026-08-28 **är** återläsningstestad, 341/341 mätpunkter, och det lokala exemplarets sha256 är nu jämförd mot runbookens registrerade värde och stämmer. Inventeringen utökad med en **Railway-volymögonblicksbild från 2026-08-23 som löper ut 2026-09-22** — den saknades helt i revision 1. Påståendet är avgränsat till vad som faktiskt inventerats. Kravet på en aktuell backup står kvar. |
| 4 | Avbruten migrator betyder okänt utfall | **Rättat, och verifierat mot Prisma 5.22:s källa.** Nytt avsnitt 5.3b: SQL körs före `finished_at` skrivs, så committad DDL kan stå som ofärdig. Instruktionen "kör `migrate resolve --rolled-back`" är ersatt av mät-först-välj-sedan. |
| 5 | Stryk den generella DROP-kedjan | **Struken** ur 6.3. Skälen utskrivna: nya markörer kan ha tillkommit, och `--rolled-back` avvisas på en lyckad migration (`CannotRollBackSucceededMigration`). Schemareversering beskrivs nu som en separat, prövad och uttryckligen beslutad åtgärd. |
| 6 | Approllback är schemakompatibilitet, inte återställt skydd | **Rättat** i 5.1 och 5.1b. Tillagt att rollback-imagen själv kör `migrate deploy` och därför kan stoppas av ofärdig historik. "Ofarligt" struket. |
| 7 | Behåll BEGIN/COMMIT | **Rekommendationen tillbakadragen** (4.8). `lock_timeout` placeras efter `BEGIN`, och det klargörs att det begränsar varje låsväntan, inte migrationens totala tid. Kravet på ett mätt återhämtningsförlopp tillagt. |
| 8 | Verifiera exakt release, inte ancestry | **Rättat** i 6.2: kodträdet ska jämföras, inte bara härstamningen. Migrationen verifieras på namn, checksumma, `finished_at` och schemaobjekt — inte på ett totalantal rader. |
| — | Wait for CI ersätter inte planen; `allow_auto_merge` bevisar inte merge queue | **Skärpt.** 2.3 återger Railways faktiska regler (skipped/neutral blockerar aldrig; cancelled ignoreras om ett annat workflow på samma commit lyckades; två timmar → deployen hoppas över) och säger uttryckligen att den inte ersätter backupbevis, granskad kombination eller säker versionsövergång. "Hålet är ett fältbyte brett" struket. 2.7 använder nu rulesetets frånvaro av `merge_queue`-regel som bevis, och noterar att klassisk branch protection inte gick att läsa med den här tokenen. |

Utöver rättelserna: **#893 tillagd** i 2.2, 3.3 och 3.6, verifierad oberoende
(HEAD, bas, CI-körning, 61/61). Frågorna i 6.4 är ersatta av Codex svar plus en
lista över vad som faktiskt kvarstår.

---

*Revision 1 mättes 2026-09-13 mellan 13:14Z och 13:35Z. Revision 2 mättes
2026-09-13 mellan 14:00Z och 14:15Z. Vid båda tillfällena var
`origin/main = 3b71e905d866f461f6b07211bc89b3fa88505200` och produktionens
revision densamma. Ingen skrivning har gjorts mot produktionen, inga migrationer
har körts, ingen merge, ingen deploy och ingen driftinställning ändrad.*
