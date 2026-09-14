# Driftpaus för automatiska verksamhetsjobb

En process kan startas i ett läge där den **inte** utför automatiskt arbete. Läget
väljs innan processen startar, går att kontrollera efteråt, och hävs bara genom
att starta om utan flaggan.

**Ingen paus är aktiverad någonstans.** Den här filen beskriver en mekanism som
finns i koden och är verifierad isolerat. Den säger ingenting om vad som körs i
produktion.

## Vad flaggan gör

| Variabel                | Värde        | Verkan                                         |
| ----------------------- | ------------ | ---------------------------------------------- |
| `OPS_AUTOMATION_PAUSED` | `true`       | Pausat läge                                    |
|                         | `false`      | Normal drift                                   |
|                         | saknad / tom | Normal drift — **dagens beteende, oförändrat** |
|                         | allt annat   | **Uppstart avbryts**                           |

Den sista raden är avsiktlig. En felstavning (`ture`, `TRUE`, `1`) får inte tyst
betyda "kör på" i just det ögonblick någon trodde sig ha pausat. Kastet sker vid
boot, före första jobbet, i alla miljöer.

Var beredd på konsekvensen. Står det ogiltiga värdet i **processmiljön** sker
kastet redan vid **modulimport**, alltså före Nest, före `validateEnv` och före
HTTP-servern. Står det bara i `.env` fälls det i stället av `validateEnv`. Ett stavfel i pausvariabeln tar
därför ned **hela API:t**, inte bara automatiken — Railway startar om tre gånger
(`restartPolicyType = "ON_FAILURE"`, `restartPolicyMaxRetries = 3`) och ger sedan
upp. Rätt riktning (fail-closed), men en dyrare konsekvens än ordet "avbryts"
antyder, och utan `validateEnv`:s samlade felmeddelande.

Saknat värde betyder normal drift, så ingen befintlig miljö behöver röras för att
fortsätta fungera. Priset är att en **utebliven** paus ser ut som en normal start
— därför ska läget alltid läsas tillbaka ur `/v1/health` efter start.

### Variabeln måste vara PROCESSMILJÖ, inte en rad i `.env`

Flaggan läses vid fyra olika tidpunkter. `ConfigModule.forRoot` är asynkron och
lägger `.env`-filens värden i `process.env` **efter** att `imports`-arrayen
byggts. Uppmätt med en sond som speglar exakt den ordningen: båda **grindarna**
(konsumenterna och schemaläggaren) läser processmiljön _före_ `.env`, medan
`DepositsService`-backfillen och `/v1/health` läser vid runtime, alltså _efter_.

Ett värde som bara står i `apps/api/.env` hade därför gett ett **splittrat**
tillstånd: cron igång, elva konsumenter igång, uppstarts-backfillen pausad — och
`/v1/health` sägande `paused: true` om en process som inte pausat något av
betydelse.

Det tillståndet är gjort **omöjligt**, inte dokumenterat bort: `validateEnv`
jämför processmiljöns värde mot det som `ConfigModule` löste ut och **avbryter
uppstarten** om de skiljer sig. Felmeddelandet säger vad som ska rättas.
Produktionen (Railway) är inte drabbad — `apps/api/Dockerfile` kopierar ingen
`.env` — men en repetition av proceduren lokalt eller i en container är det.

## Vad som stoppas i pausat läge

| Yta                | Antal | Mekanism                                                                                  |
| ------------------ | ----- | ----------------------------------------------------------------------------------------- |
| `@Cron`-jobb       | 34    | `ScheduleModule.forRoot()` registreras inte → ingen timer finns att avfyra                |
| Bull-konsumenter   | 11    | `@Processor`-klassen utelämnas ur modulens `providers` → `queue.process()` anropas aldrig |
| Uppstarts-backfill | 1     | `DepositsService.onApplicationBootstrap` hoppas över                                      |

