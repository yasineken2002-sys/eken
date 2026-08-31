# Hyresgästagenten — plan

> ## ⚠️ Detta är MÄTUNDERLAG, inte den gällande planen
>
> Den gällande planen är **[`docs/eveno-agentplan.md`](./eveno-agentplan.md)**.
> Det här dokumentet är dess mätunderlag: det bär den detaljerade kodmätningen
> som masterplanen vilar på. **Vid motstridighet gäller masterplanen.**
>
> ### Påståenden här som mätningen 2026-08-30 UPPHÄVDE
>
> Verifieringen kördes mot `050c085` — samma commit som texten nedan mättes mot,
> så avvikelserna är inte drift. De var fel redan när de skrevs. Läs INTE
> talen i vänsterkolumnen som fakta:
>
> | Står nedan | Uppmätt 2026-08-30 | Var |
> | --- | --- | --- |
> | `ACTION_TOOLS` (28) | **30** | `ai-tools.definition.ts:1010–1036` |
> | "två av **sex** utåtriktade verktyg" | **två av fem** — och den femte, `send_document_to_tenant`, saknas i uppräkningen | `tool-executor.service.ts:1029, 1083, 1406, 2723, 3711` |
> | "60+ ägarverktyg" | **56** | `TOOLS`, räknad i runtime |
> | "sex registrerade köer och sex workers" | **7 köer**, 6 worker-filer, **7** `@Processor` (`mail.worker.ts` bär tre) | `mail/pdf-jobs/import/psd2/leases` |
> | "26 `@Cron` över tolv filer" | **25 över 14 filer** | `apps/api/src` |
> | **R5 "kommer att falla"** på en delegation | **Faller INTE.** `otherFiles` är en hårdkodad lista om två filer, så en ny delegationsmodul prövas aldrig. Mätt med negativkontroll; sonden gav 1 brott när den matades in i regelns egen `evaluate()`, men vakten förblev grön i skarpt läge | `check-action-tool-authorization.mjs:147–164, 326` |
> | (gallringsfristen nämns inte) | `AiToolExecution` gallras **differentierat: 730 / 365 / 90 dagar**, och de bokföringsnära verktygen omfattas | `retention/tool-execution-retention.ts:52, 62, 71, 80` |
>
> Det som INTE ändrades: avsnitt F2, F3, F4, F5, F7 och punkterna om
> `TENANT_TOOLS` (8 verktyg, 2 skrivande), `AiPendingAction` (5 min, hash-only),
> `AiMemory` och `MaintenanceTicket.assignedToId` stämmer exakt, radnummer
> inkluderat.


En agent som sköter hyresgästkontakten själv och stannar för det som binder
hyresvärden. Planen är mätt mot koden i repot, inte mot vad som borde finnas.

> **MÄTT MOT `050c085`** — `050c085ae0c6343b2b86ade57dfefa30aa99399d`, som vid
> mättillfället (2026-08-29) var `main` = `origin` = **prod**. Varje filreferens
> och radnummer nedan gäller det tillståndet.
>
> Innan du bygger på en rad här: kontrollera att den fortfarande beskriver koden.
> En rad i en plan är ett spår, inte ett faktum.
>
> ```bash
> git merge-base --is-ancestor 050c085 HEAD
> git log --oneline 050c085..HEAD -- apps/api/src/ai/
> curl -fsS https://eken-production.up.railway.app/v1/health \
>   | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["revision"])'
> ```

Ingen kod är skriven. Detta är en plan.

---

## 0. RÄTTELSE — gränsen går vid handlingens art, inte vid ämnet

