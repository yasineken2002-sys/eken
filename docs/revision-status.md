# Revisionslistan — mätt status

## FAS 0 (FUNDAMENTET) ÄR KLAR PÅ KODSIDAN — OCH DET ÄR INTE SAMMA SAK SOM KLART

Nio PR:er stängde fundamentet i koden (se tabellen). **Fyra saker återstår, och
ingen av dem är en kodrad.** Läs inte "fas 0 klar" som "allt klart".

| Vad som återstår                              | Varför det inte är löst av koden                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BACKUPEN — ingen backup har tagits**        | Koden är klar och jobbet är låst (#564). Men bucket, scopad R2-token, Railway-variabler och en riktig ÅTERSTÄLLNINGSÖVNING saknas. En backup som aldrig återställts är en förhoppning, inte en backup.                                                                                                  |
| **H5:s betalda väg**                          | Kreditering av en BETALD faktura väntar på kontobeslutet i #535. Kräver ett återbetalningsflöde (1930-utbetalning + momsrättelse), inte bara kod.                                                                                                                                                       |
| **H2 under verklig samtidighet**              | Verifierad som MEKANISM — radlås, deterministisk låsordning, transaktionsgränser finns och är påkopplade. Inte mätt under last. Krävs: N samtidiga matchare mot samma hyresgästs avier mot riktig Postgres, P2028-frekvensen mätt, plus en negativkontroll som visar att riggen KAN producera timeouts. |
| **H6:s skydd är delvis en deployinställning** | Prod kör `numReplicas: null` (= 1). Låsen och DB-invarianterna finns, men med en instans gör låsen ingenting — skyddet aktiveras först vid uppskalning, och det är en inställning, inte en kodinvariant.                                                                                                |

## REGELN

**En rad här får aldrig ligga till grund för arbete utan att först mätas om mot
aktuell `main`.** Raden är ett SPÅR, inte ett faktum. Den säger var någon en
gång hittade något — inte att det finns kvar.

Kolumnen **SENAST MÄTT** bär både ett datum och en **commit-sha**. Sha:n är
poängen. Ett datum säger när någon skrev raden; en sha säger vilket TILLSTÅND
raden faktiskt beskriver. Är sha:n inte längre en förfader till `main` — eller
ligger den många merger bakom — är raden ett historiskt påstående, och ska
behandlas som ett uppslag att verifiera, inte som en arbetsorder.

Mät om så här innan du bygger:

```bash
git merge-base --is-ancestor <sha-i-raden> HEAD && echo "raden mätt mot en förfader"
git log --oneline <sha-i-raden>..HEAD -- <de filer raden pekar på>
```

Har något landat i de filerna sedan dess: **mät om posten från koden** innan du
rör den. Visar mätningen att den är löst — skriv det, uppdatera raden, och bygg
inte om den.

## VARFÖR REGELN FINNS

Den ursprungliga listan skrevs **före 2026-08-16** och uppdaterades aldrig efter
en batch om **sexton PR:er samma dag**. Sju av listans poster löstes i den
batchen — flera av PR-titlarna namnger till och med posten:

```
2026-08-16   #480 (L1)  #483 (H4)  #484 (M3)  #487 (H1)
             #490 (H3)  #492 (M2)  #499 (H6)   + nio infra-PR:er
```

Det är alltså inte fyra slumpvis inaktuella rader. Det är EN batch som listan
aldrig fick veta om.

Listan var dessutom **delvis historik redan när den författades**: H2:s
radlåsning (`FOR UPDATE` i bankavstämningen, **#109**) landade **2026-06-08**,
drygt två månader innan listan kan ha skrivits.

Kostnaden var fyra halva sessioner, spenderade på att upptäcka en post i taget
att arbetet redan var gjort — med en stående risk att någon "lagar" fungerande
kod.

## NUMRERINGEN ÄR INTE EN IDENTIFIERARE

**Referera till sakfrågan, aldrig till bokstaven.** Minst tre H1–H5-serier är i
omlopp samtidigt i det här repot:

| Serie                     | Var                                   | Exempel                                                        |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| SIE4-auditen (2026-07-27) | `docs/accounting-fix-status.md`       | H2 = `#FORMAT PC8` men UTF-8 skrevs                            |
| OCR-serien                | #553 / #554                           | H1 = OCR-tilldelningens unikhet, H2 = OCR-identitet vs fritext |
| Den här listan            | (var oversionerad före den här filen) | H2 = transaktionssvält under samtidighet                       |

Samma bokstav betyder olika saker i olika omgångar. En hänvisning till "H2" utan
sakfråga är därför tvetydig, och har redan lett fel.

> **H3 nedan** stod inte i den överlämnade uppräkningen men namnges i #490:s
> titel ("H3 PR B"). Vilken serie den hör till är **overifierat** — den står med
> för fullständighetens skull, inte som ett påstående om numreringen.

---

## Posterna

| Post (sakfrågan)                                                                      | Status                        | Belägg (PR + squash-sha + fil:rad)                                                                                                                                                                                                                                                  | Vad som återstår                                                                                                                                                          | Storlek                  | SENAST MÄTT            |
| ------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------- |
| **OCR-tilldelningens unikhet och kapacitet** (H1)                                     | LÖST                          | #487 (prefixhink per org) + **#553** (`0898531`) — `@@unique([organizationId, ocrNumber])` i `prisma/schema.prisma:1092`, `:1433`                                                                                                                                                   | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **Fritextreferensen kunde kapa en OCR-matchning** (H2, OCR-serien)                    | LÖST                          | **#554** (`b42f2dc`) — identitetsgrinden i `apps/api/src/reconciliation/ocr-identity.ts`; vakt `check-ocr-lookup-fields.mjs`                                                                                                                                                        | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **Transaktionssvält under samtidighet i bankavstämningen** (H2)                       | LÖST (mekanism)               | #109 (`FOR UPDATE` i alla fem skrivvägar) · deterministisk låsordning `reconciliation.service.ts:2019-2024` · #544 (`PAYMENT_TX_LIMITS`) · vakt `check-transaction-limits.mjs`                                                                                                      | Ej mätt under LAST — se raden i _Uttryckliga icke-mätningar_                                                                                                              | —                        | 2026-08-22 · `7d22657` |
| **Klumpbetalning fördelas inte över flera avier** (H3, serietillhörighet overifierad) | LÖST                          | #490 — vattenfallet, `reconciliation.service.ts:1966`                                                                                                                                                                                                                               | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **Manuell överbetalning på avi-vägen ger negativ kundfordran** (H4)                   | LÖST                          | #483 — `avisering.service.ts:1753` `assertPaymentWithinDebt`, delad regel med `invoices.service.ts:1149`                                                                                                                                                                            | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **Ingen kreditfaktura** (H5)                                                          | DELVIS                        | #528 + #529 (obetald faktura), #536 (obetald avi) — `apps/api/src/invoices/credit-note.service.ts`                                                                                                                                                                                  | En **betald** faktura kan inte krediteras (`credit-note.service.ts:83-89` grindar på faktiska allokeringar). Väntar på **#535:s kontobeslut**; kräver återbetalningsflöde | medel–stor               | 2026-08-22 · `7d22657` |
| **Cronjobb saknar generell ledarval/låsning** (H6)                                    | LÖST (25 jobb klassificerade) | **#564** (`85aa0d7`) — 7 låsta (A) via `LockService`, 18 med NAMNGIVEN invariant (B), 0 oskyddade; vakt `check-cron-classification.mjs`                                                                                                                                             | Skyddet mot samtidighet är delvis en **deployinställning** (`numReplicas: null`), inte en kodinvariant                                                                    | liten                    | 2026-08-22 · `7d22657` |
| **Faktura-delbetalning auto-matchas inte** (M1)                                       | LÖST                          | **#559** (`4da9447`) — `apps/api/src/reconciliation/partial-match-identity.ts`; vakt `check-partial-match-identity.mjs`. Fann också att förkontrollen mätte mot `invoice.total` och därför blockerade SLUTBETALNING av en PARTIAL-faktura — en egen defekt som aldrig stod i listan | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **En explicit men olöst OCR beloppsgissas** (M2)                                      | LÖST                          | #492 (tidig retur) + **#556** (`f3f47dc`) — proveniens i `ocr-proveniens.ts`; vakt `check-ocr-provenance.mjs`                                                                                                                                                                       | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **Avinummer-race / P2002 svaldes som idempotens** (M3)                                | LÖST                          | #484 + #485 — `rent-notice-number.ts:76`, atomär upsert mot `RentNoticeNumberSequence`                                                                                                                                                                                              | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **Inget komplett årsbokslutsflöde** (M4)                                              | DELVIS                        | Månadsstängning finns (`accounting-period.service.ts:430`), SIE4 med `#IB`/`#UB`/`#RES` (#549), konto 2099 i `bas-chart.ts:141`                                                                                                                                                     | Årsavslut saknas HELT — resultatdisposition, ingående balanser. Kräver redovisningskonsult för K2/K3-valet                                                                | stor                     | 2026-08-22 · `7d22657` |
| **Ingen leverantörsreskontra** (M5)                                                   | FINNS                         | Ingen `Supplier`/`Vendor`/`Purchase`-modell i `prisma/schema.prisma`                                                                                                                                                                                                                | Hela domänen: modell, kontering mot 2440, betalningsflöde, attestkedja, momsavdrag                                                                                        | stor                     | 2026-08-22 · `7d22657` |
| **autoMatchAll sväljer fel tyst** (L1)                                                | LÖST                          | #480 + **#556** (`f3f47dc`) — `reconciliation.service.ts:1821`; `failed` och `skippedUnresolvedOcr` visas i `ReconciliationPage.tsx`                                                                                                                                                | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **PSD2/e-signering är stub/mock** (L2)                                                | FINNS (medvetet)              | Bara `stub-`/`mock-`-providers i `psd2/providers/` och `signing/providers/`; inert bakom `SIGNING_ENABLED`                                                                                                                                                                          | Blockerad på AVTAL och NYCKLAR, inte på kod                                                                                                                               | stor (extern blockerare) | 2026-08-22 · `7d22657` |
| **AI-loopens tysta avbrott** (fas 0, agentiskt fundament)                             | LÖST                          | **#561** (`4fcf6bd`) — turtaket är ETT värde i `tool-iteration-cap.ts`, synligt när det nås, mätbart via `AiUsageLog.capReached`; vakt `check-tool-iteration-cap.mjs`                                                                                                               | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **AiToolExecution vet inte vad den orsakade** (fas 0)                                 | LÖST                          | **#562** (`4435f7f`) — `AiToolEffect` via Prisma-extension `ai-effect-extension.ts`; vakt `check-ai-tool-effects.mjs`                                                                                                                                                               | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **Bindande verktyg kan utföras utan bekräftelse** (fas 0)                             | LÖST                          | **#563** (`f7823b9`) — `assertActionToolAuthorized` central i BÅDA exekverarna; vakt `check-action-tool-authorization.mjs`                                                                                                                                                          | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |
| **Tyst hoppade tester i CI** (fas 0)                                                  | LÖST                          | **#565** (`7d22657`) — hård nolla på `numPendingTests + numTodoTests`, fail-closed; vakt `check-skip-preconditions.mjs`. Före #564 hoppades 13 tester TYST och CI var grön                                                                                                          | —                                                                                                                                                                         | —                        | 2026-08-22 · `7d22657` |

## Uttryckliga icke-mätningar

Två saker nedan är INTE mätta. De står som egna rader och inte som fotnoter, av
samma skäl som sha-kolumnen finns: det som inte mätts ska synas lika tydligt som
det som mätts, annars läses en tabell som heltäckande när den inte är det.

| Vad som inte mättes                                                                                                                                                      | Vad som DÄRFÖR inte får påstås                                                                                | Vad som skulle krävas                                                                                                                                                                                                                                                                                                       | SENAST MÄTT            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **H2 är verifierad som MEKANISM, inte under verklig samtidighet.** Jag verifierade att radlås, deterministisk låsordning och transaktionsgränser finns OCH är påkopplade | Att svält faktiskt uteblir under last. Mekanismernas närvaro är ett argument, inte en mätning                 | **N samtidiga matchare mot SAMMA hyresgästs avier, mot en riktig Postgres** (mallen finns i `docs/runbooks/`), med **P2028-frekvensen mätt** — och en negativkontroll som visar riggen kan producera timeouts när låsordningen bryts med flit. Utan den kontrollen är noll timeouts lika förenligt med "riggen mäter inget" | 2026-08-22 · `f3f47dc` |
| **H6:s replikantal är en DEPLOYINSTÄLLNING, inte en kodinvariant.** Railway svarar `numReplicas: null` (= default 1)                                                     | Att risken är borta. Den är LATENT: med en replik kan ingen dubbelkörning inträffa, oavsett om låsen fungerar | Läs om vid varje skalningsbeslut: `railway api 'query { service(id: "…") { serviceInstances { edges { node { numReplicas } } } } }'`. **Skalas tjänsten över 1 aktiveras risken**, och då är de fyra låsen plus DB-invarianterna det enda som håller — inte tur                                                             | 2026-08-22 · `f3f47dc` |

---

**Mätningen ovan gjordes i sin helhet mot:**

```
main = 7d226576333d7a641afe39b265b64657d8e7fbdc
      (7d22657 — "inga tysta överhoppningar", #565)
```

Varje rads SENAST MÄTT bär den sha den mättes mot, inte den commit som skrev
raden. Ett datum säger när någon skrev; en sha säger vilket tillstånd som
beskrivs.