Grinden sitter på **registreringen**, inte i jobbkroppen. Ett jobb kan därför
inte hinna köra "en gång innan spärren slog till".

Köade, fördröjda och återkommande jobb **bevaras**. Pausen stoppar konsumtion —
den tömmer, kvitterar och markerar ingenting.

## Vad flaggan INTE skyddar mot

Det här är inte en avgränsning som kan skrivas bort; det följer av att flaggan
gäller en process, från dess egen start.

- **Redan körande äldre processer.** En container som startade utan variabeln
  fortsätter köra cron och konsumera köer. Pausen når den aldrig.
- **Manuella anrop.** Varje skrivande HTTP-endpoint fungerar som förut. Flaggan
  rör inte ingressen.
- **Okända externa skrivare.** Andra tjänster eller människor med DB-åtkomst
  berörs inte.
- **Redan enqueueade jobb** konsumeras av vilken opausad worker som helst som är
  ansluten till samma Redis.
- **Sin egen deploys migrering.** `apps/api/Dockerfile` kör
  `apps/api/scripts/migrate-and-start.sh`, som gör `prisma migrate deploy`
  **innan** Node startar — oberoende av pausen. **21 av migrationsfilerna
  innehåller `UPDATE`/`INSERT`** mot verkliga tabeller (t.ex.
  `20260512200000_billing_subscription_plans` skriver i `Organization`). Bär
  deployen en sådan migration har den pausade processen ändå skrivit i
  produktionsdatabasen, före sin första loggrad. Det är den enda punkten i den
  här listan som utlöses av den pausade processen själv.
- **Aktiva jobb återvinns inte under paus.** Bulls stalled-check körs bara av
  `Queue.run()`, som nås via `process()`. I pausat läge registreras ingen
  processor, så ett jobb som en dödad äldre generation lämnade i `active` ligger
  kvar där — inte förlorat, men inte heller synligt som `waiting`. Verktyget
  rapporterar talet; det återupptas först när pausen hävs.

Bankfixens införandeordning kräver verklig avskärmning — stängd ingress, bevisat
stoppade gamla generationer, spärrad återstart. Den här flaggan är steg 8:s
saknade halva, **inte** en ersättning för steg 1–4.

## Kontrollera läget efter start

`GET /v1/health` bär fältet `automation`:

```json
"automation": {
  "paused": true,
  "variable": "OPS_AUTOMATION_PAUSED",
  "cronJobs": null,
  "queueConsumers": { "registered": 0, "withheld": 11 }
}
```

`paused` är vad konfigurationen säger. `cronJobs` och `queueConsumers` är vad
processen faktiskt gjorde. **Går de isär är det ett fynd, åt båda hållen:**
`paused: true` med `cronJobs: 34` betyder att variabeln lästes efter att timrarna
redan startat; `paused: true` med `registered: 11, withheld: 0` betyder att
konsumenterna inte grindades. Den andra formen kan inte längre uppstå — boot
fälls först — men läs ändå båda talen, inte bara `paused`.

`cronJobs: null` betyder att `ScheduleModule` inte laddades alls — pausat läges
normaltillstånd, och även dev:s.

Fältet påverkar **aldrig** `status`. `railway.toml` pollar `/v1/health` med
`restartPolicyType = "ON_FAILURE"`; ett fält som sänkte `status` hade gjort en
avsiktlig paus till en omstartsloop där varje ny process startade pausad och
fällde samma healthcheck.

## Återöppning

En väg, uttryckligen: **ta bort variabeln (eller sätt `false`) och starta en ny
process.** Det finns med flit ingen endpoint, ingen timeout och ingen automatik
som kan häva pausen, så att en healthcheck, en Railway-omstart eller en deploy
med gammal konfiguration inte kan öppna verksamhetsjobben.

## Köverktyget