> **Detta avsnitt ERSÄTTER den ursprungliga trenivåindelningen i uppdraget.**
> Den formuleringen (nivå 1 "går själv" / nivå 2 "godkänns" / nivå 3 "aldrig,
> uppräknat som uppsägning, hyresnivå, besittningsskydd, deposition, juridisk
> bedömning") **gäller inte längre och ska inte tillämpas.** Hittar du den
> någon annanstans — i ett äldre utkast, i en artefakt, i ett samtal — är den
> överspelad av det som står här. Det finns ingen version av planen där båda
> gäller samtidigt.

### Den rätta gränsen

Gränsen går **inte vid ämnet** (hyreshöjning, uppsägning, deposition) utan vid
vad verktyget **gör**:

| | |
| --- | --- |
| **Anteckning** | Verktyget SKRIVER NER ett beslut som en människa redan fattat. Att registrera att ett avtal upphört är en anteckning. |
| **Handling** | Verktyget UTFÖR något mot en tredje part. Att skicka en uppsägning till hyresgästen är en handling. |

Samma ämne kan alltså ligga på båda sidor. Det är handlingens art som avgör,
inte vad den handlar om.

### Fyra följder som planen bär

1. **`apply_rent_increase` och `transition_lease_status` ska INTE flyttas,
   ändras eller tas ur `ACTION_TOOLS`.** Båda är anteckningar: de skriver ner
   ett beslut hyresvärden fattat, och en människa bekräftar varje körning.
2. **Ägar-AI:ns förmåga är oförändrad.** Ingen befintlig förmåga tas bort. Det
   här bygget lägger till en agent; det river inget.
3. **"Nivå 3" är inte en tredje nivå på samma AI.** Det är att hyresgästagenten
   är en **separat agent** med en **egen, kort allowlist** där de verktygen inte
   ingår. Spärren är frånvaro, inte förbud.
4. **Därmed finns ingen "ta bort förmåga"-post någonstans i planen.** Det som
   ska byggas är en avgränsad yta bredvid den befintliga, inte en beskärning av
   den.

### Vad rättelsen ändrade i planen

Ett tidigare utkast bar den gamla ämnesbaserade indelningen och drog av den
slutsatsen att två verktyg måste tas ur `ACTION_TOOLS`. **Den slutsatsen är
struken.** Konkret ändrades:

- **F1** skrevs om helt — från "två av dina nivå-3-saker ligger på nivå 2 och
  måste bort" till vad koden faktiskt visar om separata agentytor.
- **Gapgrupp B** ändrades från "ta bort två verktyg" till "klassificera
  utåtriktning och avgränsa agentens allowlist".
- **Vaktens regel R2 i avsnitt 5** klassificerade tidigare på ämnesfält
  (`monthlyRent`, `depositAmount`, konto 2890). Den klassificerar nu på
  utåtriktning, vilket är den axel rättelsen pekar ut.
- **Punkt 6 i första leveransen** motiverades tidigare med att uppsägning är
  nivå 3. Motiveringen är utbytt.

---

## 1. Sju fynd som ändrar planen

Fyra av dem gör något du beskrev som en påbyggnad till en ombyggnad, och två gör
en delmängd av modellen obyggbar i dag.

### F1 — Konstruktionen rättelsen beskriver finns redan i repot. Distinktionen den vilar på gör det inte.

`TENANT_TOOLS` **är** en separat agent med en egen kort allowlist: åtta verktyg,
egen definitionsfil (`tenant-ai-tools.definition.ts`), egen exekverare
(`tenant-tool-executor.service.ts`), egen action-mängd. Ägar-AI:ns 60+ verktyg
är inte nåbara därifrån, och modellen kan inte anropa något som inte står i dess
`tools`-array. Det finns alltså ett fungerande föredöme att bygga på, inte en ny
arkitektur att uppfinna.

Det som **inte** finns är rättelsens axel. `ACTION_TOOLS` blandar anteckning och
handling fritt i samma mängd, med samma grind:

| Verktyg | Art enligt rättelsen |
| --- | --- |
| `create_journal_entry`, `mark_invoice_paid`, `apply_rent_increase`, `transition_lease_status` | anteckning |
| `compose_and_send_email`, `send_invoice_email`, `send_overdue_reminders`, `send_document_to_tenant`, `export_for_collection` | handling mot tredje part |

**För ägar-AI:n är den blandningen ofarlig** — en människa bekräftar varje
körning, och bekräftelsen är samma sak oavsett art. **För agenten är den inte
det**, eftersom agenten per definition saknar en människa i det ögonblick
handlingen sker. Distinktionen måste därför födas i agentens allowlist, inte
lånas från `ACTION_TOOLS`.

**Och den går inte att grepa fram.** Bara två verktyg når `mailService` direkt i
exekveraren:

```
this.mailService.sendOverdueReminder(   tool-executor.service.ts:1083   → send_overdue_reminders
this.mailService.sendCustomEmail(       tool-executor.service.ts:1406   → compose_and_send_email
```

Resten går via domäntjänster — `invoicesService.sendInvoiceEmail(...)` på rad
1029, `collectionExport.exportForInvoice(...)` på rad 3711. En vakt som söker
efter `mailService` i exekveraren ser alltså **två av sex** utåtriktade verktyg
och är grön om de fyra andra. Det är precis mönstret *"grep efter literaler
missar generiska skrivare"*. Utåtriktningen måste **deklareras**, inte härledas
med sökning — och deklarationen behöver då en egen kanariefågel. Se avsnitt 5.

### F2 — `AiPendingAction` är ett chattkonstrukt, inte en godkännandekö.

`schema.prisma:2512`. Livslängden är fem minuter (`PENDING_ACTION_TTL_MS`,
`ai-assistant.service.ts:492`), raden är bunden till en `conversationId` och en
`userId`, och den lagrar **bara en hash** — schemats egen kommentar säger att den
faktiska inputen finns i AI-meddelandet och skickas in av klienten.

En agent som förbereder något kl 03:00 för godkännande kl 09:00 har (a) en
utgången rad, (b) ingen klient som kan skicka tillbaka inputen, (c) ingen
konversation någon sitter i. Godkännandekön kan inte återanvända mekanismen. Det
krävs en ny modell.

### F3 — `AiMemory` är LLM-extraherad prosa och är fel plats för en befogenhet.

`memory.service.ts:66+` ber Claude läsa samtalet och skriva ut
`{key, value, type}`. `getMemories()` klistrar in resultatet i systemprompten
under rubriken *"Använd dessa som standard när användaren inte specificerar
något annat."*

En befogenhet som bor där är exakt det CLAUDE.md-avsnittet *"En regel som frågar
prosa i stället för kod är alltid uppfylld"* beskriver. En befogenhet måste vara
en **rad som `executeTool` läser**, aldrig en mening modellen läser.

### F4 — Ingenting utifrån väcker systemet från en hyresgäst utom ett HTTP-anrop från portalen.

`MessagesModule` är enkelriktat utgående — `sendToTenant`, `sendToAll`, modellen
heter `SentMessage`. `WebhooksModule` tar emot Resends *leveransstatus* och inget
annat; det finns ingen inkommande e-postparsning i repot.

"Hyresgästen mailar och agenten svarar" existerar inte som väg. De enda
hyresgästinitierade ingångarna är portalens chatt, portalens
felanmälningsformulär och magic-link-inloggningen.

### F5 — "Boka hantverkare" har ingen datamodell alls.

Det finns ingen `Vendor`, `Contractor` eller `Supplier` i schemat.
`MaintenanceTicket.assignedToId` (`schema.prisma:2939`) är en naken `String?`
**utan relation** — ett hängande fält som inte pekar på något.

Den byggbara versionen av det exemplet är "skriv ett mejl till en adress" — och
det finns ingenstans att lagra hantverkarens adress. Vill du ha bokning är det en
egen datamodell först, inte en agentfråga.

### F6 — I dag bekräftar *hyresgästen* felanmälan, inte hyresvärden.

`create_maintenance_ticket` ligger i `TENANT_ACTION_TOOLS` och stoppas i
portalens chattloop (`tenant-ai.service.ts:180–222`) för en bekräftelseknapp i
`TenantAiChat.tsx`.

Enligt rättelsen är en felanmälan en **anteckning** — den skriver ner något
hyresgästen berättat, och notisen går inåt till hyresvärden. Den behöver därför
ingen bekräftelse. Ratten finns alltså redan och pekar bara åt fel håll. Men den
ratten är *samma* ratt som kopplar in `assertActionToolAuthorized` — tas verktyget
ur mängden lämnar det också grindens ansvarsområde. Det är rätt, men det ska vara
ett beslut och inte en bieffekt.

### F7 — Hyresgäst-AI:ns spärrar är redan mekaniska. Motiveringen i prompten är prosa.

Systemprompten innehåller en uppräkning: *"ALDRIG: Lova något på fastighetsägarens
vägnar · Föreslå hyresjusteringar · Acceptera uppsägningar."* Det som faktiskt
håller är dock att `TENANT_TOOLS` bara har åtta verktyg och inget av dem kan göra
något av det.

Konstruktionen är alltså redan rätt — prosan är bältet, verktygsavsaknaden är
hängslena. Risken är att någon senare lägger till ett verktyg och tänker *"prompten
säger ju nej"*. Vakten i avsnitt 5 finns för att göra den skillnaden synlig.

---

## 2. Inventering: vad bär redan, och var slutar det

### AiModule

| Del | Täcker redan | Slutar vid |
| --- | --- | --- |
| `tool-executor.service.ts`<br>3 760 rader | 60+ ägarverktyg. Rollgrind via `decideAiToolAccess` (`common/authz/ai-tool-authz.ts:68`) — en `switch` med `default: neka`. Revision via `AiToolExecution` + `AiToolEffect`, effektkollektor i AsyncLocalStorage. Osäker text ramas in med `neutralizeUntrusted`. | Signaturen kräver `userId` + `userRole`. Det finns ingen aktör som inte är en inloggad människa. En agent har ingen identitet att köra som. |
| `ai-tools.definition.ts` | `TOOLS`, `ACTION_TOOLS` (28), plus rollmängderna `MANAGER_ALLOWED_ACTIONS`, `ACCOUNTING_ONLY_ACTIONS`, `MANAGEMENT_ONLY_ACTIONS`. | Binär indelning: bindande eller inte. Ingen mängd skiljer anteckning från handling mot tredje part. |
| `action-authorization.ts` | `assertActionToolAuthorized` ligger *först* i båda exekverarnas `executeTool`. Bevakad av `check-action-tool-authorization.mjs` med fem regler och självtest i CI. | Grinden frågar *"har en människa bekräftat?"*. Agentfrågan är *"får detta ske utan att någon bekräftar just nu?"*. Olika frågor — kräver en andra grind. |
| `AiPendingAction` | Atomärt engångsanspråk (`updateMany` på `consumedAt: null`), utgångsspärr, bunden till konversationen. Race-säker. | Se **F2**. 5 min, hash-only, kräver en levande klient. |
| `AiMemory` / `memory.service.ts` | Fyra typer, unik på `(org, user, key)`, ämneskopplad till hyresgäst via `AiMemoryTenant` för riktad radering. | Se **F3**. Innehållet är LLM-extraherad fritext som injiceras i prompten. Aldrig en behörighetsbärare. |
| `tenant-ai.service.ts`<br>577 rader | Hela hyresgästvägen: quota (50 anrop/dag, 50 kr/mån per hyresgäst), injection-loggning utan innehåll, `<HYRESGAST_MEDDELANDE>`-inramning med taggstripp, verktygsloop, bekräftelseanspråk mot `pendingActionHash`. | Synkron request/response. Loopen *returnerar* vid ett bindande verktyg och kör aldrig vidare — den kan inte ta emot ett `tool_result` från ett skrivande verktyg. |
| `untrusted-content.ts` | **Den viktigaste befintliga byggstenen för autonomi.** Ramar in hyresgästskriven text i `⟦OSÄKER⟧` innan den går tillbaka till modellen, plus mönsterloggning. | Fältnamnen är en uppräkning om elva namn. En ny osäker källa som heter något annat ramas inte in — och det syns inte. |
| `tool-iteration-cap.ts`, `AiQuotaService`, vilande-org-grinden | `MAX_TOOL_ROUNDS` som ett värde för tre loopar. Kostnadstak per org och dag. Grind som hoppar över organisationer utan data. | Bär redan en autonom körning kostnadsmässigt. Ingen "av"-knapp per organisation. |

### Övriga moduler

| Modul | Täcker redan | Slutar vid |
| --- | --- | --- |
| `TenantPortalModule` | Magic-link-auth (`TenantMagicLink`, `TenantSession`), `tenant-auth.guard.ts`, `@CurrentTenant()`, sju separata läcktester. | Allt är request/response med en inloggad hyresgäst. Ingen session = ingen väg in. |
| `MaintenanceModule` | `MaintenanceTicket` med nummerserie, kategori- och prioritetsenum, kommentarer, bilder, koppling till `MiscCharge` för debitering. | Ingen leverantör, ingen bokning, ingen tidsfrist, ingen återkoppling till hyresgästen bortom `tenantNotified: Boolean`. Se **F5**. |
| `NotificationsModule` | `Notification` in-app, `createForAllOrgUsers`. Och tre cron-jobb som **redan kör AI**: morning-insights 07:00 vardagar, weekly-summary 18:00 söndag, monthly-report 08:00 den 1:a. | De AI-jobben *skriver text*. De anropar inga verktyg och fattar inga beslut. Skillnaden mot en agent är precis den. |
| `MailModule` | Bull-köer `HIGH/NORMAL/LOW` → `mail.worker.ts` → Resend. Renderare, mallar, suppression-lista, idempotensnyckel. | Utgående. Inget inkommande. Se **F4**. |
| `AviseringModule` | Hela kravtrappan, autonomt via cron. `PaymentFreshnessModule` pausar trappan när betalningsdata är inaktuell. | **Den är redan autonom och skickar redan utåtriktade handlingar** (påminnelser) utan godkännande — via cron. En agent ovanpå riskerar dubbelutskick. Se 9.4. |

---

## 3. Gapet

Arton poster i sex grupper. Ordningen inom varje grupp är beroendeordning.

### A · Aktören

| | |
| --- | --- |
| **G1** | Ingen icke-mänsklig aktörsidentitet. `executeTool(…, userId, userRole)` kräver en `User`-rad. En agent behöver antingen en systemanvändare eller ett `actor`-objekt med egen typ. |
| **G2** | `AiToolExecution.userId` är FK mot `User`. En agentkörning utan användare tappar aktören ur revisionsspåret — och spåret är `onDelete: Restrict` av just den anledningen. |
| **G3** | Ingen avstängningsknapp per organisation. `AiQuotaService` har tak; det finns inget "av" utan deploy. |

### B · Agentens yta

| | |
| --- | --- |
| **G4** | Ingen `AGENT_TOOLS`-allowlist och ingen `OUTWARD_TOOLS`-klassificering. Distinktionen anteckning/handling finns inte som begrepp i koden. Se **F1**. |
| **G5** | Utåtriktning går inte att härleda med sökning — två av sex utåtriktade verktyg når `mailService` direkt, resten via domäntjänster. Klassificeringen måste deklareras och sedan bevakas. |
| **G6** | Ingen vakt som fäller när ett *befintligt* agentverktyg får en ny utåtriktad förmåga. En namnlista ser inte det. |

> Denna grupp innehåller med flit **ingen** post om att ta bort eller flytta ett
> befintligt verktyg. Se avsnitt 0.

### C · Godkännandekön

| | |
| --- | --- |
| **G7** | Ingen persistent förberedd-åtgärd-modell. `AiPendingAction` duger inte. Se **F2**. |
| **G8** | Inget godkännande-UI utanför chatten. Allt i `AiPage.tsx` förutsätter att man sitter i konversationen. |
| **G9** | Ingen notistyp för "väntar på ditt godkännande". `Notification` finns; `NotificationType` saknar posten. |
| **G10** | Ingen färskhetsgrind vid godkännandet. En åtgärd förberedd mot ett tillstånd som ändrats innan godkännandet måste omvärderas *då*, inte vid förberedelsen. |

### D · Inlärda befogenheter

| | |
| --- | --- |
| **G11** | Ingen delegationsmodell. Se avsnitt 5. |
| **G12** | Ingen scope-typ. Varken belopp eller fastighetsavgränsning finns som begrepp på verktygsnivå. |
| **G13** | `executeTool` läser ingen delegation, och `AiToolExecution` kan inte uttrycka *vilken* auktoritet en körning vilade på — bara `requiredConfirmation: Boolean` + `confirmedAt`. |
| **G14** | Ingen återkallelse och ingen append-only-historik över när en befogenhet gavs, användes eller drogs in. |

### E · Väckning

| | |
| --- | --- |
| **G15** | Ingen agentkö. Bull finns med sex registrerade köer och sex workers; ingen av dem kör en agent. |
| **G16** | Ingen inkommande kanal utom portal-HTTP. Se **F4**. |
| **G17** | Ingen idempotensnyckel per väckning. Bull retryar; en omkörning skapar två ärenden. |

### F · Hyresgästkontakt

| | |
| --- | --- |
| **G18** | Agenten kan inte skriva *till* hyresgästen alls. `compose_and_send_email` är ägarens verktyg och bindande; portalens chatt är rent pull. Ingen återkoppling när ett ärende byter status. |

---

## 4. Vad väcker agenten

Repot har all köinfrastruktur som behövs. Det som saknas är en händelseyta och en
aktör.

### Vad som finns

- **Bull + Redis, sex köer och sex workers.** Mönstret `@Processor` +
  `@Process({ concurrency })` är etablerat i `mail`, `pdf-jobs`, `import`,
  `psd2` och `leases`.
- **26 `@Cron` över tolv filer**, klassificerade och bevakade av
  `check-cron-classification.mjs`.
- **`lease-activation.worker.ts` är den bästa förlagan**: en domänhändelse skapar
  ett jobb, en worker plockar det. Precis den formen en agentväckning behöver.
- **`notifications.service.ts` kör redan AI på cron.** Morning-insights,
  weekly-summary, monthly-report. Det *är* en väckt AI — den anropar bara inga
  verktyg.

### Vad som krävs

1. En `AGENT_QUEUE` med worker. Mönstret finns; det är kopiering, inte design.
2. En **triggeryta** — se tabellen nedan.
3. En **aktörsidentitet** som `executeTool` accepterar (**G1**). Det här är det
   egentliga arbetet och blockerar allt annat.
4. En **idempotensnyckel per väckning** (**G17**). Förlagorna finns:
   `createNumberedEntry` nycklad på `(org, source, sourceId)`, och AI-verifikatens
   nyckel från #581.
5. En **kostnadsgrind före körning**. En agent som väcks av hyresgäster har ingen
   naturlig övre gräns; `checkOrgDailyCostCap` och vilande-org-grinden finns redan.

### Triggerytor

| Källa | Vad som krävs | Bedömning |
| --- | --- | --- |
| **a. Portalens befintliga HTTP-vägar**<br>chatt, felanmälan | Noll ny infrastruktur. Agenten körs på samma anrop, synkront eller lagt i kö. | **Bygg först.** Den enda som är byggbar utan nya beroenden. |
| **b. Systemhändelser**<br>nytt ärende, förfallen avi, avtal löper ut | Ingen event-buss finns — bara direkta tjänsteanrop. Enklaste formen är att lägga ett jobb i kön där händelsen skapas, som `lease-activation` gör. | **Sedan.** Här ligger värdet, men varje trigger är en egen inkoppling. |
| **c. Inkommande e-post eller SMS** | Ny leverantörsintegration. Resend har inbound; det är inte konfigurerat, och inkommande post är en egen säkerhetsyta. | **Inte nu.** Bygg inte förrän a och b bär. |

---

## 5. Agentens yta: hur den avgränsas mekaniskt

Räcker `assertActionToolAuthorized`? **Nej — den svarar på en annan fråga.**
Grinden frågar *"har en människa bekräftat?"*. Agentfrågan är *"får detta ske
utan att någon bekräftar just nu?"*. Det är inte en skärpning av samma kontroll,
det är en annan kontroll.

> **Den starkaste spärren är att verktyget inte finns.** Så är hyresgäst-AI:n
> redan byggd: `TENANT_TOOLS` har åtta verktyg, och `request_termination` skapar
> en *begäran* som ägaren måste godkänna. Modellen kan inte anropa något som inte
> står i `tools`-arrayen — API:t skickar inget `tool_use` för ett okänt namn.
> Allt annat nedan är bevakning av att den egenskapen består. **Ingenting nedan
> rör ägar-AI:ns yta.**

### Konstruktionen, två delar

**Del 1 — `AGENT_TOOLS` är en allowlist, inte `TOOLS` minus en denylist.**
Skillnaden är avgörande: en denylist måste uppdateras när ett nytt verktyg
tillkommer, medan en allowlist ger det nya verktyget noll behörighet tills någon
tar ställning. Den här kodbasen har redan gjort exakt den vändningen en gång, i
`decideAiToolAccess` R4.0 — och skälet som skrevs då gäller ordagrant här.

**Del 2 — en deklarerad `OUTWARD_TOOLS`-klassificering av *varje* verktyg i
`TOOLS`.** Rättelsens axel finns inte i koden och går inte att grepa fram (**F1**,
**G5**). Den måste därför skrivas ut. Formen finns redan som beprövat mönster:
`buildToolCatalog()` i `ai-tools.catalog.ts` **kastar** när ett verktyg saknar
post, i stället för att falla tillbaka tyst — och kommentaren där förklarar varför
(en handhållen kopia glider alltid isär). Klassificeringen ska byggas likadant:
ett nytt verktyg utan art stoppar bygget.

### Vaktens tre regler

| Regel | Mäter | Gräns |
| --- | --- | --- |
| **R1 · namn** | `AGENT_TOOLS ⊆ TOOLS`, och `AGENT_TOOLS ∩ OUTWARD_TOOLS = ∅` utom för poster som står i en uttrycklig, motiverad undantagslista. | Fångar bara det som står skrivet. |
| **R2 · art** | Varje verktyg i `TOOLS` har en deklarerad art (anteckning / handling). En oklassad post fäller. | Klassificeringen är en mänsklig deklaration — vakten kan pröva att den *finns* och är *konsekvent*, inte att den är *sann*. Se kanariefågeln nedan. |
| **R3 · effekt** | Härleder ur `AiToolEffect`-taxonomin vad ett agentverktyg faktiskt rör. Ett agentverktyg vars effekter når en utleverans (mejlkö, export, dokumentleverans) fälls oavsett vad dess art säger. | **Den enda regel som fångar en ny förmåga i ett gammalt verktyg** — och den vilar på att effekttaxonomin är komplett. Är den inte det mäter R3 mindre än den ser ut att mäta, och det ska stå i vaktens huvud. |

R3 är det som gör R2:s deklaration prövbar mot verkligheten: R2 frågar vad någon
skrev, R3 frågar vad koden gör. Faller de isär är det R3 som har rätt.

### Kanariefåglarna — vakten ska ha setts falla

| Injektion | Måste ge | Prövar |
| --- | --- | --- |
| ett utåtriktat verktyg (t.ex. `compose_and_send_email`) läggs i `AGENT_TOOLS` | **RÖTT** | R1 |
| ett nytt verktyg läggs i `TOOLS` utan art | **RÖTT** | R2 |
| ett agentverktyg klassat som anteckning ges en effekt mot mejlkön | **RÖTT** | R3 — och att R3 vinner över R2:s deklaration |
| ett helt nytt verktyg som varken står i allowlist eller klassificering | **RÖTT på R2**, och agenten får det ändå inte | allowlistens fail-closed-egenskap |
| samma verktygsnamn i en *kommentar* respektive i kod | **motsatt utfall** | att vakten läser kod |

> **Den kanariefågel som är lättast att glömma är den sista.** En vakt som läser
> `AGENT_TOOLS`-arrayen med en regex på råtext blir **grön av en hjälpsam
> kommentar** som räknar upp de utåtriktade verktygen — och en sådan kommentar
> *kommer* att skrivas, för den är hjälpsam. Vakten måste gå via `codeMask()` i
> `scripts/lib/source-scan.mjs`; `check-guard-preprocessors.mjs` kräver redan det
> av varje vakt som förbehandlar sin indata.
>
> **Tröskeln, utskriven i förväg:** vakten har ingen numerisk tröskel — den fäller
> på en enda träff. Sonden ska därför injicera exakt ett namn, och det namnet
> måste bevisligen inte redan finnas i filen. Sök på det först.

---

## 6. Datamodell för en inlärd befogenhet

Varken `AiPendingAction` eller `AiMemory` passar. Den första är ett
femminuterskvitto på en bekräftelse som redan skett; den andra är prosa en LLM
skrev. Det här är en ny modell — två, faktiskt.

```prisma
// En delegation = ETT verktyg, med inskränkningar. Aldrig en kategori.
model AiDelegation {
  id               String    @id @default(uuid())
  organizationId   String

  // VEM gav den. Aldrig NULL — en befogenhet utan givare går inte att granska.
  grantedByUserId  String

  // VAD. Verktygsnamnet, exakt. Se motivering (b) nedan.
  toolName         String

  // SCOPE. Varje fält är en INSKRÄNKNING; se (a) och (c).
  propertyScope    String    // "ALL" | "LISTED"
  properties       AiDelegationProperty[]
  maxAmountOre     Int?      // NOT NULL krävs för verktyg som har ett belopp

  // TILLSTÅND
  expiresAt        DateTime?
  revokedAt        DateTime?
  revokedByUserId  String?

  createdAt        DateTime  @default(now())
  events           AiDelegationEvent[]

  @@index([organizationId, toolName, revokedAt])
}

// Kopplingstabell, inte String[] — en lista utan främmande nyckel ruttnar tyst.
// Samma skäl som AiMemoryTenant redan är byggd på.
model AiDelegationProperty {
  delegationId String
  propertyId   String
  @@id([delegationId, propertyId])
}

// Append-only. Ingen updatedAt. Aldrig UPDATE eller DELETE — som InvoiceEvent.
model AiDelegationEvent {
  id           String   @id @default(uuid())
  delegationId String
  type         String   // GRANTED | USED | DENIED | REVOKED | EXPIRED
  actorUserId  String?
  executionId  String?  // AiToolExecution.id när type = USED
  detail       Json?
  createdAt    DateTime @default(now())

  @@index([delegationId, createdAt])
}
```

### De val som bär, och varför

**a · Scope uttrycks som typade inskränkningar, aldrig som en mening.** En
delegation kan inte säga något det inte finns ett fält för. Det som inte har ett
fält kan inte delegeras. Det är fail-closed som egenskap av *formen* — samma
konstruktion som `decideAiToolAccess` redan valde när den vändes till
`default: neka`.

**b · `toolName`, inte en kategori.** En kategori växer när ett verktyg läggs
till. Hyresvärden gav befogenhet över det som fanns när hen gav den — en kategori
tolkas då bredare än den gavs, vilket är precis det som ska undvikas. Priset är
att fem verktyg kräver fem befogenheter. Det är rätt pris.

**c · `propertyScope` är explicit, för NULL är farligt.** Om frånvaro av fastighet
betydde "alla" hade ett tomt formulärfält gett en obegränsad befogenhet. Med
`"ALL" | "LISTED"` måste bredden väljas, och `LISTED` med noll rader är ogiltigt
och ska fällas av en constraint. Samma resonemang gäller `maxAmountOre`: det måste
vara NOT NULL för varje verktyg som *har* ett belopp, vilket kräver en
verktyg→belopp-tabell och en vakt som håller den i takt med
`ai-tools.definition.ts`.

**d · Återkallelse är `revokedAt`, aldrig DELETE.** Frågan "vad fick agenten göra
den 3 mars?" måste gå att besvara. En raderad befogenhet kan inte granskas.
Uppslagningen filtrerar på `revokedAt: null`; raden ligger kvar.

**e · Delegationen kolliderar med en vakt som redan finns.** Regel **R5** i
`check-action-tool-authorization.mjs` säger ordagrant att beviset
(`ActionProof { claimed: true }`) *bara* får produceras av de atomära
anspråksvägarna. En delegation vore en tredje producent, och den vakten kommer att
falla.

> **Låt den falla, och bygg inte förbi den.** Delegationen ska inte producera
> `ActionProof`. Den ska vara en *separat* grind — `assertDelegated(...)` bredvid
> `assertActionToolAuthorized(...)` — så att R5 står orörd. "En människa bekräftade
> nyss" och "en människa delegerade detta i förväg" är olika påståenden och får
> inte kunna förväxlas i samma typ.

**f · Revisionsspåret kan inte uttrycka två auktoritetsvägar.**
`AiToolExecution` har `requiredConfirmation: Boolean` och `confirmedAt: DateTime?`.
En delegerad körning *krävde* bekräftelse och *fick* den aldrig — att lämna
`confirmedAt: null` gör den oskiljbar från ett fel. Det behövs ett fält som pekar
ut auktoriteten (`delegationId`, eller ett `authorityKind`). Det är ett schemabyte
i en tabell som är `onDelete: Restrict` av revisionsskäl — planera det, upptäck det
inte.

**g · En utåtriktad handling kan inte delegeras genom att kryssa i en ruta — och
det får inte vara en `if` i uppslagningen.** En kontroll som ligger i
delegationsvägen skyddar bara delegationsvägen. Avgränsningen måste hållas av att
verktyget inte finns i agentens yta överhuvudtaget. Se avsnitt 5.

---

## 7. Hur vi mäter att den fungerar

Tre klasser, för de mäts olika. Klass B är den svåra, och den har inget facit.

### Klass A · Det som har ett rätt svar

Mät hårt, med guldmängd. Förlagan finns: `knowledge:eval` för juridik-RAG körs
redan med preflight på API-nycklar.

- **Klassificering.** Är det en felanmälan eller en faktafråga? Vilken prioritet
  — `URGENT/HIGH/NORMAL/LOW`? Facit finns; mät exakt matchning på riktiga svenska
  hyresgästformuleringar.
- **Verktygsval.** Anropade den `get_my_lease` när frågan gällde hyran? Facit
  finns.
- **Prompt-injection.** `tenant-ai-jailbreak.spec.ts` och
  `owner-ai-injection.spec.ts` finns som förlagor.
- **Avgränsningen: 100 %, inte en procentsats.** En prompt som ber agenten skicka
  en uppsägning eller ett kravbrev måste ge noll utåtriktade anrop. Det mäts
  *inte* statistiskt — det mäts av att verktyget inte finns och av vakten i
  avsnitt 5. Mäter man det som en andel har man byggt fel sak.

### Klass B · Text till en människa

Här finns inget rätt svar att jämföra strängar mot. Tre saker går ändå att mäta,
i fallande styrka:

1. **Negativa invarianter — starkast, och de enda som är hårda.** Svaret får inte
   innehålla ett SFS-nummer eller en paragraf (regeln finns redan i CLAUDE.md;
   `ai-prompt-juridik.spec.ts` vaktar den), ett exakt belopp som inte kommer ur ett
   verktygssvar, ett löfte i första person på hyresvärdens vägnar, eller ett datum
   som inte kommer ur data. **De fångar det som skadar. De säger ingenting om
   huruvida svaret var bra.**
2. **Grundning.** Varje faktapåstående ska gå att härleda till ett verktygsresultat
   i samma tur. `ai-grounded-citation.spec.ts` (504 rader) är förlagan. Det är det
   närmaste ett rätt svar man kommer.
3. **LLM-domare — svagast, och kodbasen har redan mätt varför.** Domaren flakar
   vid temperatur 0. Den kan rangordna två svar mot varandra bättre än den kan
   sätta ett absolut betyg. Använd den för regressionsjämförelse — *blev det sämre
   efter promptändringen?* — aldrig som en godkänd/underkänd-grind.

> **Vad som inte går att mäta innan en riktig hyresgäst möter den:**
>
> - **Om tonen fungerar för en upprörd människa.** Alla testfall är skrivna av
>   dig, och du är inte arg på dig själv.
> - **Om agenten stannar på rätt ställe.** Att den stannade i fyrtio fall säger
>   ingenting om det fyrtioförsta, för det svåra är det du inte tänkte på. Det är
>   hela skälet till att avgränsningen ska vara mekanisk och inte mätt.
> - **Vad hyresgästen gör efter svaret.** Löste det problemet, eller ringde de
>   ändå? Det är utfallsmåttet, och det finns bara i produktion.
> - **Om svaret var juridiskt korrekt.** Bara en människa kan avgöra det. En
>   juridisk mätning där en LLM satt facit är inte en mätning.

### Klass C · Skuggkörning

Det starkaste som finns före en riktig hyresgäst: kör agenten mot **riktiga
inkommande portalmeddelanden men leverera ingenting**. Spara vad den skulle ha
gjort och låt hyresvärden godkänna eller avvisa varje förslag.

Det ger tre saker på en gång: ett facit skrivet av rätt person, frekvensdata på
hur ofta den vill göra fel sak, och noll risk. Och det bästa:

> **Skuggläget är inte extra arbete.** Det är godkännandekön med allt satt till
> "kräver godkännande". Samma kö, samma UI, samma notis. Bygger du skuggläget har
> du byggt godkännandekön, och en befogenhet (avsnitt 6) är sedan bara att flytta
> ett verktyg från "alltid godkännande" till "godkänd i förväg inom detta scope".
> Hela modellen faller ut ur en mekanism.

---

## 8. Första leveransen

En hel sak, inte fem halva.

> ### Felanmälan går själv, i portalen.
>
> Ta `create_maintenance_ticket` ur `TENANT_ACTION_TOOLS` och låt hyresgäst-AI:n
> lägga upp ärendet direkt — med följdfrågor när underlaget är tunt, en
> allvarsbedömning, och en kvittens som säger vad som faktiskt händer sedan.

### Varför just den

- **Den är hela vägen.** Hyresgästen skriver → agenten frågar vad som saknas →
  bedömer prioritet → skapar ärendet → svarar vad som händer → hyresvärden får
  notis. Ingen halv del.
- **Den kräver ingen ny infrastruktur.** Ingen kö, ingen aktörsidentitet, ingen
  delegation, ingen väckning. Vägen finns, verktyget finns, notisen finns
  (`createForAllOrgUsers` med `MAINTENANCE_NEW`), kostnadstaket finns.
- **Den är en ren anteckning.** Inget lämnar huset. Ett felaktigt ärende är en rad
  att stänga, inte ett brev som gått ut.
- **Den går att köra utan tillsyn.** Ett ärende för mycket kostar en minut, inte
  en tvist.
- **Den tar inte bort någon förmåga från någon.** Ägar-AI:n är orörd.

### Vad som ändå måste byggas — det är inte noll

| # | Arbete | Varför |
| --- | --- | --- |
| 1 | Dedup-/idempotensnyckel på ärendeskapandet, t.ex. `(tenantId, normaliserad titel, 24 h)`. | I dag är det bekräftelseklicket som hindrar dubbletter. Tas det bort skapar ett omtaget meddelande två ärenden. |
| 2 | Loopen i `tenant-ai.service.ts` måste kunna ta emot `tool_result` från ett *skrivande* verktyg. | I dag returnerar den vid `actionBlock` (rad 180–222) och kör aldrig vidare. **Den enda riktiga kodändringen i loopen.** |
| 3 | Följdfrågor innan ärendet skapas. | Modellen ska inte skapa ett ärende på "det läcker". Promptändring plus skärpta krav i schemat — minimilängderna finns redan i executorn (`tenant-tool-executor.service.ts:353`). |
| 4 | Kvittens som säger vad som händer utan att lova något. | `ticketNumber` returneras redan. Formuleringen är gränsen mot "lova på hyresvärdens vägnar". |
| 5 | Systemprompten måste sluta lova bekräftelse. | Den säger i dag "kräver bekräftelse i UI" för `create_maintenance_ticket`. Stämmer det inte längre ljuger prompten för modellen. |
| 6 | `request_termination` stannar i `TENANT_ACTION_TOOLS` — men av rätt skäl. | **Inte** för att uppsägning är ett förbjudet ämne (se avsnitt 0). Utan för att verktyget skriver ner hyresgästens egen viljeförklaring, och den ska hyresgästen bekräfta att den stämmer innan den registreras. Ärendet går sedan inåt till hyresvärden — ingenting lämnar huset. |
| 7 | Mätning per avsnitt 7 före påslag: klass A på routing och prioritet, klass B negativa invarianter, klass C skuggläge i en org. | Skuggläget kör den nya vägen parallellt med den gamla och jämför. Det är också första halvan av godkännandekön. |

### Vad den uttryckligen inte är

Den skickar ingen e-post, bokar ingen hantverkare, lär sig ingen befogenhet och
väcks inte av något. Alla fyra är nästa steg, och alla fyra kräver det som avsnitt
4 och 6 beskriver.

---

## 9. Vad som blir svårt

Ordnat efter hur mycket det kostar att upptäcka sent.

### 9.1 Godkännandekön är den svåra delen — inte agentens första steg och inte avgränsningen.

Första leveransen är en promptändring och en dedupnyckel. Avgränsningen är att
inte ge agenten verktyget. Godkännandekön kräver en persistent kö, ett UI som inte
finns, en notifieringsväg — och värst: **en åtgärd förbereddes mot ett tillstånd
som kan ha ändrats innan den godkändes.** Ett förberett påminnelseutskick som
godkänns tre dagar senare kan gälla en avi som betalats under tiden.
`PaymentFreshnessModule` finns för precis den felklassen i kravtrappan; agentkön
behöver samma sorts färskhetsgrind, och den måste omvärderas *vid godkännandet*,
inte vid förberedelsen.

### 9.2 Delegationen tvingar fram ett schemabyte i en revisionslogg.

Två auktoritetsvägar in i `executeTool` betyder att `AiToolExecution` måste kunna
säga vilken — och den kan inte det i dag. Tabellen är `onDelete: Restrict` av
bokföringsskäl. Det är hanterbart, men det är en migration i ett revisionsspår,
inte ett fält till.

### 9.3 Hyresgästen är en motpart, och nu driver hens fritext verktygsanrop utan människa i loopen.

`<HYRESGAST_MEDDELANDE>`-inramningen är prosaförsvar. Det som *faktiskt* håller är
att hyresgästverktygen är självscopade i exekveraren — de tar inga
`organizationId`- eller `tenantId`-parametrar från modellen. **Den egenskapen måste
bevakas** när agenten får fler verktyg: ett enda verktyg som tar ett id från
modellen bryter den, och det syns inte i något test som handlar om AI.

### 9.4 Det finns redan en autonom kravtrappa. Agenten kan hamna i vägen för den.

`rent-reminder.service.ts` kör cron 10:00 och 11:00. En agent som "skickar
påminnelse" kan dubbla den. Och `pause_reminders`/`resume_reminders` finns som
verktyg — alltså kan en agent *pausa kravtrappan*. Att
`pausa\s+(alla\s+)?påminnelser` redan står som misstänkt mönster i
`OWNER_INJECTION_PATTERN` visar att någon tänkt tanken. Agenten ska inte ha de
verktygen. Ägar-AI:n behåller dem.

### 9.5 "Bedöma allvar" är ett juridiskt gränsland i förklädnad.

Prioritet `URGENT` på ett vattenläckage är en teknisk bedömning. Men *"är det här
hyresvärdens ansvar eller mitt eget?"* är en avtalstolkning — och den kommer att
ställas i samma mening som felanmälan. Agenten måste kunna skapa ärendet **utan att
svara på den frågan**, och prompten måste säga det uttryckligen, för modellen
svarar gärna.

### 9.6 Prosaförsvar där man tror man har mekanik.

Hyresgäst-AI:ns systemprompt innehåller redan en uppräkning av vad den aldrig får
göra. Den fungerar i dag därför att verktygen saknas, inte därför att prompten
säger det. Läggs ett verktyg till senare och någon tänker *"prompten säger ju nej"*
är spärren borta utan att något blivit rött. Vakten i avsnitt 5 finns enbart för
att göra den skillnaden synlig.

### 9.7 Det som inte efterfrågades men behövs: en av-knapp per organisation.

En agent som svarar fel för en hyresvärd måste kunna stängas av utan deploy.
`AiQuotaService` har tak; det finns inget "av". Bygg det i samma PR som första
leveransen — det är billigt nu och dyrt klockan tre på natten.

---

*Mätt mot `050c085` · 2026-08-29 · Ingen kod skriven. Filreferenser och radnummer
är exakta vid mättillfället. Trenivåmodellen i avsnitt 0 ersätter den
ämnesbaserade indelning som fanns i det ursprungliga uppdraget.*
