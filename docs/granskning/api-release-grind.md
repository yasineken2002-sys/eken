# Inaktiv API-releasegrind

## Beslut och avgränsning

Kandidaten är körbar kod och isolerade prov, **inte en aktiverad driftgrind**.
Railways Git-integration förblir enda deployutlösaren. Ingen ändring av
Dockerfile, `.dockerignore`, `railway.toml`, startkommando, pre-deploy-kommando,
Railway-variabler eller frontendflödet ingår. Inga migrationer ändras.

Fryst bas: `e483daaf169fefc067c8f952c3ee0f12d4a7fdc5`.
Vid första läsningen var main och health-revision planeringens
`676d03682c17ec9a592bb3a8e1f6be0278aa00b2`. Under inventeringen landade #884
och main flyttade till den frysta basen. Railway rapporterade då en lyckad
deployment av `676d0368…` och ett bygge av `e483daaf…`.
Basen innehåller redan CLAUDE-rättningen: `workflow_run` efter CI och exakt
`github.event.workflow_run.head_sha`. Den rättningen dupliceras inte här.

Läsande driftverifiering 2026-09-12: projekt `poetic-strength`, miljö
`production`, tjänst `eken`, repo `yasineken2002-sys/eken`, triggergren main,
`checkSuites=false`, `preDeployCommand=null`, `startCommand=null`.
Docker CMD använder fortfarande `apps/api/scripts/migrate-and-start.sh`, som
kör Prisma före appstart. Historiskt skäl till avstängd Wait for CI:
**INGEN DOKUMENTERAD ORSAK**.

## Härledd omfattning

| Komponent        | Faktisk bas och ändring                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Utlösare         | En Railway Git-trigger; ingen ny deployworkflow.                                                                                                                     |
| Frontend         | `.github/workflows/deploy.yml:35` och checkout av head_sha; orört.                                                                                                   |
| Aktiv API-start  | `apps/api/scripts/migrate-and-start.sh:18`, Dockerfile:128; orört.                                                                                                   |
| CI-kontrakt      | `.github/workflows/ci.yml`: 59 needs + CI passed, 60 obligatoriska jobb; en PR-annotering utanför needs.                                                             |
| Kandidat         | `release-gate.cjs`, `prepare-release-artifact.cjs`, `release-api.cjs`; explicit YAML-parser, inget nytt nät- eller deployjobb i CI.                                  |
| CI-bevis         | 20 namngivna Jestprov, efterkontroll av exakt en svit/ett prov per id, passed och positiva assertions; manifestprov på verklig API-byggutdata i befintligt byggjobb. |
| Migrationsstudie | Fem verkliga PR-filer, egen PostgreSQL 18.6, gammal main-klient/tjänstekod; separat [rapport](api-release-migrationer.md).                                           |

## Releasekontrakt

Framtida builder kör `node apps/api/scripts/prepare-release-artifact.cjs`
**efter** API/shared/UI-build. Kommandot kräver fullständig build-time
`RAILWAY_GIT_COMMIT_SHA` och skapar `apps/api/release-artifact.json`.
Framtida pre-deploy kör `node /app/apps/api/scripts/release-api.cjs`.
Inget av kommandona anropas av dagens driftväg.

Grinden kräver följande före första migratoranropet:

1. Repo-id `1186637753`, repo-namn, workflow-id `261975754`, path
   `.github/workflows/ci.yml`, namn CI, event push och gren main.
2. Samma fullständiga SHA i byggmanifest, Railways miljömetadata,
   autentiserat deploymentobjekt och CI. Tjänst, miljö och deployment-id binds.
3. Kanoniska workflowets senaste relevanta run_number, utan statusfilter.
   Senaste run_attempt måste vara completed/success. Den attempt-specifika
   jobblistan måste innehålla varje obligatoriskt jobb exakt en gång med
   samma run-id/attempt/SHA och completed/success. En annan grön workflow,
   äldre körning eller grön CI passed ensam ger inget klartecken.
4. Hela needs-kedjan härleds ur YAML från artefaktens SHA. Okända jobb,
   oklassificerade workflowjobb, dubbla namn, dynamiska jobbnamn, matriser,
   återanvändbara jobb och continue-on-error stöds inte och nekar. Den enda
   avsiktliga luckan är den PR-villkorade migrationsannoteringen utanför needs.
