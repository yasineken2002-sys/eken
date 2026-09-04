# Runbook: en motor som avstod från allt ser likadan ut som en motor som dog

Gäller larmet **`[cron:ai-resumption-freshness]`** och skuggmotorns utfall
(`AiResumptionRun`, `AiResumptionVerdict`).

Regeln i en mening: _innan du rör motorn, läs den senaste körningsraden — larmet
säger att den slutat skriva, inte varför._

## Varför den här filen finns

Återupptagningsmotorn kör i **skuggläge**: den läser, avgör och skriver ner, men
utför ingenting. Den skriver en `AiResumptionRun` även när den avstod från allt —
det är hela poängen med hjärtslaget. Men två helt olika tillstånd ger samma
tystnad:

```
"motorn avstod från allt"   ← normalt, och det vanliga utfallet
"motorn kördes aldrig"      ← trasigt
```

Larmet i #683 skiljer dem åt. Den här filen är den andra halvan: raderna motorn
skriver hade **noll läsare utanför larmet självt** (#678), så "läs skuggutfallet"
var ingen handling någon kunde utföra utan att först hitta på en SQL-fråga.
Frågorna nedan är körda mot en riktig databas — se avsnittet Negativkontroll för
vad det betyder och inte betyder.

## Vad larmet betyder

`ResumptionFreshnessService` (`apps/api/src/ai/resumption/resumption-freshness.service.ts`)
prövar var femtonde minut (`KADENS`, rad 87) hur gammal den senaste
`AiResumptionRun`-raden är. Är den äldre än tröskeln — eller finns ingen rad alls
— rapporteras det.

```
tröskel   ATERUPPTAGNING_TYSTNAD_MAX_MS = 2 h 15 min (8 100 000 ms)
          resumption-freshness.service.ts:84
```

**Talet är en LITERAL och får inte räknas fram ur `HJARTSLAG_MS`.** Skälet står i
koden: två gränser som ska kunna ändras var för sig får inte vara en gräns. Hade
tröskeln varit `2 * HJARTSLAG_MS` hade en ändring av hjärtslaget flyttat larmet
utan att något blev rött.

Tröskeln kan inte bli snabbare än hjärtslaget. Vill man upptäcka en död motor
inom en timme är `HJARTSLAG_MS` spaken, inte tröskeln — och det är ett eget
beslut med en egen kostnad.

**"Ingen rad alls" larmar lika högt som "gammal rad".** Motorn skriver ett
hjärtslag direkt efter omstart, så en tom tabell efter mer än ett kvarts drift
betyder att den aldrig kom igång.

### Var larmet syns

Larmet går till `CronErrorSink.report(...)` (`resumption-freshness.service.ts:209`)
→ `ErrorLog`. Ingen ny kanal, och den lokala loggen överlever inte containern.

```
severity  CRITICAL          source  API
message   [cron:ai-resumption-freshness] …
context   { cron: "ai-resumption-freshness", ageMs, tröskelMs, harNågonKörning }
```

- **API:** `GET /v1/platform/errors` (`?severity=CRITICAL&source=API&resolved=false`)
- **Adminappen:** sidan `/errors` (`apps/admin/src/pages/ErrorsPage.tsx`)
- **Pulsen, utan att gå via larmet:** fältet `resumption` i `GET /v1/health`
  (`apps/api/src/common/health/health.controller.ts:147`)

Det sista är det **externt drivna** benet. Larmet är självt ett `@Cron`: slutar
schemaläggaren fungera slutar både motorn och larmet, och då har tystnaden bara
flyttat ett steg. `/v1/health` pollas av Railway, alltså utifrån processen.

```bash
curl -fsS https://eken-production.up.railway.app/v1/health \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["resumption"])'
# {'lastRunAt': '2026-09-03T12:54:00.008Z', 'ageSec': 119, 'thresholdSec': 8100}
# ↑ avläst mot prod 2026-09-03: 119 s av 8 100 — friskt med god marginal.
```

Fältet bär **åldern och tröskeln, inte ett omdöme**: `ageSec > thresholdSec`
betyder tystnad, och den jämförelsen gör läsaren själv. `lastRunAt: null` betyder
att motorn aldrig skrivit något.

### Samma signal finns nu för ALLA tio låsta jobb (#710)

Den här runbooken beskrev länge det enda jobb som hade en tystnadssignal. De
övriga nio låsta jobben hade ingen: ett hängt lås — eller ett jobb som slutat
schemaläggas — var osynligt tills någon saknade dess utfall, vilket för
månadsrapporten är nästa månad.

`GET /v1/health` bär nu fältet `cron` bredvid `resumption`:

```bash
curl -fsS https://eken-production.up.railway.app/v1/health \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["cron"]; \
      print("stale:", d["staleCount"], "av", len(d["jobs"])); \
      [print(f"  {k:34s} ageSec={v[\"ageSec\"]} / {v[\"thresholdSec\"]}  {v[\"lastOutcome\"]}") \
       for k,v in sorted(d["jobs"].items()) if v["stale"]]'
```

Samma form som `resumption`: **två tal och en gräns**, jämförelsen gör läsaren.
`staleCount` är talet att larma på utan att läsa tio fält.

Tre skillnader mot `resumption` som är värda att känna till:

- **Tröskeln är per jobb**, härledd ur jobbets eget `@Cron`-uttryck × 2,25 — en
  missad körning tolereras, två gör det inte. Ett vardagsjobb får tre dygn som
  bas (gapet fredag→måndag), inte medelintervallet.
- **`lastOutcome`** skiljer _tyst_ från _trasigt_. Ett jobb som kastar varje natt
  är inte tyst; det körs och misslyckas, och det kräver en annan åtgärd.
- **`lastRunAt: null` mäts mot `bootAt`**, inte mot epoken. Ett dagligt jobb är
  inte tyst fem minuter efter en deploy — men passeras tröskeln räknat från boot
  blir det tyst ändå.

`resumption`-fältet står kvar oförändrat. Det har en egen tröskel med ett eget
skäl (2 h 15 min, satt efter motorns garanterade skrivintervall och inte efter
dess kadens) — se `resumption-freshness.service.ts`.

## Läs skuggutfallet

Sätt `DATABASE_URL` först. Skriv aldrig ut anslutningssträngen.

```bash
export PGURL="$DATABASE_URL"
```

**1. Senaste körningarna — börja alltid här.**

```sql
SELECT "startedAt", "finishedAt", mode,
       candidates, resumed, abstained,
       "reasonCounts",
       COALESCE(failure, '-') AS failure
FROM "AiResumptionRun"
ORDER BY "startedAt" DESC
LIMIT 20;
```

`candidates = 0` med tom `reasonCounts` är ett **hjärtslag**: motorn körde och
hade ingenting att titta på. Det är friskt.

**2. Glappen mellan raderna — visar VAR tystnaden började.**

```sql
SELECT "startedAt",
       ROUND(EXTRACT(EPOCH FROM ("startedAt" - LAG("startedAt") OVER (ORDER BY "startedAt")))) AS glapp_sek
FROM "AiResumptionRun"
WHERE "startedAt" > NOW() - INTERVAL '24 hours'
ORDER BY "startedAt" DESC
LIMIT 20;
```

Ett glapp över 3 600 s betyder att ett hjärtslag uteblivit. Översta raden har
alltid tomt glapp — den har ingen föregångare i fönstret.

**3. Fördelningen per skäl över en period.**

```sql
SELECT r.key AS skal, SUM(r.value::int) AS antal
FROM "AiResumptionRun" k,
     LATERAL jsonb_each_text(k."reasonCounts") AS r(key, value)
WHERE k."startedAt" > NOW() - INTERVAL '7 days'
GROUP BY r.key
ORDER BY antal DESC;
```

**4. Domarna, per beslut och skäl.**

```sql
SELECT d.decision, d.reason, COUNT(*) AS antal,
       ROUND(AVG(d."ageSec")) AS medel_alder_sek,
       MAX(d.assessments) AS max_bedomningar
FROM "AiResumptionVerdict" d
JOIN "AiResumptionRun" k ON k.id = d."runId"
WHERE k."startedAt" > NOW() - INTERVAL '7 days'
GROUP BY d.decision, d.reason
ORDER BY antal DESC;
```

`decision` är `RESUME | ABSTAIN`. `reason` är `PRE_TWO_PHASE`,
`UNKNOWN_CLASSIFICATION`, `REQUIRES_HUMAN`, `NO_TRACE`, `TOO_FRESH`, `TOO_OLD`,
`QUOTA_BLOCKED`, `RESUMABLE`. Ett `RESUME` i skuggläge betyder att motorn
**skulle** ha återupptagit — den gjorde det inte.

**5. Körningar som kastade.**

```sql
SELECT "startedAt", mode, candidates, failure
FROM "AiResumptionRun"
WHERE failure IS NOT NULL
ORDER BY "startedAt" DESC
LIMIT 20;
```

**6. Larmet självt, ur `ErrorLog`.**

```sql
SELECT "createdAt", severity, resolved, message
FROM "ErrorLog"
WHERE context->>'cron' = 'ai-resumption-freshness'
ORDER BY "createdAt" DESC
LIMIT 20;
```

## Vid larm — i den här ordningen

1. **Läs pulsen utifrån.** `curl` mot `/v1/health` enligt ovan. Svarar
   endpointen inte alls är det ett annat och större fel — då är inte motorn
   frågan.
2. **Kör fråga 1.** Finns rader? Hur gammal är den senaste? Talet i larmets
   `context.ageMs` ska stämma överens.
3. **Kör fråga 2.** Ett enda glapp mitt i en annars tät serie pekar på en deploy
   eller omstart. En serie som bara upphör pekar på en död schemaläggare.
4. **Kör fråga 5.** Kastade sista körningen? Då står orsaken i `failure`, och
   samma fel finns i `ErrorLog` med `context.cron = 'ai-resumption'`.
5. **Kontrollera revisionen.** `revision` i samma `/v1/health`-svar. Kör prod en
   annan commit än `main` är deployen det första att förklara.
6. **Först därefter** överväg omstart av tjänsten.

## Vad man INTE gör

- **Starta inte om schemaläggaren eller tjänsten innan fråga 1 och 2 är körda.**
  En omstart skriver ett nytt hjärtslag direkt, larmet tystnar, och det enda
  spåret av hur länge motorn varit död är borta. Larmet är avblåst utan att något
  är utrett.
- **Sänk inte `ATERUPPTAGNING_TYSTNAD_MAX_MS` under hjärtslaget.** Provet
  `resumption-freshness.spec.ts` fäller det, eftersom resultatet vore ett larm som
  går varje timme på en frisk motor.
- **Räkna inte fram tröskeln ur `HJARTSLAG_MS`.** Se ovan — det gör två gränser
  till en.
- **Tolka inte `resumed > 0` som att något utfördes.** Motorn är i `SHADOW`, och
  raden säger vad den skulle ha gjort.
- **Markera inte larmet löst i adminappen förrän fråga 1 visar en färsk rad.**
  `resolved` säger då bara att någon tryckte på knappen.

## Negativkontroll — vad "frågorna är körda" betyder

Samtliga sex frågor är körda mot `eken_dev`. Båda tabellerna var **tomma**, så
ett skarpt utfall bevisar bara att frågan är syntaktiskt giltig mot schemat — och
noll rader är inte skiljbart från en fråga som letar på fel ställe
(se [bevisrigg-riktig-postgres.md](./bevisrigg-riktig-postgres.md)).

Varje fråga kördes därför också mot en fixtur i en transaktion som **rullades
tillbaka**, och krävdes ge rader:

```bash
psql "$PGURL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
-- … INSERT av tre körningar och tre domar …
-- … frågorna 1–6 …
ROLLBACK;
SQL
# och verifiera att ingenting blev kvar:
psql "$PGURL" -c 'SELECT (SELECT COUNT(*) FROM "AiResumptionRun") runs,
                         (SELECT COUNT(*) FROM "AiResumptionVerdict") verdicts;'
```

Gör likadant om du ändrar en fråga: en fråga som aldrig setts returnera en rad är
ingen fråga, den är en förhoppning.

## Checklista: är larmet avblåst?

```bash
export PGURL="$DATABASE_URL"

# 1. Färsk körningsrad? Åldern ska vara långt under 8 100 s.
psql "$PGURL" -c 'SELECT "startedAt", ROUND(EXTRACT(EPOCH FROM (NOW() - "startedAt"))) AS alder_sek
                  FROM "AiResumptionRun" ORDER BY "startedAt" DESC LIMIT 1;'

# 2. Samma sak utifrån, oberoende av schemaläggaren.
curl -fsS https://eken-production.up.railway.app/v1/health \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["resumption"]; \
      print(d["ageSec"], "av", d["thresholdSec"], "→", "TYST" if (d["ageSec"] or 10**9) > d["thresholdSec"] else "frisk")'

# 3. Inga nya larm sedan åtgärden.
psql "$PGURL" -c "SELECT COUNT(*) FROM \"ErrorLog\"
                  WHERE context->>'cron' = 'ai-resumption-freshness'
                    AND \"createdAt\" > NOW() - INTERVAL '1 hour';"

# 4. Kör prod den commit du tror?
curl -fsS https://eken-production.up.railway.app/v1/health \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["revision"])'
```

Alla fyra ska stämma. Punkt 1 utan punkt 3 räcker inte: en färsk rad kan komma
från omstarten du just gjorde, medan orsaken är kvar.
