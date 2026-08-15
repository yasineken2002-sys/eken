# Bokföringsauditen — status

Läget efter genomgången av pengalagret 2026-07-27. Kort och faktisk; detaljerna
finns i respektive PR och i `launch-readiness-atgardslista.md`.

## Stängda fynd

| #   | Fynd                                                                                                              | PR                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| C1  | Ingen balansgrind i huvudbokens skrivväg — alla 15 verifikatvägar saknade kontroll av debet = kredit              | [#249](https://github.com/yasineken2002-sys/eken/pull/249) |
| C2  | Fakturaverifikatet obalanserat vid flerradsmoms (0,01–0,02 kr, bevisat reproducerbart)                            | [#248](https://github.com/yasineken2002-sys/eken/pull/248) |
| C4  | Manuell bankmatchning bokförde fakturans total i stället för mottaget belopp                                      | [#250](https://github.com/yasineken2002-sys/eken/pull/250) |
| C5  | `/pay` ignorerade angivet belopp och bokförde alltid hela totalen                                                 | [#250](https://github.com/yasineken2002-sys/eken/pull/250) |
| H2  | SIE4 deklarerade `#FORMAT PC8` men skrev UTF-8                                                                    | [#251](https://github.com/yasineken2002-sys/eken/pull/251) |
| H3  | SIE4 `#RAR` bar exportintervallet i stället för räkenskapsåret                                                    | [#251](https://github.com/yasineken2002-sys/eken/pull/251) |
| H5  | Period- och räkenskapsårshärledning i UTC — poster kunde hamna i stängd period vid års-/månadsskiften (8 ställen) | [#252](https://github.com/yasineken2002-sys/eken/pull/252) |

Utanför auditen, samma omgång:

| Fynd                                                                                | PR                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Testsviten kördes aldrig i CI — bara typecheck + lint                               | [#247](https://github.com/yasineken2002-sys/eken/pull/247) |
| Cron-jobben registrerades även i dev (weekly-summary fan-outade över 224 testorgar) | [#253](https://github.com/yasineken2002-sys/eken/pull/253) |
| AI-rapporter genererades för organisationer helt utan förvaltningsdata              | [#254](https://github.com/yasineken2002-sys/eken/pull/254) |

## Testsviten

~185 sviter / ~1 676 tester. **Körs i CI sedan #247** (`Tests`-jobbet,
`jest --ci --runInBand`). Seriellt är medvetet: parallella workers OOM-dödas på
2-kärniga runners och ger slumpvis röda sviter utan testfel.

## Kvar av auditen — BLOCKERAT PÅ BESLUT, inte kod

| #       | Fynd                                                                                                                                                                              | Blockerat på                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| C6      | Momspliktig lokal kan aviseras utan moms — bara en loggvarning (`avisering.service.ts`, `rentVat`). Enda kvarvarande med aktiv pengarisk: för lite redovisad utgående moms        | Redovisningskonsult: är kombinationen ogiltig och ska avvisas vid kontraktsregistrering, eller ska moms läggas på ändå? |
| H1      | Betalning som ej täcker ränta flippar avi till PAID → strandad räntefordran (bryter INV-S). Räntan blir oindrivbar: `crystallizeInterest` och exportgrinden hoppar båda över PAID | Produktbeslut om restränta                                                                                              |
| H4      | SIE4 saknar `#IB`/`#UB`/`#RES` — filen är inte en fullständig SIE4-fil enligt §5.16                                                                                               | Redovisningskonsult: jämförelseår och ingående balanser                                                                 |
| C3-rest | Momsrad kunde tappas tyst. I praktiken täckt av C1 + C2; kvar är tydligare felmeddelanden i övriga verifikatvägar                                                                 | — ren hygien, ingen pengarisk                                                                                           |

## Kvar av KOD — inte bokföring

**Personnummer krypteras i vila.** Byggt i
[#255](https://github.com/yasineken2002-sys/eken/pull/255) — **MERGAD och
UTRULLAD 2026-07-27** (squash `0247456`). `Tenant.personalNumber` och
`Customer.personalNumber` låg i
klartext; nu AES-256-GCM (`personalNumberEnc`) + HMAC-SHA256-blind-index
(`personalNumberHash`) via `PersonalNumberService`, som delegerar varje operation
till befintliga `SigningCryptoService` — samma mönster och samma nycklar som
signeringsbevisen (`SignatureEvidence`). Ingen ny kryptografi; blind-indexet
delar pepper med flit, så en BankID-identitet kan jämföras mot hyresgästens hash
utan att någon rad dekrypteras.

### Produktions-backfillen — körd och verifierad 2026-07-27

Backfillen kördes i deploy-vägen (`migrate-and-start.sh`, mellan `migrate deploy`
och appstart). Att appen startade är i sig beviset att den lyckades: `set -eu`
stoppar containern om backfillen felar.

|                                            | före                     | efter      |
| ------------------------------------------ | ------------------------ | ---------- |
| Klartext-personnummer                      | 1 (Tenant), 0 (Customer) | **0**      |
| Krypterade rader                           | 0                        | **1**      |
| `personalNumberEnc` / `personalNumberHash` | kolumnerna fanns inte    | båda satta |

Raden verifierades genom att blind-indexet av originalet fångades **före** mergen
och jämfördes mot ett omräknat index från det dekrypterade värdet efteråt:
dekryptering OK med verifierad GCM-tagg, 12 siffror, index matchar både databasens
`personalNumberHash` och det förfångade värdet. Det senare är det som bevisar att
raden bär _samma_ nummer som förut och inte bara ett välformat. `/v1/health` grön.

Två uppföljningar:

1. **`DROP COLUMN "personalNumber"` är byggd men MEDVETET PARKERAD** —
   [#256](https://github.com/yasineken2002-sys/eken/pull/256), öppen och verifierad.
   #255 var expand-fasen: migrationen lägger bara till kolumner. Klartextkolumnen
   finns kvar i DB men heter `personalNumberLegacy` i Prisma
   (`@map("personalNumber")`), så varje kvarvarande användning är ett
   kompileringsfel.

   **Varför den inte mergas direkt** (beslut 2026-07-27): den tömda kolumnen är
   **rollback-nätet**. Så länge den finns kvar går krypteringen att backa utan att
   data är förlorad; `DROP COLUMN` är oåterkalleligt och tar bort den möjligheten.
   Prod ska därför köra med krypteringen aktiv i några dagar först, och contract-fasen
   mergas när den är bevisad i verklig drift. Det som saknas är drifttid — inte kod,
   inte verifiering.

2. **`ContractImportRow` lagrar fortfarande personnummer i klartext.**
   `originalScanData` / `reviewedData` / `confirmedData` är `Json`-kolumner och
   kontraktsskannern extraherar `personalNumber` dit. Det är en tredje
   klartextlagring, utanför #255:s scope. Att kryptera fritt formade JSON-blobbar är
   ett annat jobb än två kolumner — **flaggat, egen PR**.

### ⚠️ Nycklarna: säkerhetskopiera, rotera aldrig lättvindigt

`SIGNING_PII_KEY` (64 hex-tecken / 32 byte) och `SIGNING_PII_PEPPER` (≥16 tecken)
ligger sedan #255 i `CRITICAL` i `env.validation.ts` — **appen vägrar starta i
produktion utan dem**. Satta i Railway 2026-07-27, och sedan backfillen samma dag
är produktionsdata beroende av dem. Läs detta innan någon rör dem:

- **Förlorad `SIGNING_PII_KEY` = alla personnummer är permanent oläsbara.** Det
  finns ingen återställningsväg: AES-256-GCM utan nyckeln är inte knäckbart, och
  klartexten är borta efter backfillen. Samma sak för en förlorad
  `SIGNING_PII_PEPPER`: alla blind-index blir omatchbara, vilket bryter
  signeringens identitetsbindning och INV-B-grinden i kravtrappan.
- **Rotation kräver omskrivning av all data.** Byte av nyckeln kräver att varje
  `personalNumberEnc` dekrypteras med den gamla och krypteras om med den nya; byte
  av peppern kräver att varje `personalNumberHash` beräknas om — och hasharna kan
  bara räknas om från dekrypterad klartext, alltså behövs den gamla nyckeln även
  vid ren pepper-rotation. Ett "rotera secrets"-svep som byter dessa två utan
  migreringsskript förstör datan tyst.
- **Vägen finns nu: `pnpm --filter @eken/api pii:rotate` (#459).** Två oberoende
  lägen, ett i taget — `--mode=pepper` (räknar om blind-indexen) och `--mode=key`
  (krypterar om chiffertexten). Kör **alltid `--dry-run` först**. Verktyget är
  idempotent utan markörkolumn (rotationsstatus läses ur datan), avbryter HELA
  körningen på en rad det inte kan klassificera, och skriver ingen rad vars
  klartext det inte först läst tillbaka identiskt.

  Två saker uppräkningen ovan missar, och som verktyget täcker:
  **nyckelrotationen rör fem kolumner, inte tre** — `SignatureEvidence`s
  `signaturePayload` och `certificate` krypteras med samma nyckel och blir
  permanent oläsbara om de hoppas över. Och **peppar-rotationen kräver att inga
  signeringsbegäranden är i luften**: `SigningRequest.requiredRoles` bär ett fryst
  blind-index som inte kan räknas om utan att flytta identitetsbindningen.
  Verktyget vägrar starta i det läget.

- **Säkerhetskopiera dem utanför Railway** (lösenordshanterare eller motsvarande),
  åtskilt från databasbackuperna — en backup som ligger bredvid nyckeln skyddar
  ingenting. Nycklarna ingår inte i `pg_dump`-backupen och återskapas inte av en
  restore.

## Affärsregler — implementerade, väntar konsultens signatur

Beslutade av användaren under arbetet och kodade därefter. Ingen är verifierad
mot skatte-/redovisningsregler:

- **Överbetalning avvisas** på båda betalvägarna (bankmatchning och `/pay`)
- **1 kr tolerans** för "full reglering", speglad från hyresavier — flaggad i kod
- **Momskontomappning** `{ 25: 2611, 12: 2621, 6: 2631 }` (`accounting.service.ts`)
  — BAS-konventionen "utgående moms på försäljning inom Sverige" per sats.
  Alternativet vore samlingskontona 2610/2620/2630
- **Delbetalning påverkar inte momsen** — den bokförs i sin helhet vid
  faktureringen; betalningen rör bara 1930/1510. Matchar hyresavins modell

## INFRA-TODO (användaren)

**`Tests` är inte en required status check.** `main` är `protected: false` utan
rulesets (verifierat via API). Jobbet kör och rapporterar på varje PR — men
**blockerar ingen merge**. Tills det ligger bland required checks i GitHubs
branch protection är varje merge manuellt grindad.

**Konto-tak för AI-kostnad saknas.** `ORG_DAILY_LIMIT_SEK` (200) och
`USER_DAILY_LIMIT_SEK` (50) mäter per tenant. Anthropic-nyckeln är en enda
konto-resurs, så en kostnad som sprids över många orgar kan strukturellt aldrig
lösa ut något tak. Se **S-D** i `launch-readiness-atgardslista.md`.

## Next: assistant behaviour (not yet started)

Nästa spår efter pengalagret. **Ingen kod är skriven, ingen design är beslutad** —
det här är målbilden, inte en plan.

**Mål:** AI:n ska gå från reaktiv fråga-svar-chatt med 56 verktyg till en
**assistent** som lyfter saker själv och tar ägarskap. I stället för att vänta på
att bli tillfrågad ska den säga sådant som _"3 avier förföll idag, jag har
förberett påminnelser — vill du skicka?"_.

**Hård gräns:** bindande verktyg (`ACTION_TOOLS`) kräver fortfarande explicit
mänsklig bekräftelse via `pendingAction` → `/v1/ai/confirm`. Proaktivitet handlar
om att **upptäcka och förbereda**, aldrig om att köra pengar- eller
juridik-påverkande åtgärder av sig själv. Den principen är inte förhandlingsbar —
den är samma som resten av systemet vilar på: maskinen föreslår, människan
bekräftar det bindande.

**Designuppgift först, bygge sedan.** Tre frågor måste besvaras innan en rad kod
skrivs:

1. VAD ska den vara proaktiv om? (vilka signaler är värda att avbryta någon för)
2. HUR proaktiv utan att bli påträngande? (frekvens, kanal, tystnad som default)
3. VAR går bekräftelselinjen? (vad får förberedas oombett, vad kräver ett ja
   innan ens förberedelsen sker)

**Varför nu och inte tidigare:** spåret vilar på det härdade bokförings- och
verktygslagret. En assistent som proaktivt agerar på en huvudbok utan balansgrind,
eller på betalningar som bokförs fel, förstärker bara felen. Därför kommer det
efter pengafixarna — inte före.

**Kräver en egen session.**

## Arbetssätt

- **Användaren håller merge-grinden** på alla PR:er som rör pengar eller
  persondata. Claude Code får merga test- och städ-PR:er.
- **Varje pengafix = egen PR.** Ingen buntning.
- **Testet i CI är beviset.** Ett test som passerar på den trasiga koden bevisar
  ingenting — varje fix verifieras genom att det gamla beteendet återinförs och
  testerna bekräftas falla på det.
- **Skatte- och redovisningsregler gissas aldrig.** Där rätt beteende beror på
  svensk regel flaggas det för konsult i stället för att den tekniskt renaste
  tolkningen väljs.