5. Hela migrationsmängden, migration_lock.toml, SQL-hashar och Git-blobhashar
   måste stämma mot samma Git-träd. Även Prisma-schemat binds lokalt och mot
   trädet. Valda byggkällor omfattar API/src, packages, API/root-konfiguration,
   tsconfig.base.json, .npmrc, .dockerignore och kandidatens CJS-filer.
   Ny källa inom mängden kan inte utelämnas ur manifestet.

Manifestet innehåller SHA-256 för runtime/dist. Lokal ändring upptäcks vid de
två hashkontrollerna. Kontrollen är inte atomisk med Prismas senare filöppning;
oföränderlig image och frånvaro av samtidiga filskrivare är en tillitsgräns. Byggkällornas Git-blobhashar kontrolleras
mot GitHub. **Den betrodda byggprocessen måste fortfarande verkligen kompilera
dessa källor och distribuera samma immutable image till pre-deploy och app.**
En självdeklarerad SHA eller efterhandshashning bevisar inte kompilatorns
korrekthet, image-integritet eller alla byggverktygs externa beroenden.

Kandidaten jämför main igen omedelbart före effekten och nekar en redan
överspelad revision. Run/attempt och deployment läses om, artefakten kontrolleras
igen. Inget sparat kontrollresultat kan återanvändas vid ett senare anrop.
GitHub kan emellertid ändras även efter sista HTTP-svaret; GitHub och PostgreSQL
delar ingen atomisk transaktion. Garantin gäller de verifierade läsningarna,
inte framtida CI-omkörningar efter migratorstart.

Nätfel, HTTP-fel, trasig JSON, ofullständigt svar/paginering och oklar identitet
nekar. Högst 999 runs/jobb per sökning accepteras; större mängd nekar. Partiell
rerun som saknar obligatoriska jobb i senaste attempt nekar och kräver full
rerun. Väntan på pågående CI är högst tio minuter, monotont mätt. Varje HTTP-anrop
har 15 sekunders timeout; sista anropet kan förlänga väggtiden med det intervallet,
men får aldrig ge migratoranrop efter utgången deadline.

## Operativ övergång som ägaren måste verifiera

**Rekommendation: en sammanhållen övergång i ett uttryckligen godkänt
underhållsfönster. Noll avbrott är inte bevisat.** Följande är framtida
ägaråtgärder, inte genomförda åtgärder i denna PR:

1. Säkerställ aktuell, återläsningsbar backup och läs migrationsriskerna.
   Frys samtidiga releaser och töm äldre väntande byggen/deployer. Bekräfta
   faktiskt körande instanser och vad deras återstartskommandon gör.
2. Förbered en framtida granskad release som tillsammans innehåller
   manifestbyggnaden, explicit inclusion av `.github/workflows/ci.yml` i
   Docker-context, copy av manifestet från builder till slutimage och app-only
   start (`node /app/apps/api/dist/main.js`). `.git` eller temporära pre-deploy-filer
   behövs inte. Nuvarande `.dockerignore` utesluter .github; den luckan måste
   åtgärdas i den separat beställda inkopplingen.
3. Ägaren tillför nödvändiga läscredentials med minsta tillgängliga behörighet.
   Pre-deploy-kommandot och app-only-starten måste gälla **samma** verifierade
   Git-release/configsnapshot. En framtida gemensam repo-konfiguration kan binda
   dem till samma Git-commit, om ägaren väljer det och konsolens overrides har
   verifierats. Två fristående inställningsändringar är inte bevisat atomiska.
   Kan Railway inte behålla dessa staged tills samma Git-release används:
   stoppa övergången och bestäm en annan sammanhållen metod. Lägg inte till
   en parallell GHA-, webhook- eller manuell deployutlösare.
4. Stoppa/dränera äldre instanser och deras automatiska återstarter innan den
   nya migreringsvägen får köra. Annars finns startup-migratorn fortfarande som
   en andra väg. Dagens startup-migration tas bort först i den sammanhållna
   inkopplingen; ingen app-only-version får starta utan lyckad pre-deploy.
5. Verifiera i ägarstyrd driftsmiljö att fel SHA, röd CI och migreringsfel
   lämnar appen ostarterad. Läs faktisk deploymentstatus under pre-deploy:
   kandidaten tillåter DEPLOYING; dess riktighet där är ännu inte driftbevisad.
6. Verifiera lyckad release, rätt image/revision och health/routing. Starta om
   den godkända appen och visa att den varken kontaktar GitHub eller migrerar.
   Railways fullbordade releasegräns bär godkännandet, ingen delad lokal attestfil.

