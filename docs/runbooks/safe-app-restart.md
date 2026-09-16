# Säker appomstart efter #896

Status: förberett för granskning, **inte infört**. Ingen Railway-mutation ingår.

## Utgångspunkt och härledd startväg

`main` verifierades mot GitHub 2026-09-15: `30724b1721f36a40d77ce16b1bbcf8758d487a2e`.
Källa: `arbete/bankfix-inforande-896-20260915/codex/SLUTRAPPORT-20260915T2335Z.md`,
`KVITTO-MIGRATION-20260915T2252Z.json`, `KVITTO-ATEROPPNING-20260915T2328Z.json`,
`evidence/20260915T232703Z-meta-0b01796d.json` och `startpaket-merge/pkg-aterop/`.
Dessa historiska kvitton finns i arbetsytan, inte i Git.

Ny läsning 2026-09-15 23:59Z gav samma körande deployment
`0b01796d-8167-4e39-9728-e705d7f35489`, instans
`db137893-458f-4016-8c49-0be2403bbc26`, lagrat NEVER/0, tillämpat NEVER/null.
Railway Git-trigger: 0. GitHub Deploy 266430071: `disabled_manually`. CI: aktivt.

1. Railway använder `/railway.json`, som bara väljer DOCKERFILE. `railway.toml`
   innehåller ON_FAILURE/3 men används **inte** av den här tjänsten. Värden från
   en vald konfigurationsfil kan överstyra tjänstens lagrade inställningar.
2. Dockerfile bygger API/shared/ui och genererar Prisma-klienten vid **bygget**.
   Runner kopierar `dist`, beroenden, prisma och scripts. Docker-CMD är
   `/app/apps/api/scripts/migrate-and-start.sh`.
3. Produktionens uttryckliga `startCommand` ersätter Docker-CMD. Dess SHA-256 är
   `f5a4ab12719f7b512dd4b5f9c0014e5052d766686a43ee66d2e6ff896b2020d0`.
   Det kör `/bin/sh -ec '<bootstrap>' -- app`.
4. Bootstrap avkodar `GATE_TOOL_B64` och `GATE_MANIFEST_B64` till en tillfällig
   katalog, jämför båda mot **literala** SHA-256-värden i kommandot, kör grinden
   och stoppar på varje fel. Miljövariabler används aldrig som exekverbar kod.
