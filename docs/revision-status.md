# Revisionslistan — mätt status

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

| Post (sakfrågan)                                                                      | Status           | Belägg (PR + fil:rad)                                                                                                                                                                                                                                                                                                                                                                         | Vad som återstår                                                                                                                                                                                                                                                                                                                                              | Storlek                  | SENAST MÄTT            |
| ------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------- |
| **OCR-tilldelningens unikhet och kapacitet** (H1)                                     | LÖST             | #487 (prefixhink per org) + #553 (`prisma/schema.prisma:1092`, `:1433` — `@@unique([organizationId, ocrNumber])`)                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                                                                             | —                        | 2026-08-22 · `f3f47dc` |
| **Transaktionssvält under samtidighet i bankavstämningen** (H2)                       | LÖST             | #109 (`FOR UPDATE` i alla fem skrivvägar, 2026-06-08); deterministisk låsordning `apps/api/src/reconciliation/reconciliation.service.ts:2019-2024`; #544 (`PAYMENT_TX_LIMITS` på alla fyra `$transaction`); CI-vakt `apps/api/scripts/check-transaction-limits.mjs`                                                                                                                           | — (se separat rad om vad som INTE mättes)                                                                                                                                                                                                                                                                                                                     | —                        | 2026-08-22 · `f3f47dc` |
| **Klumpbetalning fördelas inte över flera avier** (H3, serietillhörighet overifierad) | LÖST             | #490 — vattenfallet, `apps/api/src/reconciliation/reconciliation.service.ts:1966` (`applyWaterfallToRentNotices`), anropas `:909`                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                                                                             | —                        | 2026-08-22 · `f3f47dc` |
| **Manuell överbetalning på avi-vägen ger negativ kundfordran** (H4)                   | LÖST             | #483 — `apps/api/src/avisering/avisering.service.ts:1753` (`assertPaymentWithinDebt` innanför radlåset, mot `ocrOutstanding` FÖRE betalningen). Delad regel med fakturavägen `apps/api/src/invoices/invoices.service.ts:1149` — en regel, ett ställe                                                                                                                                          | —                                                                                                                                                                                                                                                                                                                                                             | —                        | 2026-08-22 · `f3f47dc` |
| **Ingen kreditfaktura** (H5)                                                          | DELVIS           | #528 + #529 (obetald faktura), #536 (obetald avi). `apps/api/src/invoices/credit-note.service.ts`                                                                                                                                                                                                                                                                                             | En **betald** faktura kan inte krediteras — grinden `credit-note.service.ts:83-89` nyckar på FAKTISKA allokeringar. Kräver ett återbetalningsflöde: utbetalning över 1930, momsrättelse, och ställningstagande till rättelseregeln (som är OSÄKER, se `docs/legal/`)                                                                                          | medel–stor               | 2026-08-22 · `f3f47dc` |
| **Cronjobb saknar generell ledarval/låsning** (H6)                                    | DELVIS           | #499 — `apps/api/src/common/redis/lock.service.ts` (äkta cross-replica: `SET NX EX` + Lua-release), fyra jobb låsta, påkopplingen bevakad av `apps/api/src/common/redis/cron-lock-coverage.spec.ts`                                                                                                                                                                                           | Ingen GENERELL ledarval. Uppräkningen är medveten: övriga cron-jobb skyddas av DB-invarianter, t.ex. `@@unique([leaseId, year, month, type])` på `RentNotice`. Det som återstår är ett ställningstagande, inte kod — såvida inte ett femte jobb med icke-idempotent yttre biverkan tillkommer                                                                 | liten                    | 2026-08-22 · `f3f47dc` |
| **Faktura-delbetalning auto-matchas inte** (M1)                                       | LÖST             | #559 — `apps/api/src/reconciliation/partial-match-identity.ts` (regeln + registren), vakt `apps/api/scripts/check-partial-match-identity.mjs`, spec `apps/api/src/reconciliation/invoice-partial-auto-match.spec.ts`. Delbetalning tillåts nu på de grenar där identiteten är fastställd (`Invoice.ocrNumber`, `invoiceNumber`) och FÖRBJUDS på fritext (`Invoice.reference`, #554) och fuzzy | **En egen defekt som INTE stod i listan** hittades i samma kod: förkontrollen mätte mot `invoice.total` i stället för mot restskulden, och blockerade därför även SLUTBETALNING av en PARTIAL-faktura (10 000 − 6 000 = 4 000 > 1 kr). Uppslaget hämtade uttryckligen status `PARTIAL` och kunde sedan aldrig reglera den. Åtgärdad i samma PR, eget testfall | —                        | 2026-08-22 · `4da9447` |
| **En explicit men olöst OCR beloppsgissas** (M2)                                      | LÖST             | #492 (tidig retur före fuzzy) + #556 (proveniens — `apps/api/src/reconciliation/ocr-proveniens.ts`, vakt `apps/api/scripts/check-ocr-provenance.mjs`)                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                                                                             | —                        | 2026-08-22 · `f3f47dc` |
| **Avinummer-race / P2002 svaldes som idempotens** (M3)                                | LÖST             | #484 (aktiveringsvägen) + #485 (`apps/api/src/avisering/rent-notice-number.ts:76` — atomär upsert mot `RentNoticeNumberSequence` i stället för max+1)                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                                                                             | —                        | 2026-08-22 · `f3f47dc` |
| **Inget komplett årsbokslutsflöde** (M4)                                              | DELVIS           | Månadsstängning finns: `apps/api/src/accounting/accounting-period.service.ts:430` (`closePeriod`), återöppning som händelselogg (`AccountingPeriodEvent`). SIE4 med `#IB`/`#UB`/`#RES` (#549, `accounting.service.ts:1033`). Konto 2099 finns i `bas-chart.ts:141`                                                                                                                            | Årsavslut saknas HELT — noll träffar på resultatdisposition, ingående balanser till nästa år, eller årsavslutsverifikat. Kräver redovisningskonsult för K2/K3-valet innan kod                                                                                                                                                                                 | stor                     | 2026-08-22 · `f3f47dc` |
| **Ingen leverantörsreskontra** (M5)                                                   | FINNS            | Ingen `Supplier`/`Vendor`/`Purchase`-modell i `apps/api/prisma/schema.prisma` — greppet ger bara ordträffar i kommentarer                                                                                                                                                                                                                                                                     | Hela domänen: modell, kontering mot 2440, betalningsflöde, attestkedja, momsavdrag                                                                                                                                                                                                                                                                            | stor                     | 2026-08-22 · `f3f47dc` |
| **autoMatchAll sväljer fel tyst** (L1)                                                | LÖST             | #480 — `apps/api/src/reconciliation/reconciliation.service.ts:1821` (`autoMatchAll`): `matched`/`unmatched`/`failed` räknas var för sig, invarianten `matched + unmatched + failed === candidates.length` håller; fel loggas per transaktion + summeringsrad; `failed` och `skippedUnresolvedOcr` går hela vägen till `apps/web/src/features/reconciliation/ReconciliationPage.tsx:721-726`   | —                                                                                                                                                                                                                                                                                                                                                             | —                        | 2026-08-22 · `f3f47dc` |
| **PSD2/e-signering är stub/mock** (L2)                                                | FINNS (medvetet) | Bara `stub-`/`mock-`-providers i `apps/api/src/psd2/providers/` och `apps/api/src/signing/providers/`. Inert bakom `SIGNING_ENABLED`; flaggan känns till på EXAKT ett ställe (`apps/api/src/signing/signing.module.ts`)                                                                                                                                                                       | Blockerad på AVTAL och NYCKLAR, inte på kod. Ingen kodinsats meningsfull förrän leverantörsavtal finns                                                                                                                                                                                                                                                        | stor (extern blockerare) | 2026-08-22 · `f3f47dc` |

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
main = f3f47dc0214b447b6e64de5cfd16da852b4d8569
      (f3f47dc — "en siffra ur prosa är inte en avsiktshandling", #556)
```