`apps/api/src/scripts/queue-ops.ts` inspekterar och pausar Bull-köer **globalt i
Redis**, utan att starta Nest/AppModule. Standardläget är läsande.

```bash
# 1. LÄS FÖRST. Skriver ingenting. Skriv av måltexten ur utskriften.
node -r ts-node/register apps/api/src/scripts/queue-ops.ts \
  --redis-url=redis://HOST:PORT/DB --prefix=bull

# 2. ÅTGÄRD. --confirm måste vara EXAKT måltexten ur steg 1.
node -r ts-node/register apps/api/src/scripts/queue-ops.ts \
  --redis-url=redis://HOST:PORT/DB --prefix=bull \
  --action=pause --confirm='redis://HOST:PORT/dbN prefix=bull'

# 3. ÅTERÖPPNING är ett eget, lika uttryckligt handgrepp.
  --action=resume --confirm='redis://HOST:PORT/dbN prefix=bull'
```

Tre spärrar mot fel system:

1. `--redis-url` är obligatorisk, och **dess form är snäv**. Verktyget läser med
   flit **inte** `REDIS_URL` ur miljön — ett verktyg som kör mot "det som råkade
   stå i miljön" antar produktion som standard.

   Den enda godtagna formen är
   `redis://[användare:lösenord@]VÄRD[:PORT][/DB]`, eller `rediss://` för TLS.
   **Query och fragment avvisas**, och det är inte kosmetik: Bull 4.16.5 låter
   queryparametrar ersätta värd, port, databas och nyckelprefix _efter_ att
   måltexten räknats fram. Uppmätt mot oförändrad Bull, nätverksfritt:

   ```
   redis://display.example:6379/0?db=2&host=actual.example&port=6381
     bekräftelsen visade   redis://display.example:6379/db0 prefix=bull
     klienten fick         host=actual.example port=6381 db=2

   redis://h.example:6379/0?keyPrefix=actual-prefix
     inventeringen läste   prefix bull
     åtgärden muterade     prefix actual-prefix
   ```

   Den andra raden är den farligaste: verktyget läste ett nyckelrum och pausade
   ett annat, rakt igenom tommålsspärren i punkt 3. Behöver du sätta en option
   som bara går att nå genom queryn — hör av dig i stället för att kringgå:
   flaggan ska bli synlig i måltexten, annars är den inte bekräftad.

   Samma skäl gäller `--prefix`: **Redis-metatecken (`*`, `?`, `[`, `]`, `\`)
   avvisas**. Ett prefix är en sträng för Bull och ett mönster för `SCAN`, så
   `bu?l` hade läst nycklarna under `bull:` och sedan pausat under det
   bokstavliga `bu?l:` — uppmätt mot riktig Redis 7.4.8.

   **`rediss://` ger faktisk TLS**, med certifikatverifiering kvar. Tidigare
   gjorde det inte det: Bull omvandlar URL:en till ett optionsobjekt utan `tls`,
   och ioredis egen `rediss`-detektering gäller bara strängargumentet — som
   ioredis aldrig fick se. Rapporten sa `rediss`, anslutningen var oskyddad.

2. Muterande åtgärder kräver `--confirm` med exakt måltexten (schema, värd, port,
   databasindex, prefix). **Vad den faktiskt är:** en stavfels- och
   ändringsspärr, inte ett bevis för att operatören läst läsläget först —
   måltexten är en ren funktion av flaggorna och går att räkna ut i huvudet. Det
   den bevisligen fångar är ett stavfel mellan läsning och åtgärd, och en URL
   eller ett prefix som ändrats däremellan.
3. Inventeringen jämförs mot koden. `inventeringKomplett` blir `false` vid en kö
   i Redis som koden inte känner till, vid ett avgränsat `--queues`, **och när
   ingen enda av de begärda köerna har spår under prefixet** — det sista ledet
   finns därför att `pause(false)` lyckas även mot ett könamn som inte existerar,
   så ett fel prefix hade annars rapporterat elva pausade köer. En muterande
   åtgärd **vägrar** mot ett sådant mål. Ett okänt namn i `--queues` avbryter
   också, eftersom `mail-high` (bindestreck) annars hade pausats med framgång
   medan `mail:high` konsumerade vidare. **Ett upprepat namn avbryter likaså:**
   fullständighetsomdömet jämför mängder, men jämförde tidigare listlängder, och
   `--queues=pdf,pdf,…` (elva gånger) fick därför fullt klartecken medan tio köer
   stod orörda.

**Gränserna för punkt 3, utskrivna:** spärren fångar ett **helt tomt** mål. Den
skiljer inte "rätt mål" från "fel mål" — ett gammalt prefix eller db-index från
_samma_ app bär alla elva `:id`-nycklar och passerar. Att skilja de två kräver
något läst ur det levande målet och jämfört mot något oberoende (Redis `run_id`,
högsta jobb-id per kö); det är inte byggt. Är målet tomt **med flit** (nyuppsatt
eller nyss flushad Redis) finns `--allow-empty-target`, som häver vägran men
aldrig omdömet.

Två fler saker operatören behöver veta:

- **En kö i `okandaIRedis` går inte att pausa med `--queues`** — den finns ju inte
  i kodens inventering, och namnkontrollen avvisar den. Ett sådant fynd är ett
  stoppvillkor som kräver ett eget beslut, inte något verktyget ska köra förbi.
- **`--action=resume` utan `--queues` återöppnar alla elva**, utan att skilja på
  köer som pausades av det här fönstret och köer som var pausade av annan orsak.
  Ange `--queues` vid återöppning, eller läs `globalPaus` per kö först.

Verktyget raderar aldrig jobb (`clean`/`empty`/`remove`/`obliterate` finns inte),
skriver aldrig ut credentials, jobbpayloads eller personuppgifter, och rapporterar
bara antal.

**En global paus stoppar konsumtion.** Den stoppar inte producenter, inte
HTTP-vägar, och inte en gammal process som redan håller ett aktivt jobb — ett
`pause()` som returnerat betyder inte att allt arbete är stoppat.

## Var mekaniken är mätt

| Fil                                            | Vad den bevisar                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `common/ops/automation-pause.spec.ts`          | Tolkningen: tre värden, och att det fjärde kastar                                                                  |
| `common/ops/automation-pause-startup.spec.ts`  | Riktigt Nest-startförlopp, riktiga timrar: ingen körning i pausat läge, och en kanariefågel som fyrar av i normalt |
| `common/ops/automation-pause-queue.db.spec.ts` | Riktig Bull 4.16.5 mot riktig Redis: bevarade jobb, omstart, global paus, uttrycklig återöppning, fel prefix       |
| `scripts/queue-ops.spec.ts`                    | Verktygets spärrar innan en anslutning öppnas                                                                      |
| `apps/api/scripts/check-automation-pause.mjs`  | Att grinden når varje konsument — härlett ur koden, åt båda håll                                                   |

## Bilaga: full täckningsinventering

Härledd ur koden på `codex/bankfix-driftpaus` (bas: #893 `87bd9b8d`), inte
handskriven. `apps/api/scripts/check-automation-pause.mjs` gör om härledningen i
CI och fäller åt båda håll.

### Registrering, enqueue och exekvering är tre olika saker

|                  | Vad det är                                                                                                                               | Vad pausen gör                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Registrering** | `ScheduleModule.forRoot()` läser `@Cron`-metadata och startar timrar; `BullExplorer` anropar `queue.process()` per `@Processor`-provider | **Detta är det som stängs av.** Ingen timer, ingen handler                                          |
| **Enqueue**      | `*.queue.ts` → `queue.add(...)`, anropat av HTTP-vägar, cron och andra jobb                                                              | **Orört.** Producenter fungerar som förut; jobben hamnar i Redis och väntar                         |
| **Exekvering**   | Bull plockar jobbet och kör `@Process`-metoden                                                                                           | Sker inte i den pausade processen. Sker i **vilken annan opausad worker som helst** mot samma Redis |

Att enqueue lämnas orört är avsiktligt: ett HTTP-anrop ska få sitt 202-svar och
sitt jobb bevarat, inte tappas. Det är också varför flaggan inte ersätter en
stängd ingress.

### 34 `@Cron`-jobb — alla via `ScheduleModule.forRoot()` (`app.module.ts:129`)

Talet 34 är samma mängd som `apps/api/scripts/cron-classification.ack.json`
härleder och CI redan bevakar åt båda håll. Ingen av dem registreras i pausat
läge.

```
ai/assignments/ai-assignments.service.ts:634         utgångspass
ai/attachments/ai-attachments.service.ts:549         cleanupExpiredAttachments
ai/execution/execution-sweep.service.ts:70           svepPass
ai/execution-dryrun/dryrun-sweep.service.ts:67       svepPass
ai/resumption/resumption-freshness.service.ts:144    passera
ai/resumption/resumption.service.ts:114              passera
ai/retention/ai-retention.service.ts:99              scheduledRetention
ai/shadow/shadow-sweep.service.ts:67                 svepPass
ai-usage/ai-usage-notifier.service.ts:42             dailyCheck
avisering/avisering.scheduler.ts:41                  generateForCurrentMonth
avisering/rent-bad-debt.service.ts:127               reclassifyProbableLosses
avisering/rent-reminder.service.ts:237               escalateOverdueRentNotices
avisering/rent-reminder.service.ts:552               escalateRemindedToInkassoReady
backup/backup.scheduler.ts:31                        dailyBackup
backup/backup.scheduler.ts:89                        dailyFreshnessCheck
bankid/bankid-auth.service.ts:360                    cleanupExpiredOrders
common/actor/actor-null-sweep.service.ts:83          sveep
leases/leases.service.ts:1419                        processLifecycle
notifications/notifications.service.ts:280           deleteOld
notifications/notifications.service.ts:317           markOverdueInvoices
notifications/notifications.service.ts:357           markOverdueRentNotices
notifications/notifications.service.ts:549           sendMorningInsights
notifications/notifications.service.ts:688           sendWeeklySummary
notifications/notifications.service.ts:815           sendMonthlyReport
notifications/payment-reminder.service.ts:67         processOverdueReminders
platform/auth/platform-token-cleanup.service.ts:36   purgeExpired
platform/errors/error-log-retention.service.ts:70    scheduledRetention
platform/invoices/platform-invoices.service.ts:543   createMonthlyInvoicesCron
platform/invoices/platform-invoices.service.ts:819   sendRemindersAndEscalate
platform/invoices/platform-invoices.service.ts:969   convertExpiredTrialsCron
platform/invoices/platform-invoices.service.ts:1276  sendTrialEndingRemindersCron
psd2/psd2-consent.service.ts:203                     cleanupExpiredConsentStates
tenant-portal/tenant-auth.service.ts:624             cleanupStaleSessions
tenant-portal/tenant-auth.service.ts:674             sendActivationReminders
```

`runCronSafely` (`common/cron/cron-safety.ts`) valdes **bort** som grindpunkt:
den nås först när jobbet redan startat, och `backup.scheduler.ts` går med flit
utanför den. En grind där hade alltså både varit för sen och haft ett hål.

### 11 Bull-konsumenter — alla bakom `pausedUnless`

11 könamn i 9 `BullModule.registerQueue`-anrop. Varje `@Processor`-klass står i
sin moduls `providers` som `...pausedUnless(X)`.

| Konsument                                       | Kö                    | Modul (providers)                         |
| ----------------------------------------------- | --------------------- | ----------------------------------------- |
| `ai/execution/execution.worker.ts:13`           | `ai-agent-execution`  | `ai/execution/execution.module.ts:64`     |
| `ai/execution-dryrun/dryrun.worker.ts:16`       | `ai-execution-dryrun` | `ai/execution-dryrun/dryrun.module.ts:76` |
| `ai/shadow/payment/payment-shadow.worker.ts:16` | `ai-payment-shadow`   | `ai/shadow/shadow.module.ts:89`           |
| `ai/shadow/shadow.worker.ts:17`                 | `ai-shadow`           | `ai/shadow/shadow.module.ts:84`           |
| `import/contract-scan-batch.worker.ts:29`       | `contract-scan-batch` | `import/import.module.ts:48`              |
| `leases/lease-activation.worker.ts:31`          | `lease-activation`    | `leases/leases.module.ts:44`              |
| `mail/mail.worker.ts:318`                       | `mail:high`           | `mail/mail.module.ts:40`                  |
| `mail/mail.worker.ts:341`                       | `mail:normal`         | `mail/mail.module.ts:41`                  |
| `mail/mail.worker.ts:364`                       | `mail:low`            | `mail/mail.module.ts:42`                  |
| `pdf-jobs/pdf.worker.ts:25`                     | `pdf`                 | `pdf-jobs/pdf-queue.module.ts:31`         |
| `psd2/psd2-sync.worker.ts:17`                   | `psd2-sync`           | `psd2/psd2.module.ts:57`                  |

Avskärmningsordningen namnger fyra av dessa (`psd2-sync`, `mail:*`). De övriga
sju är inte mindre farliga under ett underhållsfönster: `pdf` renderar och
skickar avier, `lease-activation` skapar initiala avier och välkomstmejl.

### 6 livscykel-hookar — en av dem skriver

| Hook                                                                  | Effekt                                                         | Grindad?       |
| --------------------------------------------------------------------- | -------------------------------------------------------------- | -------------- |
| `deposits/deposits.service.ts:62` `onApplicationBootstrap`            | **Skriver**: skapar `Deposit`-rader och bokför 1510 D / 2890 K | **Ja**         |
| `common/crypto/pii-coherence.service.ts:263` `onApplicationBootstrap` | Diagnostik; kan skriva en `ErrorLog`-rad vid larm              | Nej — se nedan |
| `ai/knowledge/retrieval/legal-retrieval.service.ts:97` `onModuleInit` | Läser och loggar paritet                                       | Nej            |
| `common/prisma/prisma.service.ts:29` `onModuleInit`                   | `$connect`                                                     | Nej            |
| `notifications/monthly-report.service.ts:65` `onModuleInit`           | DI-upplösning via `ModuleRef`                                  | Nej            |
| `notifications/notifications.service.ts:178` `onModuleInit`           | DI-upplösning via `ModuleRef`                                  | Nej            |

De fem ogrindade utför inget **verksamhetsarbete**: de kopplar ihop beroenden,
öppnar en anslutning eller rapporterar ett tillstånd. `pii-coherence` är den enda
gränsdragningen värd att skriva ut — den kan skriva en rad i `ErrorLog`, men det
är ett _larm om_ ett tillstånd, och ett underhållsfönster är precis när det
larmet ska nå fram. Att tysta det hade gjort pausen till en blindhet.

### Egna timers och pollers

Inga. `setInterval` förekommer inte i produktionskoden under `apps/api/src`.
`SchedulerRegistry` slås upp på exakt ett ställe, och det är läsande: hälsokontrollen
gör `moduleRef.get(SchedulerRegistry, { strict: false })` inom try/catch för att
kunna RÄKNA registrerade timrar (`health.controller.ts`). Ingen kod registrerar
eller startar ett jobb den vägen. Inga återkommande Bull-jobb heller —
`repeat:` finns inte i produktionskoden, så kadensen ägs helt av
`@nestjs/schedule`.
