# Samlad granskning av Codex-arbetet — 2026-09-10

**Mätpunkt:** `origin/main` = `27a720d4`. Alla grenar lästa read-only via `git show`/`git diff`
mot `origin/*`. Inga checkouts, inga produktionsändringar, ingen merge.
**CI-status nedan är hämtad 2026-09-10 via GitHub check-runs API, per PR:ens aktuella head-sha.**

> Läs varje rad här som ett **spår**, inte ett faktum — samma regel som
> `docs/revision-status.md`. Mät om mot koden innan du bygger på en post.

---

## 0. Vad granskningen omfattar — och vad den INTE omfattar

**Omfattar:** de 24 öppna PR:erna i `yasineken2002-sys/eken`, samtliga i draft-läge.

**Omfattar INTE, och det är en lucka du ska känna till:**

1. **Uppdragsfilen `Till-Claude-samlad-granskning-2026-09-10.md`** ligger i
   `/workspaces/eken-fran-mac-20260909/` på din maskin. Den finns inte i mitt
   fjärrklonade träd och går inte att nå härifrån. Granskningsområdena nedan är
   därför satta av mig, inte lästa ur din fil. Om filen innehåller frågor jag inte
   täckt är de obesvarade.
2. **Det lokala bankbygget utan PR.** Du har nämnt arbete som bara finns lokalt.
   Det som inte är pushat kan jag per definition inte läsa. Allt nedan gäller de
   24 PR:erna på GitHub.

---

## 1. PR-karta och CI-status

Alla 24 PR:er är **draft**. Samtliga har `CI passed = success`.

### Fristående (5 st) — utgår från `main`