Två releaser A och B kan annars bli klara i omvänd ordning. Main-kontrollen
nekar A om B redan är main före migratorstart. Den skyddar **inte** mot att A
lämnar pre-deploy, B blir aktiv och A routas sist. Prismas advisory-lås
serialiserar migratorer, inte trafikväxling. Operativ inkoppling kräver verifierad
serialisering hela vägen genom healthy/routing och kassering av överspelade
releaser. Kan plattformen/ägarens releasefrys inte garantera det behövs ett
separat beställt beständigt generationsvillkor även vid appstart/routing.
Kandidaten påstår inte att detta redan är löst.

Efter en framåtmigration är rollback av appen ett kompatibilitetsbeslut, inte
SQL-rollback. Kandidatens main-krav nekar en godtycklig äldre SHA. En korrigerande
Git-release måste behålla tillämpade migrationer och använda kod som fungerar
mot framåtschemat. P3009 eller oklar katalog får inte automatiskt resolve:as.

Railway Wait for CI kan vara första vänteläge. Det granskar workflow-resultat,
inte jobb; skipped/neutral blockerar inte, cancelled kan ignoreras om annan
workflow lyckats, andra GitHub-appars checks ignoreras och två timmar ger
skippad deploy. Därför ersätter det inte kandidaten.
[Railway: GitHub autodeploys](https://docs.railway.com/deployments/github-autodeploys#wait-for-ci).
Pre-deploy kör separat från appcontainern; filesystemändringar delas inte.
[Railway: pre-deploy](https://docs.railway.com/deployments/pre-deploy-command).
Attempt-specifika jobb hämtas enligt
[GitHub: workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt).

## Bevisgräns

Jestproven använder syntetiska API-svar, lokal HTTP-server och ofarlig child-process.
De driver den verkliga grinden, HTTP-adaptern och processgränsen. De bevisar inte
Railways framtida credentials, imageöverföring, pre-deploy-status eller routing.
Migrationerna provas med riktig Prisma 5.22.0 och separat PostgreSQL 18.6.
Den separata migrationsrapporten redovisar mätningarna och kvarstående luckor.

## Validering och radomfattning

Den pinnade radräknaren är oförändrad från
`561b382b6cbddfccba719613a5ea3aa2f0f7e695`, tillsammans med dess source-scan.
Mätbasen är den ovan angivna main-committen, inte Agent 3-kedjan eller HEAD^.
Kandidatens **579 produktionsrader** är tillagda rader:

| Komponent                                            | Produktionsrader |
| ---------------------------------------------------- | ---------------: |
| Releasevillkor, identitet och artefaktkontroll       |              420 |
| Verklig HTTP-/processadapter                         |               83 |
| Framtida manifestbyggkommando                        |               16 |
| Krav på faktiskt körda CI-prov                       |               45 |
| Befintlig CI: assertionkontroll och manifestbyggprov |               11 |
| Explicit YAML-beroende och lockfil                   |                4 |

Lokalt passerade 20/20 grindprov och krävda positiva assertions. För den sista
avgränsade körningen användes ts-jest isolatedModules med låg minnesgräns;
den ersätter inte full typecheck. Den separata fulla typkontrollen passerade
8/8 workspace-uppgifter med concurrency=1. Delade maskinens Jest/tsc-processer
kontrollerades före tunga prov.

Negativkontroll: SHA-jämförelsen i `apps/api/scripts/release-gate.cjs` ersattes
avsiktligt med true. `api-release-02` föll därför att ett förbjudet migratoranrop
tilläts. Filen återställdes med
`git restore --source=a153b9fb3fbacbe72e173b19165900882769ddd5 -- apps/api/scripts/release-gate.cjs`;
därefter passerade alla 20 prov igen. En tidigare avbruten testprocess och ett
ram-timeout under maskinbelastning räknas inte som negativkontroll. HTTP-provets
ram har 30 s; dess avsiktligt korta nät-timeout är oförändrad.

Releasegränsen granskades separat. Fynd om schema/root-byggkonfiguration,
verklig adapter och hashkontrollens tillitsgräns är åtgärdade. Granskningen
hittade därefter inga blockerande releasekodfel. Operativa villkor ovan
kvarstår och kan inte ersättas av den granskningen.

CI för kandidatcommit `1f18817177491a1f10d3800d671cba3fed5e2e24`: samtliga
61 jobb lyckades, inklusive den faktiskt körda manifestbyggnaden och
assertionskontrollen. [Körning 34705953168](https://github.com/yasineken2002-sys/eken/actions/runs/34705953168).
Senare dokumentations-/riggändringars CI redovisas på utkast-PR:n och i
slutrapporten för exakt HEAD.