5. `gate.js` verifierar exakt `RAILWAY_GIT_COMMIT_SHA`, nio deklarerade filer,
   hela migrationsmängden (185 vid #896), förbjudna administratörsvariabelnamn
   samt exakt `OPS_AUTOMATION_PAUSED` i app-läge. Den startar ingen process.
6. Bootstrap raderar tempkatalogen, gör `cd /app/apps/api` och tillåter endast:

   | Läge | Fast mål efter godkänd grind |
   | --- | --- |
   | `app` | `exec /app/apps/api/scripts/migrate-and-start.sh` |
   | `migrator` | `exec /usr/local/bin/node /app/apps/api/node_modules/prisma/build/index.js migrate deploy` |
   | `selftest` | `exec /fixtures/target.sh` (ärvt lokalt provmål; inget produktionskommando genereras) |

   Annat läge stoppas med exit 30. Grindargument är endast `--mode`,
   `--manifest`, `--manifest-sha256`; ingen alternativ rot eller revisionskälla.
7. Före ändringen körde appskriptet Prisma migrate deploy (med fallback-sökväg)
   **och sedan** `exec node /app/apps/api/dist/main.js`. Därmed upprepades
   migreringen på varje appomstart. Nu gör skriptet enbart loggning, `cd` och
   samma `exec node`. Namnet behålls för att inte byta grindens tillåtna mål.
8. Nest behåller `enableShutdownHooks()`. Driftpausen behåller sin befintliga
   väg till scheduler, kökonsumenter och deposit-backfill. Skriptet ändrar inga
   miljövärden. `pnpm start` är en separat utvecklarväg, inte produktionskommandot.

`gate.js` är byteidentisk med infört paket, SHA-256
`684238e62ac6f1e91c35620bc6ae0e8bbe302b7da58b7e7c1faf6ba9e1ff7fad`.
Bootstrapmallen skiljer endast de två hashplatshållarna från infört paket.
Grinden skyddar deklarerat innehåll och konfiguration, inte hela imagen mot
administratörer som kan ersätta både manifest, verktyg och startkommando.

## Paket och reproduktion

Verktygen i `scripts/restart-safety/` gör inga nätanrop eller deploymentändringar.
Generera paket **offline ur en granskad kandidatimage**, aldrig ur den körande
container vars innehåll ska kontrolleras. `--image-root` är den extraherade
`/app`-katalogen. Bind image-ID/digest till exakt byggd Git-SHA med byggkvittot;
`--image-digest` är spårbarhetsdata, inte en automatisk verifiering av det sambandet.

```sh
python3 scripts/restart-safety/make-package.py \
  --image-root "$EXTRACTED_APP" --image-digest "$REVIEWED_IMAGE_DIGEST" \
  --revision "$EXACT_RELEASE_SHA" --paused true --output "$NEW_PAUSE_PACKAGE"
python3 scripts/restart-safety/make-package.py \
  --image-root "$EXTRACTED_APP" --image-digest "$REVIEWED_IMAGE_DIGEST" \
  --revision "$EXACT_RELEASE_SHA" --paused false --output "$NEW_OPEN_PACKAGE"
```

Generatorn vägrar skriva över paket. Granska diffen i manifestet: för den här
ändringen väntas ny revision, imageproveniens och startskriptets hash; övriga åtta
filer och alla migrationer måste jämföras, aldrig antas vara oförändrade efter
ett nytt bygge. `package.json` kvitterar varje fil/kommando med byteantal och hash.
Använd exakt filinnehåll i `start-command-app.txt` respektive
`start-command-migrator.txt`; ingen extra radbrytning. Transportera motsvarande
B64-filer som explicit konfiguration. Gammalt manifest ska avvisa det nya skriptet.
`start-command-precheck.txt` kör samma transportkontroller och grind i
migrator-läge men avslutas med `PRECHECK_OK`, exit 0, utan något exec-mål.
Det används för att kvittera tillämpad NEVER innan en riktig migrator beställs.

```sh
python3 scripts/restart-safety/test_start.py
python3 scripts/restart-safety/check-negative.py
```

Docker krävs, men inga beroendeinstallationer eller API-imagebyggen. Proven körs
seriellt på node:20-slim, nät `none`, 256 MiB, 0,5 CPU per container. De använder
riktig bootstrap, grind och appskript; Node-app och Prisma-CLI är syntetiska
instrument som registrerar starter/exit/signaler. De bevisar processkedjan,
inte databasfunktion eller Nest-verksamhet. CI:s befintliga driftpaus-, databas-
och shutdownprov täcker den senare nivån. Nytt jobb `App restart safety` ingår i
`CI passed` och kör även negativa kontroller med samma assertions:

- Återinförd migrering: krasch/omstartsprovet faller på `MIGRATOR_STARTED`.
- Bortkopplad filhashkontroll (transporthashen uppdateras avsiktligt): samma
  innehållsprov faller när appen faktiskt startar med ändrade deklarerade bytes.

Dockerproven visar ON_FAILURE med tre försök i den lokala containermotorn.
De är **inte** ett påstående om att Railways omstartsmotor har provats här.

## Policy och kontroll av tillämpat värde

Föreslagna roller, en replika var:

| Roll | Omstart | Healthcheck | Pre-deploy |
| --- | --- | --- | --- |
| App | ON_FAILURE, högst 3 återförsök | `/v1/health` | null |
| Engångsmigrator | NEVER, maxRetries null/0 | null | null |

Fyra felande starter som mest i ett sammanhängande förlopp: första försöket och
högst tre återförsök. En frisk process som hänger eller svarar 500 avslutas inte
av den policyn. Den ersätter inte extern övervakning. Löpande omstarter efter
nya driftperioder är inte en livstidsbudget. Larm/operatörskontroll behövs när
budgeten tar slut. Driftpaus måste gälla även efter omstart.

Dokumentation: [Restart Policy](https://docs.railway.com/deployments/restart-policy),
[Config as Code](https://docs.railway.com/config-as-code/reference),
[Deployment Actions](https://docs.railway.com/deployments/deployment-actions).
Railways dokumentation skiljer omstart av befintlig image från ett nytt bygge;
lagrade serviceinställningar räcker därför inte som kvitto på en redan existerande
deployment.

Spara resultatet av denna **läsning** för det exakta nya deployment-ID:t:

```graphql
query($id: String!) {
  deployment(id: $id) {
    id status deploymentStopped instances { id status } meta
  }
}
```

```sh
python3 scripts/restart-safety/verify-applied.py "$DEPLOYMENT_METADATA_JSON" \
  --deployment "$EXACT_DEPLOYMENT_ID" --revision "$EXACT_RELEASE_SHA" \
  --command "$NEW_OPEN_PACKAGE/start-command-app.txt" --role app
# Migrator: motsvarande paket/ID och --role migrator.
```

Kontrollen kräver `meta.serviceManifest.deploy.restartPolicyType=ON_FAILURE`,
`restartPolicyMaxRetries=3`, exakt startkommando, rätt SHA/configFile/builder,
en replika, ingen pre-deploy/cron/sleep och rätt healthcheck. Den avvisar det
nuvarande produktionskvittots NEVER även om `serviceInstance` skulle säga
ON_FAILURE/3. Läs också `fileServiceManifest` och `propertyFileMapping` för att
förklara värdenas ursprung. Saknade fält eller GraphQL-fel stoppar verifieringen.
För migrator krävs NEVER/null-eller-0 och ingen healthcheck.

Komplettera alltid metadata med instansstatus, färsk `GATE_OK`, processens
revision, filhashar, HTTP 200 och automationfält. En lyckad metadatajämförelse
bevisar inte att processen startat eller att migreringen lyckats.

## Införandeordning — separat godkännande krävs

1. Behåll båda deployspärrarna. Läs aktuell main, pågående deployments,
   instanser, kommandon, tillämpad policy och pausstatus på nytt. Samordna med
   backupansvarig; denna ändring ändrar inga backupinställningar.
2. Efter godkänd PR/merge: kräv grön CI för **exakt merge-SHA**, bygg kandidat,
   bind image/revision och frys/granska paus- och öppet paket enligt ovan.
   PR-head eller testimagen får inte återanvändas som mergeidentitet.
3. Kör hela start-/omstartsprovet i isolerad miljö med den slutliga imagen.
   Prova därefter Railways tillämpade policy och omstart i separat testtjänst
   under en ny order: rätt kommando/SHA, krasch, ny GATE_OK, inga migrationer,
   begränsade återförsök, SIGTERM och bibehållen paus. Ingen sådan tjänst skapas här.
4. Produktionsövergången startar under kontrollerad driftpaus. Hantera globala
   köpauser, gamla instansens skrivarstopp och verifierad backup enligt befintligt
   införandekort. Att sätta en variabel pausar inte redan startade cron/konsumenter.
5. Den här PR:n har **inga schemamigrationer**. Verifiera historik/checksummor och
   avsaknad av pending/ofärdiga migrationer. Om en senare release kräver
   migration: kör separat grindad migrator med NEVER, ingen healthcheck, en
   instans, inga appstarter. Kör först paketets verifierande precheck som egen
   deployment med samma NEVER/ingen-healthcheck-inställningar; verifiera dess
   tillämpade metadata med `--role migrator` och precheckkommandot. Byt sedan
   enbart till matchande migratorkommando och beställ engångskörningen. Läs dess
   egen tillämpade metadata, exit 0 och efterkontroller innan appen släpps fram.
   Fel stoppar ordningen;
   ingen automatisk omkörning och ingen appstart som reservväg.
6. Lägg först upp det nya appkommandot och dess matchande pauspaket med appens
   policy fortfarande NEVER. Starta ny exakt revision, läs tillämpad metadata,
   kontrollera GATE_OK, inga migrationsloggar, HTTP 200, `paused=true`, noll
   cron/konsumenter och ingen deposit-backfill. Säkerställ gamla generationens
   avveckling och en enda aktiv appinstans.
7. Först när den nya startvägen bevisats: förbered ON_FAILURE/3 för **appen**.
   Skapa kontrollerat den deployment som faktiskt tillämpar den inställningen;
   anta inte att sparad inställning ändrar den redan körande deploymenten.
   Kontrollera samma paket och paus i dess `meta.serviceManifest`. Om Railway
   inte kan visa rätt tillämpad policy: stoppa här och behåll NEVER.
8. Återöppna med matchande öppet paket och `OPS_AUTOMATION_PAUSED=false` i ett
   kontrollerat startförlopp, fortsatt ON_FAILURE/3. Kör `verify-applied.py` mot
   exakt deployment-ID. Verifiera HTTP 200/revision, 35 cron och 11 konsumenter
   (eller ny härledd inventering), återuppta köer enligt införandekortet och
   observera hälsa, färska cronpulser och en instans. Ingen produktionskrasch
   injiceras för att prova policyn.
9. Kvittera båda deployspärrarna oförändrade. Migratorn ska vara avslutad och
   fortfarande NEVER; dess inställning får inte ärva appens policy.

## Återställningsordning

1. Vid återkommande startfel: avbryt återöppning, håll/återinför driftpaus och
   globala köpauser; läs logg/exit och säkra skrivarstopp. Stopp/avveckling av
   felande deployment är operatörsåtgärd; vänta inte på lagrad policyändring.
2. Föredra samma nya appimage under NEVER och matchande pauspaket om endast
   policy eller driftkonfiguration fallerat. Kontrollera *tillämpad* NEVER.
3. Om kod måste återställas: välj bevarad #896-image/revision
   `30724b17…` och dess **matchande** pauspaket (manifest `346e8d47…`), appkommando,
   transportvärden och tillämpad NEVER. Det gamla skriptet migrerar vid start;
   återställ därför aldrig den vägen under ON_FAILURE. Verifiera att schema och
   historik fortfarande är kompatibla före start. Denna PR kräver ingen DB-down.
4. Gör motsvarande pausade hälsokontroller, säkerställ en instans, återöppna
   först efter bedömning med gammalt matchande öppet paket (`69b419a0…`) och
   NEVER. Blanda aldrig ny revision med gammalt manifest eller tvärtom.
5. Om migratorn misslyckats: inspektera migrationshistorik och verkliga
   schemaeffekter. Ingen blind `migrate resolve`, automatisk återkörning eller
   dumpåterläsning. Återläsning är en separat godkänd återställningsåtgärd.