| PR | Titel (kort) | Checkar | CI passed | Merge mot main |
|----|--------------|---------|-----------|----------------|
| [#876](https://github.com/yasineken2002-sys/eken/pull/876) | Rätta dubbla felanmälansnotiser, bevara chattutkast | 61 | ✅ | REN |
| [#857](https://github.com/yasineken2002-sys/eken/pull/857) | Köa betalningsförslag till torrläge | 61 | ✅ | REN |
| [#855](https://github.com/yasineken2002-sys/eken/pull/855) | Sista sex webbkontrakten: 6 → 0 | 61 | ✅ | **2 KONFLIKTER** (se nedan) |
| [#837](https://github.com/yasineken2002-sys/eken/pull/837) | Juridisk text: hantverkare som mottagarkategori | 60 | ✅ | REN mot main, **krockar med #752** |
| [#752](https://github.com/yasineken2002-sys/eken/pull/752) | Juridisk text: underbiträdesregistret | 52 | ✅ | REN mot main, **krockar med #837** |

**#855:s konflikter** (mätt med `git merge-tree --write-tree`):
`apps/api/src/ai/dto/chat.dto.ts` och
`apps/api/src/maintenance/dto/update-maintenance-ticket.dto.ts`.
Båda är DTO-filer där main nu bär `@StrictString`/`@StrictBoolean` från #850 och
grenen bär `implements`+`SammaNycklar`. **Lösningen är att behålla båda sidor** —
samma mönster som i de sju PR:er som redan mergats.

**Om antalet checkar:** #752 kördes mot en `main` som hade **52** jobb i
`ci-passed`. I dag är talet 61. Ett grönt `CI passed` på #752 betyder alltså att
nio vakter som finns i dag **aldrig körde** mot den grenen. Samma sak, mildare,
för #837 (60). Det är inget fel i PR:en — men det är inte samma bevis som de
andra 22 bär, och det ska inte läsas som att det är det.

### Agent 2-stapeln (9 st) — betalningsmatchning

`#856` (bas `main`) → `#868` → `#869` → `#870` → `#871` → `#872` → `#873` → `#874` → `#875`

Alla 9: 61 checkar, `CI passed = success`. Toppgrenen
`codex/agent2-bankhandelse-forslag` mergar **RENT** mot main.

### Agent 3-stapeln (10 st) — granskning av förbrukningsavläsningar

`#858` (bas `main`) → `#859` → `#860` → `#861` → `#862` → `#863` → `#864` → `#865` → `#866` → `#867`

Alla 10: 61 checkar, `CI passed = success`. Toppgrenen
`codex/agent3-svarsgrind` mergar **RENT** mot main.

**Varning om staplarna:** `--delete-branch` vid merge av en PR som är **bas** för
nästa stänger den beroende PR:en, oåterkalleligt (#447-precedenset i CLAUDE.md).
Merga nedifrån och upp, utan `--delete-branch`.

---

## 2. Vilka agenter som kördes och vad var och en kom fram till

Fem specialistagenter, fem åtskilda områden, oberoende bedömning först.
**Alla fem kördes och alla fem levererade.**

| Agent | Område | Huvudslutsats |
|-------|--------|---------------|
| **ai-architect** | modellanvändning, prompt, injektion, mätning i agentplattformen | Stapelns enda produktionsändring utanför `eval/` är **22 rader** i `payment-shadow.service.ts`. Tre uppgifter som är ren aritmetik eller nyckeluppslagning ligger i prompten i stället för i kod. Den **återtagna** regeln i `payment-candidates.ts` förbättrade varje mätt axel. `experiment-betalningsgrind.ts` är det starkaste i hela arbetet. |
| **bokforings-expert** | pengaflöden i agent 2 och 3 | **Noll** produktionsändringar i bokförings- eller betalningsallokeringskoden i hela agent 2-stapeln. `createNumberedEntry`/`journalEntry.create`: noll träffar i stapelns `.ts`-diff. "Tillgodo-livscykel" väljer **inget BAS-konto** och anropar ingen produktionsfunktion. |
| **security-auditor** | behörighet, tenant-isolering, personuppgifter, ny DB-yta | 0 CRITICAL, 0 HIGH, 1 MEDIUM, 1 LOW. Schemaändringen korrekt: alla fyra kolumner i det unika villkoret är NOT NULL, append-only-trigger bevisad mot riktig Postgres. 4 nya endpoints, 4/4 rollgrindade och org-avgränsade. 0 personnummer/e-post/kontonummer i 78 432 rader committad testdata. |
| **hyresjurist** | förbrukningsdebitering + de två juridiska texterna | **En flaggad, obedömd avläsning kan bli en skarp fordran på hyresgästens avi.** Ingen rättelseväg finns för en felaktig avläsning eller debitering. #837:s text lovar hyresgästen portalinsyn som koden inte levererar. #752 och #837 bumpar **båda** privacy 1.1 → 1.2. |
| **code-reviewer** | de fristående PR:erna + provtäckning + sammanhang | #855, #857, #876 alla mergbara (#876 med ett SHOULD-FIX). Av 57 kodfiler i agent 2-stapeln har **48 noll provtäckning** — varav 1 är skarp produktionskod. 78 432 rader JSON i 82 filer är till största delen labbartefakter, inte bevis. |

### Där agenterna var oeniga

**En enda sakoenighet, och den är viktig.** ai-architect läser
`apps/api/src/ai/shadow/payment/payment-fields.ts:61` —
`export type Beloppsutfall = 'FULL' | 'DEL'` — som en materiell defekt:
två värden för en trevärd fråga. bokforings-expert läser samma kod som ofarlig,
med motiveringen att inget `number`-belopp från förslagslagret vandrar in i en
bokförande väg (verifierat: `match_bank_transaction` i
`tool-executor.service.ts:4053` tar **inget** beloppsargument).

**Båda har rätt om olika saker, och min egen mätning avgör vilken fråga som
gäller:** typen skadar ingen bokföring i dag, men den gör det **omöjligt att
mäta** överbetalning, och den begränsningen syns i korpusen (se §4.1).

---

## 3. Vad har vi byggt — enkelt

**Agent 2 (9 PR:er): ett mätinstrument för betalningsmatchning, inte en funktion.**
Deterministiska kandidatregler väljer ut högst fem tänkbara avier/fakturor för en
bankrad, Haiku 4.5 väljer en eller avstår, och förslaget landar i `AiAssignment`
där en människa beslutar. Hela stapeln är **mätning av hur bra det väljer** — 82
JSON-korpusfiler, facit, utvärderingsskript, rapporter. Den skarpa
produktionsändringen är 22 rader prompttext.

**Agent 3 (10 PR:er): ett läsande granskningslager för IMD-avläsningar.** En
regelmotor flaggar avvikande förbrukning (trend: 3 perioder, faktor 3), en
människa bedömer, bedömningen sparas append-only med historik, en daglig cron
07:15 skickar en notis om kön växer. Fyra nya endpoints, en ny tabell, två
migrationer.

**Fristående:** #855 stänger kontraktsskulden (6 → 0), #857 köar
betalningsförslag till torrläget, #876 rättar en dubbelnotis på felanmälan, #752
och #837 är juridiska textändringar.

---

## 4. Vad fungerar enligt verifierade tester

### Bevisat, med prov som kan falla

| Vad | Bevis (fil:rad) |
|-----|-----------------|
| Ny tabell `MeterReadingReview` är append-only **i databasen** | `apps/api/prisma/migrations/20260908203000_meter_reading_review/migration.sql` (`CREATE TRIGGER append_only_meter_reading_review`) + en riktig `UPDATE` avvisas mot riktig Postgres i `apps/api/src/consumption/reading-review-decisions.db.spec.ts` |
| Unikt villkor utan nullbar kolumn | `@@unique([organizationId, readingId, findingCode, revision])` — alla fyra NOT NULL (`apps/api/prisma/schema.prisma`, ca `:7065–7094`) |
| Korsorganisatorisk koppling omöjlig i DB | sammansatt FK `(organizationId, readingId) → MeterReading(organizationId, id)`, stöttad av nytt index `schema.prisma:6211` |
| 4 nya endpoints rollgrindade | `apps/api/src/common/authz/authz-surface.golden.txt`: 217 → **221** rollgrindade, **oförändrat 175** utan rollgrind |
| Agenten kan inte skriva en bedömning | exakt **en** skrivväg, `apps/api/src/consumption/reading-review.service.ts:47`, nådd bara via `POST /consumption/reading-review/decisions` med roll OWNER/ADMIN/MANAGER **och** en andra rollkontroll inuti transaktionen |
| De två nya AI-verktygen är strikt läsande | `apps/api/src/ai/tools/consumption-review.ts:97-101`, `consumption-follow-up.ts:56-58` (`canAssistantSaveAssessment: false` m.fl.); golden-filens "AI-verktyg som utför handlingar" **oförändrad, 31** |
| Dagliga cron:en debiterar inget | `reading-review-follow-up.service.ts` skriver bara `Notification` + fem tidsstämplar; `expect(consumptionCharge.count()).toBe(0)` i db-specen |
| Decimalgränsen (#867) | `packages/shared/src/utils/reading-rate-comparison.ts` — exakt rationell aritmetik med `bigint`-bråk och korsmultiplikation i stället för flyttalsdivision |
| #876 rättar dubbelnotisen | `apps/api/src/maintenance/maintenance.service.ts:278–296` äger nu notisen ensam; `tenant-maintenance-flow.spec.ts`: `notifySpy` = exakt 1 anrop, 2 mottagarrader, både AI- och manuell väg |
| #857 köar till torrläget utan att kunna felklassificera köfel | `enqueueSafely` kastar aldrig; `payment-dryrun.spec.ts` täcker lyckad väg, köfel, DB-fel, dubblett, avstängd agent, och bevisar att `match_bank_transaction` fortfarande blir `BLOCKED` |
| #855 kör DTO-paritet genom produktionens pipe | `apps/api/src/accounting/dto-contract.spec.ts:1138–` med `VALIDATION_PIPE_OPTIONS`, inte en egen konfiguration; `request-contract.baseline.json`: `total 6 → 0` |
| Inga personuppgifter i testdata | 82 JSON + 18 `.json.gz` genomsökta: **0** personnummer, **0** riktiga e-postadresser, **0** IBAN/bankgiro. Namnen är maskinellt genererade (20 förnamn × 10 efternamn) utan överlapp mot `prisma/seed*.ts` |
| Alla tre växlar av överallt | `schema.prisma:663` `shadowAgentEnabled`, `:682` `shadowPaymentAgentEnabled`, `:704` `agentExecutionEnabled` — alla `@default(false)` |

### Bevisat men med ett förbehåll du ska läsa

**Agent 2:s träffsäkerhet mäts av två riggar som ger olika svar.** Den kurerade
korpusen ger ~97 % och 19/19 recall; den oberoende verklighetslika riggen ger
**65,4 %** och recall **24/28**. Det är inte en motsägelse — det är två olika
frågor (handplockade fall mot genererad trafik). Men **100 %-talet är låst i CI**
(`apps/api/src/ai/shadow/eval/betalningsrapport.spec.ts:90-95`), och ett
inlåst maxvärde är ett prov som bara kan falla nedåt, aldrig bekräfta något.
Läs 65,4 % som siffran som betyder något.

---

## 5. Vad är fortfarande experiment eller ofärdigt

### 5.1 Agent 2-stapeln är nästan helt experiment — tre oberoende mätningar säger samma sak

```
89 filer utanför docs/eval/**, 39 689 tillägg  →  ALLT är eval/, scripts/, docs/
                                                  utom 22 rader i
                                                  payment-shadow.service.ts
noll diff mot accounting.service.ts, rent-notice-credit.service.ts,
           credit-note.service.ts, reconciliation.service.ts,
           tool-executor.service.ts
noll träffar på createNumberedEntry / journalEntry.create / assertPeriodOpen
211 filer, 93 072 tillagda rader totalt · 48 av 57 kodfiler har NOLL provtäckning
```

`#873`, `#874` och `#875` innehåller **noll rader** i `apps/api/src`,
`apps/web/src`, `apps/portal/src`, `packages/shared/src` eller `schema.prisma`.
Allt är Python/SQL mot en nätverkslös engångscontainer (`--network none`) plus
genererad JSON. **Inget av det körs av CI** — `.github/workflows/` är orörd av
hela stapeln. Fyra filer heter `test_*.py` och innehåller riktiga
`unittest`-klasser, men ingen Python-runner finns i `ci.yml`: filnamnen ger en
falsk känsla av täckning.

### 5.2 "Tillgodo-livscykel" (#870/#871) har inte byggt tillgodo

Namnen säger att en tillgodofunktion byggts och verifierats. Mätt:

- `apps/api/scripts/tillgodo_experiment.sql` rad 1: *"EXPERIMENT ONLY… TEST_\* are
  fictitious test roles, never BAS accounts or production tables."*
- Grenens egen inventering (`docs/agent2-overskott-inventering.md`):
  *"Testspecifikationen väljer inget BAS-konto."*
- Produktionskoden på `main`, orörd av stapeln
  (`apps/api/src/avisering/rent-notice-credit.service.ts`,
  `assessRentNoticeCreditability`): *"En kreditering av en betald avi ger ett
  tillgodohavande… **Den hanteringen är inte byggd.**"*

**Mergar du #870/#871 ändras produktionens tillgodohantering inte alls.** Risken
är inte i koden — den skriver ingenting en kund kan nå. Risken är att nästa
granskare eller nästa agent läser det som "tillgodo är löst, bygg vidare".

### 5.3 En produktionsfunktion med beteendelogik och noll prov som CI kör

`apps/api/src/ai/shadow/payment/payment-shadow.service.ts`,
`byggBetalningsprompt()` (`:641–`, anropad från produktionsvägen `:337`).
Tre nya beslutsregler i prompten — returdetektion, namnfragment mot fullständigt
namn, prioritering mellan flera obetalda avier utan referens — har **noll
`.spec.ts`-referenser** i hela stapeln. Enda verifieringen är
`apps/api/scripts/eval-shadow-agent.ts` och `eval-uppdelad-betalning.ts`, som
körs för hand mot en riktig Anthropic-modell och aldrig av `ci-passed`.

### 5.4 78 432 rader JSON i 82 filer är till största delen labbanteckningar

`docs/eval/bankhandelse-forslag/` bär `korning-v2/`, `korning-v3/`, `korning-v4/`
— tre nästan identiska råloggar (593/593/576 rader) av samma experiment, plus
`indata.json`/`indata-v2.json` (1369 rader vardera, nästan dubbletter).
**11 av 82** JSON-filer importeras faktiskt av en `.spec.ts` — de är rimliga
fixturer. De övriga ~71 hör inte i versionshanteringen i den volymen.

### 5.5 Den återtagna regeln — och här rättar jag mig själv

**Jag har tidigare sagt till dig att regeln som togs bort låg i prompten och att
den gjorde saken sämre. Det var fel på båda punkterna.**

Mätt: commit `86bf2473` la regeln
`if (k.utestaende <= 0 || rad.belopp > k.utestaende + TOLERANS_KR) continue`
i **kandidatfiltret** (`payment-candidates.ts`), inte i prompten. Den förbättrade
varje axel som mättes:

| | före | efter |
|---|---|---|
| kombinerat utfall | 35/36 · 36/36 · 35/36 | **36/36 · 36/36 · 36/36** |
| regelarmen ensam | 10/36 | **15/36** |
| modellanrop | 26 | **21** |
| tokens | 49 837 | **40 476** |
| kostnad | 0,078262 USD | **0,063126 USD** |
| kontrollkorpus | 10/12 | 10/12 (oförändrad) |

Den togs sedan bort av `984f3b9d`, och `2defd4b3` **raderade 36/36-mätningen**
ur `docs/eveno-agentplan.md`. Nettodiffen på `payment-candidates.ts` mot main är
**noll rader** — filen gick ut och kom tillbaka (verifierat:
`git diff --stat origin/main..origin/codex/agent2-bankhandelse-forslag --
apps/api/src/ai/shadow/payment/payment-candidates.ts` är tom).

**Ingen av de två revert-commitarna bär ett skäl.** Samtidigt står det
*misslyckade* promptförsöket kvar dokumenterat i
`docs/eveno-agentplan.md:273-277`. Det som vann är borta ur planen; det som
förlorade står kvar. Exakt ett fall vände: **b28** (8 930 = 8 450 hyra + 480
avgift). Överbetalningen var 480 kr och `BRED_TOLERANS_KR = 500`, så modellen föll
20 kr innanför fönstret.

---

## 6. Vilka fel måste rättas, och varför

Ordnade efter vad som gör skada om de inte rättas — inte efter hur stora de ser ut.

### MÅSTE-1 · En obedömd, flaggad avläsning kan bli en skarp fordran på hyresgästen

**Fil:rad:** `apps/api/src/consumption/consumption.service.ts:492-524`
(`confirmCharge`) och `:542-598` (`attachRentNoticeLineCharges`).
**Mätt av mig själv:** en `grep` efter `MeterReadingReview|readingReview` i hela
`consumption.service.ts` på agent 3-stapelns topp ger **noll träffar**, och filen
är **oförändrad** av hela stapeln.

Hela granskningslagret ligger vid sidan av debiteringskedjan.
`recordReading()` skapar en `ConsumptionCharge` i `DRAFT` oavsett vad
regelmotorn skulle säga; `confirmCharge()` flyttar `DRAFT → CONFIRMED` och
bokför en kundfordran (1510) utan att fråga efter någon bedömning; och
avi-genereringens cron plockar **varje** `CONFIRMED` charge och lägger den på
hyresgästens betalbara belopp.

**Varför det måste rättas:** så länge det förhåller sig så är granskningsverktyget
kosmetiskt. Hur bra regelmotorn, den dagliga uppföljningen och assistenten blir
spelar ingen roll — en avläsning som är uppenbart fel kan ändå bli en fordran,
eftersom ingen kod frågar efter en bedömning innan pengarna rör sig.

**Beslutet är ditt, inte tekniskt:** ska en `ConsumptionCharge` med en olöst
`NEEDS_INVESTIGATION`-bedömning kunna nå `CONFIRMED` alls?

### MÅSTE-2 · Ingen rättelseväg finns för en felaktig avläsning eller debitering

**Mätt:** det finns **ingen PATCH-endpoint för `MeterReading`** (endast
`@Patch('meters/:id')` och `@Patch('charges/:id/confirm')` i
`consumption.controller.ts`), och **inget kodställe i hela repot sätter någonsin
`ConsumptionCharge.status = 'CANCELLED'`** — statusen kontrolleras defensivt på
två ställen (`consumption.service.ts:508`, `accounting.service.ts:2582`) men
skrivs aldrig.

**Varför:** bedömer en människa i granskningsvyn att avvikelsen är bekräftad —
alltså att avläsningen är fel — finns ingen byggd väg att (i) korrigera
avläsningen, (ii) makulera eller räkna om den redan skapade debiteringen, eller
(iii) informera hyresgästen om rättelsen. IMD-debitering utan rättelsemöjlighet
är ett verkligt exponerat läge den dag ett fel faktiskt upptäcks.

### MÅSTE-3 · De två juridiska PR:erna bumpar båda privacy till 1.2

**Mätt av mig själv:**

```
main                                 privacy: '1.1'
legal/subprocessors-voyage (#752)    privacy: '1.2'  hash 62dfca200f26b619…
legal/hantverkare-mottagarkategori   privacy: '1.2'  hash 1c8bdda55b1e95a1…
git merge-tree #752 × #837  →  CONFLICT i packages/shared/src/constants/platform.ts
```

Två olika texter kan inte båda heta 1.2. `check-legal-text-version.mjs` är byggd
för att detta inte ska kunna hända — men bara **inom** en gren, inte mellan två
parallella. Den som mergar sist måste: räkna om hashen över **båda**
ändringarna tillsammans, sätta **1.3** (aldrig återanvända 1.2), och lägga en
historikpost för den 1.2 som aldrig blev verklig.

### MÅSTE-4 · #837:s text lovar hyresgästen något koden inte gör

**Texten** (ny sektion 4.4 i `docs/legal/privacy-policy.md` och de renderade
sidorna): *"…och **hyresgästen kan se i sin portal** att uppgiften lämnats ut."*

**Koden, verifierad i tre steg:**
1. `apps/api/src/history/history.controller.ts:9-10` — skyddad av
   `JwtAuthGuard`, alltså hyresvärdens `User`-realm, inte hyresgästens
   `TenantSession`.
2. `apps/api/src/tenant-portal/` innehåller **noll** referenser till `history`,
   `WorkOrder` eller `contractor`.
3. `SAFE_TICKET_SELECT` (`tenant-portal.service.ts:42-61`) innehåller inte
   `assignedContractorId`, arbetsordrar eller delad kontaktuppgift.

**Den delen av texten som stämmer:** att utlämnandet sparas —
`ContractorWorkOrder.sharedTenantContact`, opt-in med default `false`
(`apps/api/src/contractors/work-order.service.ts:113-117`,
`apps/web/src/features/maintenance/components/BookContractorButton.tsx:45`), och
loggas som `WORK_ORDER_CONTACT_SHARED`
(`apps/api/src/history/history-sources.registry.ts:403-414`).

**Ditt beslut:** bygg portalvyn innan texten publiceras, eller skriv ner meningen
till vad som faktiskt stämmer. En felaktig utfästelse om hyresgästens insyn i sin
egen personuppgiftshantering gör texten osann — det är inte en UX-brist.

### BÖR-1 · `Beloppsutfall` har två värden för en trevärd fråga

**Fil:rad:** `apps/api/src/ai/shadow/payment/payment-fields.ts:61` —
`export type Beloppsutfall = 'FULL' | 'DEL'`. Oförändrad på hela stapeln.

Frågan "täcker betalningen skulden" har **tre** svar: mindre, lika, mer. Typen
har två, så "mer" har inget ord. `beloppsutfall()` svarar `FULL` så snart
`utestaende - inbetalt <= 1`.

**Min egen mätning av konsekvensen i korpusen** (`korpus-betalningar.json`, 40
bankrader, 14 poster):

```
grupper: exakt_ocr 4 · ocr_sifferfel 8 · belopp_och_namn 6 · delbetalning 5
         dubbelbetalning 4 · hyra_plus_avgift 4 · okand_avsandare 5 · retur 4

b24–b31 (8 rader):  facit.belopp = FULL  men  facit.avi = INGEN
                    t.ex. b24 = 16 900 (två gånger 8 450)
                          b28 =  8 930 (8 450 hyra + 480 avgift)

rader där facit pekar på EN avi och beloppet överstiger utestående med > 1 kr: 0
```

Det sista talet är poängen, och det skärper fyndet jämfört med vad jag sagt
tidigare: **korpusen innehåller inte ett enda matchat överbetalningsfall.** Den
undviker det fall typen inte kan uttrycka i stället för att pröva det. De åtta
raderna där betalningen överstiger varje enskild fordran måste märkas `FULL`
därför att det inte finns något annat ord — och facit kräver då att modellen
avstår (`avi: INGEN`), vilket är rätt agerande men inte en mätning av
överbetalning.

**Detta skadar ingen bokföring i dag** — `match_bank_transaction`
(`tool-executor.service.ts:4053`) tar inget beloppsargument och läser
`transaction.amount` som Prisma `Decimal` ur databasen. Det är därför ett BÖR,
inte ett MÅSTE. Men det gör överbetalning omöjlig att mäta, och en förslagsagent
som inte kan mäta sitt eget svåraste fall kan inte visa att den blivit bättre på
det.

**Lösningen finns redan skriven, i experimentet:**
`apps/api/src/ai/shadow/eval/experiment-betalningsgrind.ts:18-35` —
`klassificeraBelopp → 'FULL' | 'DEL' | 'OVERSKOTT' | null`, räknat i **öre som
BigInt**, och `:163` **skriver över** modellens `hantering` med den uträknade
kategorin, `:164` loggar `BELOPP_RAKNAT_I_ORE` vid oenighet, `:177` ger
överbetalning sitt eget skäl `BELOPP_OVERSTIGER_SKULD`. Det är den starkaste
koden i hela arbetet, och den ligger i experimentet i stället för i produktion.

### BÖR-2 · `takNått` finns i två betydelser under samma namn

`payment-candidates.ts:297` returnerar `takNått: rankade.length > MAX_KANDIDATER`
— "kandidatlistan trunkerades". `payment-shadow.service.ts:151` destrukturerar
ett `takNått` ur `hämtaKandidater`, som `:319` sätter till
`avier.length > KANDIDATTAK || fakturor.length > KANDIDATTAK` — "400-radstaket
nåddes". **Två olika frågor, samma namn.** Kandidatfiltrets `takNått` har ingen
läsare i `apps/api/src`; fältet som läses svarar på något annat, och utslaget
blir en varning om fel sak. Precis det CLAUDE.md kallar att låna ett fält som
svarar på en annan fråga.

### BÖR-3 · `rad.text` interpoleras rått — medan repots eget skydd ligger tre rader bort

**Fil:rad:** `apps/api/src/ai/shadow/payment/payment-shadow.service.ts:660` —
`` `  Text från banken: ${rad.text}` `` — ingen avgränsare, ingen taggstrippning,
ingen längdgräns, ingen radbrytningsnormalisering.

Repot har redan försvaret: `neutralizeUntrusted`
(`apps/api/src/ai/tools/untrusted-content.ts:39-61`) ramar in otrodd text i
`⟦OSÄKER⟧` och strippar slutmarkörer, och både `rawOcr` och `description` står
redan i `UNTRUSTED_FIELD_NAMES`. Men funktionen anropas bara från
`tool-executor.service.ts:773,780`; betalningsagenten använder den inte.
**Tre rader kod.**

Mildrande, och det är verkligt: modellens val valideras strukturellt mot en
vitlista av faktiska kandidat-id (`:617`, enum av id + `INGEN_AVI`), växeln är av
överallt, och en lyckad injektion kan i värsta fall bara ge ett dåligt
**förslag**, aldrig en betalning. Men injektionsprovet **c11 kan inte falla** och
c12 är konfunderat — proven som skulle visa att skyddet håller mäter inte det.

### BÖR-4 · `confidence` samlas in och används aldrig

Produceras av modellen, klampas till [0,1] (`payment-shadow.service.ts:699`),
sparas (`:448`). **Ingen tröskel finns någonstans i produktionen** — det enda
stället talet läses för att avgöra något är rapportens bucketindelning
(`apps/api/src/ai/shadow/eval/rapport.ts:241-242`). Antingen inför en tröskel
eller skriv i koden att fältet bara är till för rapporten, så nästa läsare inte
tror att det grindar något.

### BÖR-5 · `MeterReadingReview.comment` saknar raderingsväg (GDPR)

`comment String @db.VarChar(1000)` är fri text en anställd skriver, append-only i
databasen (UPDATE avvisas av trigger), och den enda vägen att ta bort en enskild
rad är en riktad `DELETE` direkt mot databasen — ingen app-endpoint finns. Skriver
en förvaltare av misstag in en hyresgästs personnummer eller hälsouppgift finns
ingen självbetjäningsradering för just den uppgiften, bara för hela
organisationen. Mönstret är inte nytt i kodbasen (`MaintenanceTicket.description`
m.fl.), men append-only gör det svårare att rätta i efterhand. `comment` och
`reviewedByName` är korrekt tillagda i `UNTRUSTED_FIELD_NAMES`
(`untrusted-content.ts:21-22`). Åtgärd: en dokumenterad DBA-procedur, eller ett
kortare tak/validering på fältet.

### BÖR-6 · Spårbarhet vid ett bestridande har två hål

1. **Ingen koppling charge ↔ granskning.** `MeterReadingReview` länkas till
   `readingId` + `findingCode`, aldrig till `ConsumptionCharge.id`. Och
   granskningsrapporten beräknas **live** vid varje anrop, inte lagrad — ett fynd
   som fanns vid faktureringstillfället kan ha försvunnit ur nuvarande rapport.
   Det finns alltså ingen ögonblicksbild av "vad granskningen sa när charge X
   konfirmerades".
2. **Den konfirmerandes identitet kan helt saknas.** `confirmCharge()`
   (`consumption.service.ts:492-524`) kör vidare i ett `try/catch` (`:515-524`)
   även om verifikatet misslyckas, och `createJournalEntryForConsumptionCharge`
   returnerar tyst `null` om kontona 1510/intäktskontot saknas i kontoplanen
   (`accounting.service.ts:2480-2486`). `ConsumptionCharge` lagrar bara
   `actorKind: 'HUMAN'|'AGENT'|'SYSTEM'|null` (`schema.prisma:6305`), **inget
   användar-id**. I det läget finns ingen lagrad identitet alls på vem som
   konfirmerade. Konfigurationsberoende kantfall — men precis den sorts
   "sällsynt men obesvarbart" som gör ett bestridande omöjligt att bemöta.

### BÖR-7 · #876:s döda DI-injektioner

`apps/api/src/ai/tools/tenant-tool-executor.service.ts:41` och
`apps/api/src/tenant-portal/tenant-portal.service.ts:568` injicerar fortfarande
`NotificationsService`, men `grep this.notificationsService` ger noll träffar i
båda filerna efter ändringen. Ofarligt i runtime, men vilseleder nästa läsare om
vem som äger notisen. En rad i varje fil.

**NIT i samma PR:** notisrubriken för hyresgäst-inrapporterade ärenden gick från
`'🔔 Ny felanmälan från hyresgäst'` till det generiska `'Nytt underhållsärende'`
(namnet syns nu bara som prefix i brödtexten). En förvaltare tappar den visuella
signalen "det här kom från hyresgästen själv". Produktfråga, ingen
korrekthetsbugg.

### BÖR-8 · Systemprompten växte till 6 591 tecken med 39 negationer

`apps/api/src/ai/ai-assistant.service.ts:234-317`. Agent 3 tog den globala
systemprompten från 0 → 1 983 → **6 591 tecken**. Det är ~2 000 tokens på varje
chattsvar för **varje** organisation, cachad men med omätt kvalitetseffekt. 39
negationer i en systemprompt är i sig ett känt sätt att göra en modell sämre på
det man bad om. Ingen mätning finns av vad tillägget gjorde med svaren.

### BÖR-9 · Faktablocket läggs EFTER det strömmade svaret

`apps/api/src/ai/tools/consumption-follow-up-facts.ts:22-54,61-93` bygger
faktapåståenden i kod och vägrar korrekt att utse en vinnare när två samtidiga
läsningar är oeniga — det är rätt gjort. Men blocket appendas efter den strömmade
texten (`ai-assistant.controller.ts:485-489`), så en hallucinerad tidpunkt får den
korrekta tryckt **under** sig i stället för i stället för. Läsaren ser båda.

---

## 7. I vilken ordning bör vi gå vidare

### Steg 1 — de tre som är klara, och bara de (ingen risk, rensar bordet)

1. **[#876](https://github.com/yasineken2002-sys/eken/pull/876)** — rätta BÖR-7
   (två rader döda injektioner) i samma PR, merga sedan. 61/61 grönt, ren merge.
2. **[#857](https://github.com/yasineken2002-sys/eken/pull/857)** — merga som är.
   61/61 grönt, ren merge, bas `main`, inte i stapeln.
3. **[#855](https://github.com/yasineken2002-sys/eken/pull/855)** — merga in main
   i grenen, lös de två DTO-konflikterna genom att **behålla båda sidor**, bygg
   om `@eken/shared` (annars faller `dto-contract.spec.ts` på en gammal `dist/`),
   merga sedan. Tar kontraktsbaslinjen 6 → **0**.

### Steg 2 — de två juridiska (ditt beslut, inte mitt)

4. **Besluta om #837:s text** innan någon av dem mergas: bygg portalvyn, eller
   skriv ner meningen. Det är MÅSTE-4 och bara du kan ta det beslutet.
5. **Merga en av dem**, rebasa den andra, räkna om privacy-hashen över **båda**
   texterna, sätt **1.3**, lägg historikpost för den 1.2 som aldrig blev verklig.
   Och läs båda texterna själv — orgnummer-placeholdern
   (`PLATFORM_COMPANY.orgNumber`) är kvar, och `apps/portal/src/pages/PrivacyPage/`
   är fortfarande en tredje, icke-uppdaterad kopia av samma dokument (#576).

### Steg 3 — Agent 3-stapeln (10 PR:er) — men besluta MÅSTE-1 först

6. **Ta ställning till MÅSTE-1.** Ska en debitering kunna konfirmeras förbi en
   olöst bedömning? Svarar du nej är det en spärr i `confirmCharge()` och den bör
   byggas **innan** stapeln mergas — annars mergar du ett granskningsverktyg som
   per konstruktion inte kan stoppa något.
7. **Merga #858 → #867 nedifrån och upp, utan `--delete-branch`.** Stapeln är
   linjär, noll reverts, 10/10 grönt, toppen mergar rent. Säkerhetsgranskningen
   hittade 0 CRITICAL och 0 HIGH. Tekniskt är den den mest färdiga delen av hela
   arbetet.
8. **MÅSTE-2 (rättelsevägen) och BÖR-5/BÖR-6** som egna, efterföljande PR:er.

### Steg 4 — Agent 2: dela stapeln i två delar, merga inte den som den står

9. **Merga #856 ensam** om något — den bär korpusen och bottenmätningen.
10. **Plocka ut de 22 raderna** i `payment-shadow.service.ts` till en egen, liten
    PR **med prov som CI kör** (5.3), och fixa BÖR-3 (tre rader
    `neutralizeUntrusted`) i samma PR.
11. **Lyft `klassificeraBelopp` ur experimentet in i produktion** (BÖR-1):
    `Beloppsutfall` → `FULL | DEL | OVERSKOTT`, räknat i öre, och låt **koden**
    skriva över modellens beloppsbedömning precis som
    `experiment-betalningsgrind.ts:163` redan gör. Lägg till minst ett matchat
    överbetalningsfall i korpusen — i dag finns noll.
12. **Återinför `86bf2473`** (kandidatfiltret) eller skriv ner varför inte. Den
    vann på varje axel, den togs bort utan skäl, och mätningen som visade att den
    vann raderades ur agentplanen. Ett av de två måste hända: regeln tillbaka,
    eller skälet nedskrivet.
13. **#870/#871/#873/#874/#875: merga inte som funktionsleverans.** Noll
    produktionsavtryck, noll CI-täckning, inget BAS-konto valt. Behåll de 11
    JSON-filer som faktiskt är fixturer, flytta ut resten (~71 filer) ur
    versionshanteringen, och skriv om PR-titlarna så de säger "designstudie" i
    stället för "tillgodo-livscykel".
14. **Fixa BÖR-2 och BÖR-4** (`takNått`-namnkrocken, `confidence` utan tröskel)
    innan någon slår på `shadowPaymentAgentEnabled` för en riktig organisation.

### Det som inte hör i någon av stegen

**BÖR-8** (systemprompten, 6 591 tecken / 39 negationer) är en egen mätuppgift,
inte en fix. Ingen vet i dag vad tillägget gjorde med svarskvaliteten, och det
går inte att gissa fram.

---

## 8. Invändningar jag inte vill att du missar

1. **Jag har rättat mig själv i §5.5.** Jag sa tidigare att den återtagna regeln
   låg i prompten och gjorde saken sämre. Den låg i kandidatfiltret och vann på
   varje mätt axel. Det påverkar steg 12.
2. **Uppdragsfilen har jag inte kunnat läsa.** Områdena i §2 är mina, inte dina.
3. **Det lokala bankbygget utan PR är ogranskat.**
4. **65,4 %, inte 97 %**, är Agent 2:s siffra som betyder något — och
   100 %-recallen som är låst i CI
   (`betalningsrapport.spec.ts:90-95`) är ett prov som bara kan falla nedåt.
5. **#752 kördes mot 52 CI-jobb, inte 61.** Nio vakter som finns i dag har aldrig
   körts mot den grenen.
6. **"Tillgodo" är inte byggt**, trots två PR-titlar som säger det.
7. **Granskningsverktyget i Agent 3 kan inte stoppa en debitering.** Det är inte
   en glömd detalj — det är arkitekturen, och den frågan är din att avgöra.

---

# TILLÄGG 2026-09-10, efter Codex svar — FEM RÄTTELSER

Codex har svarat på granskningen och invänt mot sex punkter. Jag har mätt om
dem själv. **Fem av invändningarna håller, och rättar fel i det som står ovan.**
Läs det här tillägget innan du agerar på §4–§6.

Codex svarade dessutom **"INGEN DOKUMENTERAD ORSAK"** på sju av nio frågor om
varför något gjordes. Det är svaret på frågan om hur arbetet tänkte: det går inte
att veta. Beslutsunderlaget finns inte i commit-meddelanden, kodkommentarer eller
docs. Det enda som var dokumenterat från början är Agent 3:s läsande avgränsning
(`docs/agent3-forbrukningsgranskning.md:3-5`) och att modellkörningar kostar
pengar och därför inte körs i CI (`apps/api/scripts/eval-shadow-agent.ts:4-9`).

## R1 — BÖR-9 är FEL. Grinden körs FÖRE utmatningen.

Rapporten ovan säger att faktablocket appendas efter den strömmade texten, så en
hallucinerad tidpunkt får den korrekta tryckt under sig. **Det beskriver flödet
före #867.** Mätt på `origin/codex/agent3-svarsgrind`:

```
ai-assistant.controller.ts:368-372   stream.on('text') ACKUMULERAR bara i
                                     assistantText — inget skickas
                 :492-499            grinden körs, skriver om assistantText
                 :500                send('delta', { text: assistantText })
                 :516-518            faktablocket appendas — EFTER att grinden
                                     redan haft det som statusFacts-indata
```

Kommentaren i koden säger det själv: *"Buffra text tills läsningarna och
svarsgrinden är klara. Verktygens status visas löpande; ett ostyrkt påstående får
aldrig hinna visas först."* `consumption-follow-up-chat.spec.ts:295-318` prövar
att ingen delta skickas före domen (provet är läst, inte kört).

**BÖR-9 utgår.** Kvarstående, riktig begränsning: grinden kan bedöma fel. Det är
en annan sak.

## R2 — BÖR-2 beskriver fel defekt. Varningen gäller RÄTT tak.

Rapporten säger att `takNått`-krocken ger "en varning om fel sak". Mätt:

```
payment-shadow.service.ts:412   if (f.takNått)        ← databastakets flagga
                         :417   `Fler än ${KANDIDATTAK} öppna poster`  ← samma tak
```

Flaggan och texten hör ihop. Ingen felaktig varning uppstår.

**Defekten är den omvända:** `payment-candidates.ts:297`:s `takNått` — trunkering
till `MAX_KANDIDATER = 5` — har ingen produktionskonsument. Trunkeringen av
kandidatmenyn är alltså **osynlig** för hyresvärden som ska godkänna. Det är en
saknad varning, inte en fel. Namnkrocken kvarstår som ett riktigt problem
(två frågor, ett namn), och fixen är Codex förslag: separata namn, separata
utfall, och ett prov att vart tak blir synligt oberoende av det andra.

## R3 — BÖR-3:s premiss om "aritmetik i prompten" är FEL

Rapporten säger att tre uppgifter som är ren aritmetik ligger i prompten. Mätt:

```
payment-shadow.service.ts:211   const belopp: Beloppsutfall =
                                  beloppsutfall(rad.belopp, vald.utestaende)
                         :635   modellens utdata = ['avi','confidence','reasoning']
payment-candidates.ts           OCR-avståndet räknas i kandidatkoden
```

Beloppsetiketten och OCR-avståndet räknas alltså **i kod**. Modellen får inte
räkna dem. Det som ligger i prompten (`:670-681`) är mjuk vägledning om hur de
redan uträknade fakta ska **vägas** i avi-valet.

Den riktiga invändningen är smalare och Codex formulerar den bättre än jag:
*"avi-valet påverkas fortfarande av mjuka instruktioner där vissa faktakontroller
kan göras deterministiskt."* Och skillnaden mellan de två sakerna: att prioritera
äldsta skuld är en **hanteringsregel**, inte aritmetik.

## R4 — "noll .spec.ts-referenser" är FEL som formulerat

```
byggBetalningsprompt  ← verklighetslik-betalningsmatning.ts:98
                      ← verklighetslika-betalningar.spec.ts:90
```

Funktionen nås alltså från en spec CI kör. **Men specen injicerar färdiga
modellsvar** (`response({ avi, confidence, reasoning })`), så den verifierar
mätriggen — inte om modellen följer returdetektionen, namnregeln eller
prioriteringen. Den underliggande invändningen står; formuleringen i §5.3 ska
läsas som "ingen deterministisk prövning av de nya reglernas beteende", inte som
"ingen spec rör funktionen".

Codex tillägg, som är det viktiga: *"Att testa att prompten innehåller en mening
bevisar inte att modellen följer den."*

## R5 — #874 är INTE bara experiment utanför produktionskoden

§5.1 säger att #873–#875 inte innehåller produktionsavtryck. Det är literalt sant
om `apps/api/src` (noll tillagda rader), men underskattar vad #874 gör:

```
eval_bankimport.cjs:30-50
  prod.ReconciliationService.prototype.ingestFromApi.call(service, …)
  prod.ReconciliationService.prototype.ingestFromFile.call(service, …)
  med riktig CentDecimal
```

Det är **komponentprov mot riktig produktionskod** med ersatta gränser, inte en
omskrivning i Python. Kritiken att det aldrig körs av CI står kvar — men det är
en annan slutsats än "ingen produktionskoppling".

## R6 — MÅSTE-2:s formulering är oprecis (accepterad utan ommätning)

"Bedömer en människa att avvikelsen är bekräftad — alltså att avläsningen är fel"
är fel likhetstecken. `docs/agent3-assistent-underlag.md:14-15` säger uttryckligen
motsatsen: en **verklig** förbrukningsökning kan vara korrekt uppmätt. Behovet av
en rättelseväg vid faktiska fel kvarstår oförändrat.

Samma sort: §6 BÖR-8:s "omätt kvalitetseffekt" är för absolut —
`docs/agent3-assistent-status.md:62-71` beskriver utvecklingsmätningar med
produktionsprompten. Vad som saknas är en **bred, isolerad** jämförelse av
effekten på andra chattämnen.

## R7 — §5.5:s REKOMMENDATION är fel, och Codex analys är starkare än min

Rapporten rekommenderar att återinföra `86bf2473` eller skriva ner varför inte.
Codex skrev ner varför inte, och lade till det jag missade.

**Min mätning:** korpusen innehåller noll korrekt identifierade överbetalningsfall.
**Codex slutsats ur samma mätning:** det är DÄRFÖR filtret såg ut att vinna. Det
skar bort en förmåga mätningen inte kan se, och metriken belönade det. 36/36 var
inget bevis på att regeln var bra — det var ett bevis på att korpusen var blind
för vad regeln kostade.

Det finns dessutom ett senare dokumenterat ställningstagande,
`docs/agent2-verklighetslika-prov.md:63-66`: *"Sådana kontroller måste behålla
OCR, relevanta kandidater samt människans möjlighet att välja. Att skära bort
avier vars skuld inte rymmer hela betalningen är fortfarande fel väg."*

**Rätt åtgärd är inte att återinföra filtret.** Den är att skilja tre frågor åt:

```
identitet          ÄR det här rätt avi?            ← behåll kandidaten
beloppsrelation    täcker betalningen skulden?     ← räkna i öre, tre värden
tillåten hantering får detta verkställas?          ← spärra, inte gömma
```

En avi kan vara korrekt identifierad även när betalningen innehåller överskott.
Då ska den visas för människan, medan olämplig verkställighet spärras.

Två preciseringar till, båda Codex och båda riktiga: `klassificeraBelopp`
behåller ±1 krs tolerans (`experiment-betalningsgrind.ts:34`) — exakt
öresaritmetik betyder inte att toleransregeln försvann. Och att b24–b31 har
`avi: INGEN` är ett uttryckligt **facitbeslut** (`korpus-betalningar.json:38-45`),
inte något den tvågradiga typen tvingar fram.

## Vad som INTE ändras av Codex svar

- **MÅSTE-1 står oemotsagt.** Codex bekräftar fyndet och tillägger att frågan
  borde ha avgjorts vid **#861**, när beständiga bedömningar infördes — dess egen
  efterhandsbedömning, inte en återfunnen plan. Plus två krav jag inte hade:
  spärren måste hantera **saknad** bedömning, inte bara sparat
  `NEEDS_INVESTIGATION`, och bedömningsstatusen `CONFIRMED` får **aldrig**
  återanvändas som betalningsgodkännande (husregeln om lånade fält).
- **MÅSTE-2, MÅSTE-3, MÅSTE-4** står.
- **BÖR-1** står, med R7:s skärpning.
- **Titlarna (§5.2).** Codex håller med och föreslår själv:
  `#870: Designstudie: simulera överskottsuppdelning – ingen produktionsfunktion`
  `#871: Designstudie: pröva tillgodopolicy i isolerad PostgreSQL`
- **JSON-filerna (§5.4).** Codex invänder mot kriteriet, inte mot problemet:
  `bankevent_proposal/audit.py:18-21,125-133` läser indata, facit och
  körningsarkiv och kontrollerar hashvärden. **Avsaknad av `.spec.ts`-import är
  alltså inte ett tillräckligt gallringskriterium.** Inventera användningen före
  gallring; frysta facit, historiska granskningsbevis och regenererbara resultat
  kräver olika hantering. Codex har inte gjort en fullständig
  konsumentinventering av alla 82 — ingen har.

## ORDNINGEN, reviderad

Codex tre förslag är mina MÅSTE-1, MÅSTE-2 och BÖR-1 i bättre form. Den
reviderade ordningen i §7 blir:

1. #876 (med BÖR-7), #857, #855 — oförändrat.
2. De två juridiska — oförändrat (MÅSTE-3, MÅSTE-4).
3. **Grind före förbrukningsdebitering**, med granskningsstatus läst i SAMMA
   transaktion, som hanterar saknad bedömning och inte lånar `CONFIRMED`.
   Före eller tillsammans med Agent 3-stapeln.
4. **Spårbar rättelseväg** för avläsning och debitering, utan att historik
   försvinner.
5. **Exakt beloppsklassning i öre, med identitet och hantering som skilda
   beslut**, med CI-prov — och UTAN att återinföra kandidatfiltret. Nytt,
   separat facit för identifierat överskott, utan att skriva om gamla mätningar.
6. Namnbyte på #870/#871. Inventering före JSON-gallring. BÖR-2 (de två taken),
   BÖR-4 (confidence), BÖR-5, BÖR-6, BÖR-8.

## R8 — EN STAPEL ÄR INGEN SPÄRR (rättelse av mitt eget råd i byggordern)

Jag skrev i byggordern för debiteringsgrinden att grinden som elfte PR i stapeln
gör att "inget kan nå main utan grinden". **Det är fel, och Codex fångade det.**

En stapel är en beroendeordning, inte en grind. `#858` har bas `main` och kan
mergas ensam, oavsett vad som ligger ovanpå. **Mergar man #858 utan resten hamnar
ett granskningslager på main som inte kan stoppa en enda debitering** — alltså
exakt MÅSTE-1, fast nu i produktion och med en UI-yta som ser ut att göra något.

Det finns ingen mekanisk spärr mot det. Skyddet är en överenskommelse: Agent 3
levereras samordnat, grinden inkluderad, eller inte alls. Skriv det i PR-texten
på #858 så den som mergar ser det där och inte här.
