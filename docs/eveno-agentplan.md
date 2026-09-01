# EVENO — Masterplan för den agentiska plattformen

*Sammanslagen version. Ersätter både den tidigare planen och masterplansutkastet — det
finns ingen version där båda gäller.*

> **Mätunderlag:** [`docs/agent-hyresgastagenten.md`](./agent-hyresgastagenten.md) bär
> den detaljerade kodmätningen som den här planen vilar på. Den är underlag, inte plan —
> **vid motstridighet gäller det här dokumentet.** Underlaget bär en not överst som
> räknar upp de påståenden verifieringen 2026-08-30 upphävde.

---

## Kontext

Eveno är byggt som ett förvaltningssystem: en människa loggar in och utför uppgifter.
Kärnvisionen är en annan — hyresvärden ska inte ha uppgifter alls, bara några få beslut.
Hyresvärdar är bra på att se värden andra missar och göra affärer; det administrativa
vill de inte röra. Det som förstör deras arbetsdag är inte antalet timmar utan antalet
**avbrott**.

Beslutet (2026-08-29): den agentiska delen byggs **före** bolagsregistrering och
lansering. Skälet är mekaniskt — en agent kräver ändringar i aktörsmodellen,
behörighetsmodellen och spårbarheten, alltså i botten. Att göra det medan prod är tom
kostar veckor; att göra det med riktiga hyresvärdars pengar i systemet kostar månader och
innebär risk för deras data.

Det här ska inte bli "ett fastighetssystem med AI". Det ska bli en digital
fastighetsförvaltare som arbetar åt hyresvärden — med mänsklig kontroll, full
spårbarhet, deterministiskt utförande, explicit delegation, återkallelig behörighet,
persistent tillstånd, historik, minne, ångra där det går, ett fungerande manuellt läge,
och mekaniska skydd som går att få att falla.

### Källor och deras styrka

| Ursprung | Status |
| --- | --- |
| `docs/agent-hyresgastagenten.md` — 693 rader (varav 28 raders not, tillagd 2026-08-30), mätt mot `050c085` | mätt i kod, med filreferenser |
| Rapporter från sessionen 2026-08-29 | mätta, andrahand |
| Allt märkt FÖRSLAG | design, inte mätning |

**Verifierad 2026-08-30 mot `050c085`.** `git log 050c085..HEAD -- apps/api/src/ai/` är
tomt — planens rader mättes mot exakt den kod som verifierades. Avvikelserna nedan var
alltså **fel redan när de skrevs**, inte drift. Det är en viktigare sorts fel: en
mätning som var osann från början rättas inte av att man mäter om samma dag.

Gissa aldrig att en funktion finns. Gissa aldrig att den saknas. Gissa aldrig att en
tidigare commit löste problemet.

### Rättade vid verifieringen 2026-08-30

| Påstods | Gäller |
| --- | --- |
| "två av sex utåtriktade verktyg" | **fem**, inte sex — den femte är `send_document_to_tenant` (`:2723`), som saknades i prosan men fanns i planens egen tabell |
| `ACTION_TOOLS` = 28 | **30** |
| "60+ ägarverktyg" | **56** (körd i runtime, inte regexad) |
| "sex köer och sex workers" | **7 köer, 6 worker-filer, 7 `@Processor`** (`mail.worker.ts` bär tre) |
| "26 `@Cron` över tolv filer" | **25 över 14 filer** |
| "R5 kommer att falla på en delegation" | **Faller inte** — se Del 6 |
| (nämndes inte) `AiToolExecution`-gallring | **differentierad 730/365/90 dagar** — se Del 7 |

Allt övrigt stämde exakt, radnummer inkluderat.

**En observation om dokumentet självt:** prosan sa sex, tabellen fem. Det är samma
"uppräkning som krymper tyst" som planen varnar för — inuti planen. Härledda tal ska stå
på ett ställe.

### Sex rättelser mot masterplansutkastet

Utkastet var starkare på deklarationer och mätvärden, den tidigare planen på ordning och
klart-kriterier. Vid sammanslagningen rättades sex saker — de står här så att ingen
letar efter dem i den gamla texten:

1. **Ordningen motsade sig själv** (historiken som steg 7 respektive "först"). Löst i
   Del 3 med ett skäl, inte ett val.
2. **Exemplet lät agenten bokföra en betalning.** Rättat i Del 11 och avgränsat i
   Del 9 — agenten läser betalstatus, den skriver den inte.
3. **Retry-regeln fanns som test men inte som invariant.** Nu invariant i Del 4.
4. **Regel 5 saknade mekanism.** Nu en atomär omprövning i Del 12.
5. **Ingenting om vad agenten kostar.** Ny Del 13 om `AiQuotaService`.
6. **Persondata i minnet saknade gallring.** Nu i Del 7.

---

## Del 1 — Målet och måtten

**Hyresvärden ska lägga minuter per vecka på Eveno, inte timmar.**

Framgång mäts inte i hur imponerande AI:n låter. Fem tal:

1. Minuter per vecka som hyresvärden behöver använda Eveno.
2. Andel hyresgästärenden agenten avslutar utan mänsklig handpåläggning.
3. Antal avbrott per vecka utanför den samlade genomgången.
4. Antal frågor agenten behöver ställa innan ett ärende kan avslutas.
5. Antal agentåtgärder som krävde mänsklig korrigering.

Tal 3 glöms oftast. **En agent som utför mycket arbete men stör tio gånger om dagen har
misslyckats.** Tal 4 och 5 är de som avslöjar en agent som ser bra ut men inte är det.

---

## Del 2 — Den absoluta regeln: agenten är additiv

En arkitekturell invariant, inte en ambition. Agenten får aldrig göra systemet sämre för
människan.

**Regel 1.** Ingen befintlig sida, knapp, funktion eller manuell arbetsväg får försvinna,
döljas eller ersättas.

**Regel 2.** Varje förmåga agenten får måste ha en motsvarande mänsklig väg. Kan agenten
göra något människan inte kan göra i gränssnittet har implementationen brutit mot
arkitekturen.

**Regel 3.** Eveno måste fungera fullt ut med agenten avstängd. **Agent OFF är ett
förstklassigt produktläge** — inga trasiga vyer, inga saknade knappar, inga blockerade
manuella processer, inga funktioner som bara fungerar genom agenten.

**Regel 4.** Inkorgen ersätter inte dashboarden. Den är en ny arbetsyta bredvid. Vilken
vy som öppnas efter inloggning väljer hyresvärden själv.

**Regel 5.** Agenten får aldrig blockera människan. Gör hyresvärden samma sak manuellt
medan ett agentuppdrag väntar ska uppdraget hanteras utan dubbel effekt — se mekanismen i
Del 12.

Skälet är inte försiktighet. En hyresvärd som inte kan gå förbi maskinen sitter fast i
den, och ett system man inte kan gå förbi är ett system man inte litar på.

---

## Del 3 — Byggordningen

Bygg inte UI först. Bygg först de mekanismer som gör agenten säker.

**Historiken ligger först — och det är ingen avvägning mot Execution Truth.** Historiken
är inte agentarbete. Den är en läsfunktion med full nytta för en människa med agenten
avstängd, alltså ett rent bygge av Regel 3, och den är underlaget varje senare agent
läser. Bygger vi agenten först får den gissa om saker som redan står i databasen.

| Etapp | Innehåll | Blockerad av | Klar när |
| --- | --- | --- | --- |
| 0 | Minnets form — `MEMORY.md` laddas bara delvis (utreds separat) | — | mätt gräns, 1:1-integritet bevisad med sond |
| 1 | **Historiken** — händelser + luckor, hyresgäst/objekt/fastighet | — | full nytta utan agent; registervakten har setts falla |
| 1b | Datamodell för utrustning och byten i en lägenhet | 1 | "vad byttes och när" går att svara på |
| 2 | **G0 Execution Truth** — återupptagning, samtidighet, identitet för fler än 2 verktyg | — | de sju G0-proven gröna mot riktig Postgres, inkl. den fällda regressionen |
| 2b | **R5:s omfång** — formbaserat svep + kanariefågel på mängden | — | en injicerad sond utanför de två hårdkodade filerna fäller vakten |
| 3 | **G1 Aktörsmodell** | G0 | en agent kan skriva utan att låtsas vara en människa |
| 4 | G4 spår + G3 persistent uppdragskö — spåret är samma flöde som historiken | G0, G1, 1 | uppdrag från 03:00 finns 09:00 och syns i historiken |
| 5 | Tool Catalog + allowlist + delmängdsregel + vakter | G1 | katalogen kastar; vakterna har setts falla |
| 6 | **Inkorgen** (vy + API) och **shadow mode** på felanmälan | 1–5 | den föreslår rätt i verkliga fall utan att göra något |
| 7 | G2 delegationer + "Gör alltid detta" + preferenser | 6 | hyresvärden kan delegera och se vad systemet tror om hen |
| 8 | Agentens frågor + observationslager + delegationsförslag | 7 | den frågar innan du frågar, och föreslår i stället för att ta sig rätt |
| 9 | Agent 1 skarp på felanmälan | 8 | ärenden avslutas utan att hyresvärden rört dem |
| 10 | Hantverkarmodell → bokningsflöde | 9 | `assignedToId` är en riktig relation |
| 11+ | Agent 2–5 | 9 | var och en enligt samma etappform |

Parallellt och oberoende: backup-token, BankID, PSD2, juridisk slutgenomgång.

**Vad verifieringen gjorde med etapperna:**

**Etapp 2 blev större**, av tre skäl. Invariant 1 finns redan, men (a) automatisk
återupptagning finns inte och är avsiktligt bortvald — agenten behöver antingen en egen
anspråksmodell eller innehållsidempotens; (b) den egenskapen har idag **2 av 30** verktyg;
<!-- (b) RÄTTAT 2026-09-01, se mätningen längre ner: 16 av 30 tål en omkörning redan. -->
(c) `createNumberedEntry` är inte TOCTOU-säker som kommentaren påstår, och ett samtidigt
omförsök ger ett kastat `P2002` i stället för det första verifikatet. `isIdempotencyRaceConflict`
finns redan och gör rätt sak — den är bara inte inkopplad i den generella vägen.

> **ÅTGÄRDAT i Etapp 2 (G0).** (c) är löst: kommentaren rättad, igenkänningen inkopplad i
> `createNumberedEntry`, bevisad mot riktig Postgres i
> `numbered-entry-race.concurrency.spec.ts`. (a) och (b) står kvar — de hör till gaffeln.

**Etapp 5 blev större.** Den räknade med R5 som en befintlig spärr. Se 2b.

**Etapp 9 blev mindre än planen antydde** — vägarna finns, `create_maintenance_ticket` är
ett av bara två skrivande hyresgästverktyg (`tenant-tool-executor.service.ts:380`, det
andra är `request_termination` på `:448`), och `TENANT_TOOLS` är 8 verktyg varav sex rena
läsningar. Men "bedöm allvar" landar i `OTHER` tills klagomålsfrågan är avgjord.

---

## Del 4 — G0: Execution Truth

Den viktigaste säkerhetsprincipen. **Tre saker som aldrig får förväxlas:**

| | Betyder | Bevisar |
| --- | --- | --- |
| **Intent** | agenten vill göra något | ingenting |
| **Approval / claim** | människan har gett rätten | att det *fick* göras |
| **Execution** | systemet gjorde det | **att det gjordes** |

Det förbjudna tillståndet, som revisionen faktiskt hittade:

```
claim förbrukat  +  ingen execution  +  svaret "redan utförd"
```

Det är en lögn systemet berättar för hyresvärden om hens egna pengar.

### Invariant 1 — vad som får kallas utfört

En agentåtgärd får klassificeras som utförd **endast** om det finns ett verifierbart
execution-spår, eller ett domänbevis som implementationen uttryckligen definierar som
execution truth. Approval, claim eller pending action räcker aldrig — var för sig eller
tillsammans.

### Invariant 2 — retry får inte låsas ute

| Läge | Svar | Får försöka igen? |
| --- | --- | --- |
| Execution finns bevisligen | "redan utförd" | Nej — och ingen andraeffekt |
| Execution saknas | "utförandet kan inte bekräftas" | **Ja** |

Ett förbrukat claim utan execution får **inte låsa** hyresvärden. Att bara göra
meddelandet ärligt räcker inte — vägen framåt måste vara öppen, annars blir resultatet av
en krasch att en godkänd åtgärd blir omöjlig att genomföra. *Detta är en invariant, inte
bara ett testfall: ett test utan invariant bakom sig raderas den dag det är i vägen.*

### Execution identity

Varje skrivande AI-verktyg ska ha en deterministisk identitet:

```
samma åtgärd        → samma identitet
olika åtgärd        → olika identitet
omförsök            → samma identitet
samtidigt omförsök  → samma identitet
```

Den får inte vara slumpmässig och inte komma från klienten. **Garantin ska ligga i
databasen** — `SELECT` följt av `INSERT` räcker inte när två workers kör samtidigt.

*Mätt och redan avgjort (#581):* `ai:<pendingActionId>` **duger inte** — ett omförsök får
ett nytt pendingActionId och bryter mot rad tre. Vald identitet blev
`ai:<innehållshash>`. Ta inte om den utredningen, men pröva identiteten mot alla fyra
raderna och redovisa eventuella brister.

**Återanvänd, duplicera inte.** `AiToolExecution` finns. En andra execution-tabell byggs
bara vid konkret tekniskt behov — annars finns två sanningar om samma sak, vilket är
precis hur execution truth går förlorad igen.

### Uppmätt status 2026-08-30

**Invariant 1 — FINNS.** `ai-assistant.service.ts:974–999`. Frågan ställs på
`aiToolExecution.findFirst({ conversationId, toolName, confirmedAt: { not: null } })`, och
saknas raden kastas en egen `ConflictException` (`:993`) med orden *"det går INTE att
bekräfta att åtgärden utfördes"*. "Redan utförd" (`:1000`) nås bara när raden finns.
Bevakad av `check-ai-journal-source.mjs` R3 (i `ci-passed`:s `needs`), testad i
`ai-confirm-crash-honesty.spec.ts:74–108`.

**Invariant 2 — FALSK, men inte på det sätt planen påstod.** Anspråket återställs
medvetet inte (`:986`: *"ANSPRÅKET ÅTERSTÄLLS INTE"*), och ett test naglar fast beteendet
(`ai-confirm-crash-honesty.spec.ts:99`). Men **"låses ute" var för starkt**: användaren är
låst ur *anspråket*, inte ur *åtgärden*. `consumePendingAction` slår upp med
`orderBy: { createdAt: 'desc' }` (`:1240`) utan `consumedAt` i villkoret, så ett nytt
förslag ger en ny rad som vinner uppslaget. Vägen framåt är alltså: be assistenten
föreslå igen.

**Och det är precis där agenten går sönder.** För en människa i chatten är "föreslå igen"
en väg. **Klockan 03:00 finns ingen som ber om ett nytt förslag.** Automatisk
återupptagning finns inte och är avsiktligt bortvald. Antingen behöver agenten en egen
anspråksmodell, eller så måste det som återupptas vara idempotent på innehåll.

**Identiteten stämmer.** `ai-journal-source.ts` ger
`ai:<sha256 av kanonisk JSON av {toolName, toolInput}>`. Krav 1–3 är uppfyllda och
testade (`ai-journal-idempotens.db.spec.ts` A1/A2).

> **RÄTTAT 2026-09-01 — "2 av 30" var fel, och för pessimistiskt.**
>
> Här stod att egenskapen *"täcker 2 av 30 verktyg"*, med modulens egen avgränsning som
> källa: *"de andra 27 effektproducerande verktygen har fortfarande ingen
> idempotensnyckel"*. Den meningen skrevs om verifikatnyckeln och lästes som ett
> påstående om alla verktyg. En mätning verktyg för verktyg mot koden ger:
>
> | | |
> |---|---|
> | tål en omkörning redan i dag | **16 av 30** |
> | — via `aiJournalSourceId` | 2 (`create_journal_entry`, `record_expense`) |
> | — via en EGEN innehållshash | 1 (`prepare_contract_signing`: `sha256(documentId + contentHash)`, atomär dedup mot `SigningRequest @@unique([organizationId, idempotencyKey])`) |
> | — via unika index och statusmaskiner | 13 |
> | deduplicerbara men utan spår | **14** (varav `send_invoice_email` har en nyckel som dedupar inom köns fönster) |
> | oåterkalleliga OCH omöjliga att avduplicera | **0** |
>
> Egenskapen var alltså **utbredd men odeklarerad** — och det var den verkliga bristen:
> ingenting i koden sa vilken klass ett verktyg tillhör, så en återupptagningsmotor hade
> ingen att fråga. Klassificeringen finns nu i `apps/api/src/ai/tools/effect-idempotency.ts`,
> härledd och prövad av `check-effect-idempotency.mjs`. Talen ovan är HÄRLEDDA i
> `effect-idempotency.spec.ts` — ändras klassningen blir den raden röd, inte den här tabellen.
>
> Nollan sist gäller bara inom spårets livslängd: mejlens dedup bor i Bulls `jobId` med
> `removeOnComplete: { age: 7 dygn, count: 1000 }`, och **`count`-taket biter före
> ålderstaket**. Sker återupptagningen efter fönstret degraderar mejlverktygen i praktiken
> till oåterkalleliga.

**Krav 4 håller inte, och kommentaren i koden är fel.** `createNumberedEntry`
(`accounting.service.ts:402–443`) gör `findFirst` följt av `create` inuti transaktionen,
med kommentaren *"TOCTOU-säkert"* (`:404–405`). Mätt mot riktig Postgres, två samtidiga
transaktioner med samma nyckel:

```
T1 ser 0 rader · T2 ser 0 rader
T2: ERROR: duplicate key value violates unique constraint
slutligt antal rader: 1
```

Utfallet är rätt — men det är **indexet** som räddar det, inte att kontrollen ligger i
transaktionen. En läsning som inte hittar någon rad låser ingenting. Följden: den andra
anroparen får ett kastat `P2002` i stället för det första verifikatet tillbaka. En agent
som gör automatiskt omförsök träffar det. `isIdempotencyRaceConflict`
(`accounting.service.ts:95`) fångar exakt det felet men är bara inkopplad i
`reverseJournalEntry` (`:2851`), inte i den generella vägen.

> **ÅTGÄRDAT i Etapp 2 (G0).** Mätningen ovan beskriver läget 2026-08-30. Kommentaren är
> rättad till vad koden gör, och igenkänningen är inkopplad i den generella vägen.
> Uppslaget ligger UTANFÖR transaktionen — en `P2002` poison:ar den (`25P02`) — och en
> inskickad `tx` återhämtas medvetet INTE: kollisionen ska rulla tillbaka anroparens hela
> transaktion.

**Unikt index — finns i både schema och drift.** `schema.prisma:1685`
(`@@unique([organizationId, source, sourceId])`); live som
`JournalEntry_organizationId_source_sourceId_key`. Ingen AI-väg kan skriva
`sourceId = NULL`: `check-ai-journal-source.mjs` R1 kräver att varje
`journalEntry.create/createMany/upsert` sätter `sourceId` — regeln är på **formen**, inte
en uppräkning av kända skrivare, och självtestet har kanariefåglar åt båda hållen.

---

## Del 5 — G1: Aktörsmodellen

Idag utgår varje skrivväg från en mänsklig användare (`userId` + `userRole`). En
agentaktör ska kunna uttrycka fyra saker samtidigt:

```
VEM            → agenten
FÖR VEMS RÄKNING → människa / organisation
MED VILKEN RÄTT  → delegation eller approval
INOM VILKEN GRÄNS → organisationen
```

**En skrivning ska inte kunna representeras som gjord av en agent utan att det samtidigt
går att uttrycka varför agenten hade rätt att göra den.** Grunden är inte metadata — den
är en del av att skrivningen alls går att formulera.

Återanvänd `@OrgId()`, `@CurrentUser()` och `JwtPayload` där det är korrekt. Skapa inte
parallella identitetsmekanismer utan skäl.

### G3 — Uppdrag som överlever natten

Något förberett kl 03:00 ska finnas kl 09:00. `AiPendingAction` duger inte, och alla tre
skälen är **verifierade 2026-08-30**:

- `PENDING_ACTION_TTL_MS = 5 * 60 * 1000` (`ai-assistant.service.ts:492`)
- bunden till `conversationId` + `organizationId` + `userId` + `toolName` +
  `toolInputHash` (`:1200–1206`, uppslag `:1239`)
- bara hashen lagras — `schema.prisma:2518–2520` säger uttryckligen att inputen finns i
  AI-meddelandet och **skickas av klienten**

En agent har ingen klient och ingen konversation. Uppdraget behöver full input på
servern, ingen kort TTL, ingen konversationsbindning, och en tidsgräns som är ett
*beslut* — inte en teknisk artefakt.

### G4 — Spår och ångra

Varje åtgärd loggas med vad den gjorde, vad den byggde det på, hur säker den var, och hur
den backas. `AiToolExecution` återanvänds, dupliceras inte — två sanningar om samma sak är
precis hur execution truth går förlorad. Spåret och historiken (Del 8) byggs som **en
sak**: det är samma flöde, med aktören utskriven.

### G5 — Väckning

*Mätt om 2026-08-30:* **7 registrerade köer** (`CONTRACT_SCAN_BATCH`, `LEASE_ACTIVATION`,
`QUEUE_HIGH/NORMAL/LOW`, `QUEUE_PDF`, `PSD2_SYNC`), **6 worker-filer med 7
`@Processor`-klasser** (`mail.worker.ts` bär tre: `:195`, `:213`, `:231`), och **25
`@Cron` över 14 filer**. `lease-activation.worker.ts` (126 rader) är rätt förlaga:
`@Processor` + `@Process({ concurrency: 3 })` + `onFailed`. `notifications.service.ts` kör
bekräftat AI på cron (`AiAssistantService` via `moduleRef`, `:128–129`; jobben på `:406`,
`:533`, `:648`).

**Ingen inkommande meddelandekanal från hyresgäst utom portalens HTTP.**
`MessagesModule` har fyra endpoints, alla operatörssidiga — enkelriktat utgående.
`WebhooksModule` har exakt en publik POST (`resend-webhook.controller.ts:22`). Ingen
inkommande e-postparsning.

*Nyansering:* det finns 31 `@Public()`-ytor, varav två är hyresgästinitierade utan
portalsession — `signing.controller.ts` och `tracking.controller.ts`. Ingen är en
meddelandekanal, men "bara portalens HTTP" är något för snävt formulerat.

Börja i portalens befintliga HTTP-väg: noll ny infrastruktur. E-post in och SMS in är egna
arbeten, senare.

---

## Del 6 — G2: Delegation, och gränsen mot observation

### Delegationen

`AiDelegation` + `AiDelegationEvent` (append-only, samma triggerskydd som de åtta
tabellerna i #585). Den ska vara organisationsbunden, **verktygsbunden**, synlig,
återkallelig, tidsbegränsningsbar, och kunna avgränsas till fastighet/objekt och belopp.

Scope är **ett verktygsnamn**, aldrig en kategori:

```
approve_vendor_invoice     ✔
money_operations           ✗
```

Återkallelse är en händelse, inte en radering — historiken måste kunna bevisa att
delegationen existerade.

### R5 faller inte — vakten är blind för ny kod

Planen påstod att en delegationsgrind skulle fälla R5 i
`check-action-tool-authorization.mjs`. **Det är falskt, och mätt.**

Regeln (`:147–164`) prövar bara filer i `otherFiles` — en **hårdkodad lista om två filer**
(`:326`): `ai-assistant.service.ts` och `tenant-ai.service.ts`. En ny delegationsmodul
ligger inte i den mängden och prövas aldrig.

Negativkontroll, med sondnamnet `AiDelegationService` grepat först (0 träffar i repot):

```
sond på disk, vakten körd normalt      →  GRÖN, exit 0
samma filinnehåll matat in i evaluate()  →  1 brott
   ❌ skapar ett bevis utan ett atomärt anspråk
```

Sonden är alltså stark; **omfånget är blint**. Vakten har en kanariefågel för exekverare
(`:101`, *"NOLL exekverare lästes"*) men **ingen för `otherFiles`** — parametern defaultar
till `[]`, och R5 mäter då ingenting utan att bli röd.

Två följder:

1. **Rådet i sak står kvar:** delegationen ska inte producera `ActionProof` utan vara en
   separat `assertDelegated`. Två producenter av samma bevis är hur en spärr blir otydlig.
   Men rådet vilade på en spärr som inte finns — det var en förhoppning, inte en vakt.
2. **R5:s omfång måste bli formbaserat med en egen kanariefågel innan agentvakterna
   byggs**, annars ärver de samma blindhet. Billigt nu, dyrt sedan. Notera dessutom att
   R5 är en *filnivå-samförekomst*: en delegationstjänst som av egna skäl råkar göra
   `updateMany` med `count === 1` passerar även om den vore i mängden.

**Aldrig delegerbart:** allt klassat som utåtriktat (Del 9).

### Observation är inte behörighet

Detta är den kritiska säkerhetsgränsen i hela bygget.

Eveno får observera: *"hyresvärden godkände 7 av 7 rörmokarbokningar under 2 000 kr."*
Det får **aldrig** automatiskt bli: *"agenten får boka rörmokare upp till 2 000 kr."*

Vägen är: observation → **förslag** → mänskligt tryck → delegation.

> "Du har godkänt det här sju gånger. Vill du att jag gör det automatiskt framöver?"

Först när människan trycker **"Gör alltid detta"** får en delegation skapas.

**Mekaniskt skydd:** `executeTool` får aldrig kunna läsa observationstabellen som
authority source. Det ska bevisas i kod, inte utlovas.

---

## Del 7 — Minnet

### Tre lager, med en mekanisk gräns

| Lager | Vad | Uppstår genom | Får den agera på det? |
| --- | --- | --- | --- |
| **1. Preferens** | ton, stil, tempo, vad du vill att den säger | du svarar på en fråga eller rättar den | Ja — påverkar *hur*, aldrig *vad den får göra* |
| **2. Observation** | mönster i ditt beslutsfattande | systemet räknar ditt beteende | **Nej.** Får bara föreslå |
| **3. Befogenhet** | explicit: agenten får göra X | du trycker | Ja — och bara detta lager |

**Att säga nej är också lärande.** Skälet ska gå att ange med ett tryck (*för dyrt · fel
hantverkare · vill besluta själv*) och ska påverka nästa förslag. En agent som bara lär
av ja:n lär sig fel.

### Minnet ska sökas i, inte läsas upp

Lägg **inte** hela minnet i systemprompten. Det fungerar tills det inte gör det, och då
märks det inte. Vi har just sett exakt det: `MEMORY.md` växte över sin gräns, laddades
bara delvis och slutade tyst att minnas.

Agenten ska i stället: avgöra vad den behöver veta → söka → läsa endast relevanta poster
→ använda dem → kunna visa varför den tror något.

Prosa duger till ton och stil. **Regler som påverkar behörighet måste vara strukturerade
och maskinläsbara.**

Varje preferens ska kunna svara på: *Vad är den? Var kommer den ifrån? När skapades den?
Vilket ärende skapade den? Kan människan ändra den? Är den fortfarande aktuell?*

### Persondata i minnet

Lager 1 och 2 kommer att innehålla personuppgifter om hyresgäster (*"den i 1403 klagar
ofta"*). Därför gäller samma krav som för domändata:

- gallringsfrist per lager, satt av syftet — inte "för alltid"
- anonymisering (`TenantAnonymizationLog`) måste slå igenom i preferenser och
  observationer, inte bara i domäntabellerna
- en observation om en person som lämnat ska försvinna med personen

**Förlagan finns redan och är bättre än planen antog.** `AiToolExecution` har
*differentierad* gallring, inte en frist: `ACCOUNTING_TOOL_RETENTION_DAYS = 730`,
`ACTION_TOOL_RETENTION_DAYS = 365`, `READ_TOOL_RETENTION_DAYS = 90`
(`retention/tool-execution-retention.ts:62/71/80`), och `ACCOUNTING_TOOLS` (`:52`)
omfattar uttryckligen `create_invoice`, `mark_invoice_paid`, `export_sie4` och
`apply_rent_increase`. Minnets lager ska följa samma form: frist satt av syftet, per lager.

*Öppen och uttryckligen ohanterad:* docblocket flaggar att bedömningen "AiToolExecution är
inte räkenskapsinformation" är AI-genererad och **inte människoverifierad**, och att
fristen inte får sänkas förrän svaret finns. Det gäller fortfarande.

### Sidan "Så här jobbar jag åt dig"

Alla preferenser, alla befogenheter, alla väntande förslag — läsbart på svenska,
ändringsbart på plats, med källa och datum. Det är den sidan som avgör om någon vågar
lita på systemet.

---

## Del 8 — Historiken

Historiken är inte en UI-funktion. Den är människans förståelse av vad som hänt,
agentens kontext, revisionsspåret, och grunden för framtida automation.

### Var

**Hyresgäst** — allt som rör personen, över alla avtal och objekt.
**Lägenhet** — allt som rört objektet, över alla hyresgäster, inklusive tomma perioder.
**Fastighet** — aggregerat.

### Två halvor, och den andra är den svåra

**Det som hänt:** inflytt, utflytt, avtal och ändringar, avier, sena betalningar,
påminnelser, felanmälningar, klagomål, besiktningar, nyckelöverlämningar, avläsningar,
utrustningsbyten, dokument, meddelanden — **och agentåtgärder**.

**Det som inte hänt:** *ingen besiktning sedan 2023 · ingen avläsning på åtta månader ·
ärende öppet i tre veckor utan återkoppling · inget avtal på en bebodd lägenhet.*

Frånvaro finns inte i en händelselogg. Luckor måste **beräknas mot en förväntan** och får
aldrig lagras som manuella flaggor. Det är samma princip som redan bär systemet: *skuld
är ett beräknat tillstånd, aldrig en flagga.* Och det är luckorna som gör historiken till
något en agent kan agera på i stället för bara visa.

### Arkitektur — sammanställd vid läsning

```
domäntabeller  →  historikregister  →  sammanställning  →  människans vy
                                                        →  agentens läsverktyg
```

| | Egen händelselogg alla skriver till | **Sammanställning vid läsning** |
| --- | --- | --- |
| Snabbhet | bättre | räcker på 1–50 enheter (mät, anta inte) |
| Risk | **dubbelskrivning** — en händelse hamnar i domäntabellen men inte i loggen, och luckan syns aldrig | ingen — domäntabellerna förblir enda sanning |
| Blindhet | tyst drift över tid | en glömd domän — **men det går att fälla mekaniskt** |

Valet är sammanställning vid läsning, eftersom den ena risken går att bygga bort och den
andra inte. En dubbelskriven logg som tappat en händelse **ser komplett ut** — precis den
tysta defekt vi jagat hela projektet. Visar mätning att det är för långsamt läggs en
projektion **ovanpå**; domäntabellerna förblir sanningen.

### Historikregistret och dess vakt

Ett deklarerat register över vilka domänkällor som producerar historik, med en mekanisk
vakt: *ny historikproducerande domän + saknas i registret → FAIL.*

Prov: lägg till en påhittad händelsekälla → kontrollen **ska falla**; registrera den →
grön. Utan den vakten blir historiken tyst ofullständig, vilket är värre än en historik
man vet är tom.

### Normaliserat format

**när · vad · aktör · vad det gällde · beskrivning · belopp · allvar · källa**

Källan ska vara klickbar till den riktiga domänposten. Aktören ska uttryckligen kunna
vara **människa**, **agent**, **system** eller **okänd** — det är det som gör att
hyresvärden ser agentens arbete i samma flöde som allt annat. Bygg agentens spår (G4)
och historiken som **en sak**, inte två.

#### Aktören har FYRA nivåer, inte tre

*Rättelse, uppmätt i #589.* `UNKNOWN` betyder exakt en sak: **källan saknar
aktörskolumn.** Det är en mätbar egenskap hos schemat, inte en osäkerhet i koden.

`Lease`, `Deposit`, `TerminationRequest` och `MiscCharge` bär varken `createdById`
eller `actorType`. Att skriva `SYSTEM` för dem vore ett **påstående om vem som
handlade** — att maskinen gjorde något en människa sannolikt gjorde — i ett spår vars
hela syfte är att gå att revidera. Ett fält som inte vet ska säga att det inte vet.

Det är samma familj som *"konsumerat är inte utfört"* (Del 4): den ärliga
formuleringen är inte den som låter mest bestämd, utan den som bara påstår det som
går att belägga. Den dagen en aktörskolumn läggs till kan raden byta värde utan att
formen ändras.

#### En aggregerande läsyta tar den SNÄVASTE grinden bland sina källor

*Rättelse, uppmätt i #589 och fångad av `authz-surface`-golden — inte av läsning.*

Historiken samlar femton källor bakom **en** endpoint. Källorna har olika behörighet
på annat håll:

```
/ai-usage · /ai/usage         ACCOUNTANT, ADMIN, OWNER
POST /tenants/:id/anonymize   OWNER
de tretton övriga             varje org-inloggad roll
```

Endpointen är öppen för varje roll, som de tretton. Utan motåtgärd hade en **VIEWER
nått AI-körningar och GDPR-raderingar** som hen inte når någon annanstans — en
behörighetsgräns flyttad av misstag, av ett aggregat som var korrekt byggt i övrigt.

**Regeln:** en läsyta som slår ihop flera källor ärver den **snävaste** grinden bland
dem, aldrig den vidaste. Begränsningen ska **deklareras på källan** (`restrictedToRoles`
i `history-sources.registry.ts`), inte ligga som ett villkor inne i sammanställningen —
en `if` i en läsväg skyddar bara den läsvägen, och nästa läsväg ärver ingenting.

**Regeln gäller lika mycket lägenhets- och fastighetshistoriken**, som aggregerar över
FLER hyresgäster och därför har större spridning i sina källors behörighet. Bygg dem
inte utan att ställa samma fråga.

Det här är också vad golden-filens eget huvud varnar för, och som gäller ordagrant här:
anropsytan kan vara HELT korrekt medan **svarsytan** bär mer än den prövats för.

### Kända hål — verifiera i kod först

- **Utrustningsbyten saknar datamodell.** Samma sorts hål som `assignedToId`.
- **Klagomål vs felanmälan** är inte åtskilda — och det är värre än planen skrev. *Mätt:*
  ingen `Complaint`-modell finns. `MaintenanceCategory` (`schema.prisma:246–258`) är elva
  rent tekniska kategorier; ett klagomål landar som `OTHER`. Agenten kan alltså inte ens
  **registrera** skillnaden mellan *"det läcker"* och *"grannen stör"*, än mindre bedöma
  dem olika. Det gör "bedöm allvar" i Agent 1 svagare än det låter.
- **Utrustning/byten:** *mätt* — ingen `Vendor`, `Contractor`, `Supplier`, `Equipment`,
  `Appliance` eller `Asset` finns. Modellen måste byggas från noll.
- **`reportedById`** (`schema.prisma:2938`) är också en naken `String?`, precis som
  `assignedToId` (`:2939`). Båda saknar relation.
- **Anonymisering** måste slå igenom i historiken.
- **Gallring/retention** måste följa juridiska krav — inklusive den öppna punkten om
  `AiToolExecution` (365 dagar mot sjuårsregeln för bokföringsnära poster).

---

## Del 9 — Agentens gräns

**Skillnaden är inte ämnet. Skillnaden är handlingen.**

> Ett verktyg som **skriver ner ett beslut som redan fattats** är en anteckning.
> Ett verktyg som **utför en handling mot en tredje part** är en handling.

Registrera att ett avtal upphört = anteckning. Skicka uppsägningen till hyresgästen =
handling. `apply_rent_increase` och `transition_lease_status` stannar därför orörda i
`ACTION_TOOLS` för ägar-AI:n, men hamnar **inte** i tenant-agentens allowlist.
`request_termination` fortsätter behandlas som hyresgästens egen viljeförklaring.

### Pengar: läsa är inte skriva

Agent 1 får **läsa** betalstatus och **berätta** för hyresgästen att en betalning
registrerats. Den får **inte skriva** att en betalning mottagits. Att markera en hyra som
betald är en ekonomisk skrivning — exakt det som avstämningshärdningen (INV-S→D→A→B) och
`markAsPaidManually` finns för att skydda. Formuleringen "bekräfta mottagen betalning"
ska inte förekomma i en verktygslista utan att det står vilken av de två den betyder.

### Klassificeringen deklareras, den söks inte fram

> ### ⚠️ RÄTTAT 2026-09-01 (mot `02603ed`) — TALET STÄMDE, MEDLEMMARNA INTE
>
> Mätningen nedan gav **fem**, och fem är rätt. Men **två av namnen var fel, och de
> tog ut varandra i summan** — vilket är sämre än ett fel tal, eftersom siffran såg
> bekräftad ut.
>
> | | Gamla mätningen | Rättad |
> |---|---|---|
> | `export_for_collection` (`:3711`) | utåtriktad | **NEJ** — `exportForInvoice` gör `pdf.generateFromHtml` (lokal rendering) + `storage.uploadFile` (R2). Ingen mottagare; en människa skickar filen |
> | `prepare_contract_signing` (`:2388`) | friad, *"noll mailanrop"* | **JA** — `createSigningRequest` dispatchar till signeringsprovidern, som skickar en signeringsinbjudan till hyresgästen |
>
> **Felet var i frågan, inte i räkningen.** En `mailService`-sökning mäter KANALEN,
> inte MOTTAGAREN. Att signeringen inte går via mejl gör den inte intern — den är
> en tredje part, och det som når hyresgästen är bindande.
>
> Åt andra hållet: R2 och PDF-rendering ligger utanför transaktionen men **riktar
> sig inte mot någon**. Att vara extern och att ha en mottagare är olika frågor.

*Mätt 2026-08-30, rättat 2026-09-01 (`02603ed`), härlett på METODNIVÅ: vilken metod
anropskedjan faktiskt når, inte vilken klass tjänsten råkar injicera.*

**Fem verktyg utför en handling mot en TREDJE PART:**

| Verktyg | Mottagaren nås via |
| --- | --- |
| `send_overdue_reminders` (`:1083`) | `mailService.sendOverdueReminder` |
| `compose_and_send_email` (`:1406`) | `mailService.sendCustomEmail` |
| `send_document_to_tenant` (`:2723`) | `documentDelivery.deliverToTenant` → `mail.sendCustomEmail` |
| `send_invoice_email` (`:1029`) | `pdfQueue.enqueue` → `pdf.worker.ts:71` → `processInvoiceSendJob` → `mailService.sendInvoice` (**uppskjuten**, men mottagaren är densamma) |
| `prepare_contract_signing` (`:2388`) | `signingService.createSigningRequest` → signeringsprovidern |

**SJU verktyg har en extern EFFEKT** (utanför transaktionen) — de fem ovan plus
`generate_lease_contract` och `export_for_collection`, som båda laddar upp till R2.
Talen 5 och 7 är alltså inte en motsägelse utan två olika frågor:

```
extern effekt (7)   kan spåret spännas av samma transaktion?   → nej
tredje part   (5)   riktas handlingen mot någon utanför org?   → ja
```

Skillnaden är exakt `generate_lease_contract` och `export_for_collection`: de lämnar
transaktionen men har ingen mottagare.

Prövade och **inte** utåtriktade: `mark_sent_to_collection` (`:3734`) skriver bara status
(`collection-export.service.ts:400`); `generate_rent_notices` → `generateMonthlyNotices`
(`avisering.service.ts:218–412`) har noll träffar på `sendNotices`/`mailService`/`pdfQueue`
— sändningen ligger i en separat metod (`:873`).

**Två fällor i den ursprungliga metoden, båda värda att komma ihåg:**

1. **En kanalsökning friar fel verktyg.** `prepare_contract_signing` har noll
   mailanrop och är ändå utåtriktad.
2. **Anrop inom samma klass måste följas.** `deliverToTenant` delegerar mejlet till
   en privat metod, så en sökning som bara följer `this.tjänst.metod()` ser bara
   R2-uppladdningen. En analys som missar `this.hjälpare()` mäter för lågt.

**Och detta är själva argumentet för att deklarationen måste vara tvingande.**
Utåtriktning är inte en egenskap hos verktyget utan hos **anropskedjan**.
`mark_sent_to_collection` *heter* som en handling och skriver bara status.
`generate_rent_notices` *heter* som en anteckning och ligger en metod från `mailService`.
Vid verifieringen gav en regex fem träffar, ett bredare svep sex varav en falsk: **två
svep, tre olika svar.** En lista någon underhåller kommer att bli fel. Katalogen måste
kasta vid bygget.

---

## Del 10 — Tool Catalog och delmängdsregeln

Alla agentverktyg beskrivs centralt:

```
toolName
agentAllowlist          vilka agenter som får ha det
effectClassification    anteckning | utåtriktad handling
humanPath               vägen en människa går för samma sak
requiresApproval
supportsUndo
authorityScope
```

Katalogen ska **kasta** vid ett verktyg som saknar obligatorisk klassificering.
Deklarationen är den primära mekanismen; källskanning får finnas som extra vakt men
aldrig som enda skydd. All textsökning går via `scripts/lib/source-scan.mjs` — rå
textmatchning har gett fyra tysta fel i det här projektet.

### Delmängdsregeln — det mekaniska beviset för Regel 2

```
verktyg utan humanPath                     → FAIL
humanPath pekar på rutt/åtgärd som inte finns → FAIL
```

Exempel: `approve_invoice` → `InvoicesPage → InvoiceDetails → Godkänn`.

Det är den regeln som gör *"agenten kan aldrig mer än människan"* till något som kan gå
sönder synligt i stället för att långsamt sluta gälla.

### Vakter

Varje viktig egenskap har en mekanisk vakt med kanariefågel:

1. Fäller om ett AI-bokföringsverktyg återgår till `sourceId = NULL`.
2. Fäller om ett förbrukat claim ensamt åter ger "redan utförd".
3. Fäller om ett skrivande AI-verktyg saknar deterministisk identitet.
4. Visar att samma identitet inte kan ge två effekter (riktig Postgres).
5. Fäller när en historikproducerande domän saknas i registret.
6. Fäller på verktyg utan `humanPath`, och på `humanPath` som inte finns.
7. Fäller när ett **befintligt** verktyg får en ny utåtriktad förmåga — ett nytt verktyg
   märks, en ny förmåga i ett gammalt gör det inte.

Minst en ska vara en kommentar-mot-kod-kontroll: kommentaren beskriver
identitetsprincipen, vakten fäller när implementationen slutar följa den.

**Vakt 7 byggs FÖRST, inte sist.** Verifieringen visade varför: vakt 1–6 är i praktiken
namnlistor, och en namnlista kan bara fälla det någon redan tänkt på. Regeln mot
effekttaxonomin är den enda som fångar att ett *befintligt* verktyg fått en ny utåtriktad
förmåga — och därmed den enda som gör konstruktionen värd något. Byggs den sist ger de
andra falsk trygghet under tiden.

**Innan någon agentvakt byggs: rätta R5:s omfång.** `otherFiles` ska bli ett formbaserat
svep med en kanariefågel på omfånget, precis som exekverarkontrollen redan har (`:101`).
Annars ärver varje ny vakt en blindhet vi nu vet finns.

**Varje ny vakt ska dessutom ha en omfångskanariefågel, inte bara en regelkanariefågel.**
Det är lärdomen av R5: regeln fungerade, mängden den prövade var tom. En vakt vars
parameter defaultar till `[]` mäter ingenting och är grön för alltid.

---

## Del 11 — Inkorgen, godkännanden och frågor

### Inkorgen

Ny arbetsyta **bredvid** dashboarden. Ny feature enligt husets mönster:

```
apps/web/src/features/inbox/
├── InboxPage.tsx
├── api/inbox.api.ts
├── hooks/useInbox.ts
└── components/{ApprovalCard,QuestionCard,DoneItem,DelegationSuggestion}.tsx
```

Rutt i `src/app/router.tsx`; landningsvy är en inställning per användare.

| Sektion | Innehåll | Ska kännas |
| --- | --- | --- |
| **Väntar på dig** | godkännanden och frågor | kort lista, går att tömma |
| **Förstod jag inte** | eskalerat, med agentens bästa förslag | aldrig tom av fel skäl |
| **Gjort i natt** | det agenten skötte själv | bläddras förbi |

Allt tomt = ett utfall, inte en tom tabell: **"Inget behöver dig idag."**

### API-yta (FÖRSLAG)

```
GET    /v1/agent/inbox
POST   /v1/agent/items/:id/approve | reject | approve-always | undo
POST   /v1/agent/questions/:id/answer
GET    /v1/agent/delegations
DELETE /v1/agent/delegations/:id
```

`reject` tar emot ett skäl — skälet är minnesmat.

### Godkännandekortet

Ett godkännande som kräver att man kontrollerar agentens arbete är ingen besparing — det
är granskning, som är tröttare. Kortet ska bära allt som behövs **utan att öppna fem
andra sidor**:

| Del | Varför |
| --- | --- |
| Vad den vill göra, en mening | beslutet |
| Varför, med datan bakom (klickbar) | ja:et blir grundat, inte blint |
| Vad det kostar | belopp gör risk konkret |
| Hur säker den är | osäkerhet ska synas |
| Konsekvens, och om det går att ångra | står **före** ja, aldrig efter |
| **Ja · Nej · Gör alltid detta** | delegationen skapas när den känns rätt |

"Gör alltid detta" skapar en delegation med scope förifyllt från just detta fall, uttryckt
i klar svenska: *"Boka rörmokare upp till 2 000 kr på Storgatan 4."* Aldrig en kategori,
aldrig en teknisk term.

### Frågor

**Beslutsfråga** — *"Rörmokaren vill ha 3 200 kr. Ska jag boka?"*
**Kunskapsfråga** — *"Hur vill du att jag svarar på detta nästa gång?"* → sparas som
preferens, frågan ställs aldrig igen.
**Osäkerhetsfråga** — *"Jag tror att detta är svaret. Är det rätt?"* → korrigeringen
förbättrar framtida beteende.

### Frågebudget

Varje fråga måste låsa upp något, påverka ett faktiskt beslut, eller skapa relevant
långsiktig kunskap. Mät: **ställda frågor · frågor som ändrade en åtgärd · frågor som
skapade en preferens.** Gör en fråga inget av detta ska den inte ställas.

### Avbrott

En samlad daglig genomgång. Utanför den avbryter bara en **explicit interrupt-policy** —
en utskriven lista. Agenten ska inte själv hitta på vad som är viktigt.

### Portalen

Hyresgästen ser ingenting av detta — bara ett vanligt svar och ett ärende som rör sig.
Om agenten ska presentera sig som AI är ett öppet beslut (Del 15).

---

## Del 12 — Kapplöpningen mellan människa och agent

Regel 5 kräver en mekanism, inte en förhoppning.

Ett uppdrag som väntat sedan i natt beskriver en värld som kanske inte finns längre —
hyresvärden kan ha bokat rörmokaren själv, betalningen kan ha kommit in, ärendet kan vara
stängt.

**Mekanismen:** ett uppdrag prövar sina förutsättningar **på nytt i utförandeögonblicket,
atomärt i samma transaktion som effekten**. Håller de inte längre utförs ingenting, och
uppdraget förfaller **synligt** med en rad i inkorgen: *"Skulle bokat rörmokare — du hade
redan gjort det 08:14."*

Två saker faller ut ur det:

- Godkännandet är ett *tillstånd att utföra om världen fortfarande ser likadan ut*, inte
  ett löfte att effekten inträffar.
- Ett tyst förfall är förbjudet. Hyresvärden måste kunna se att uppdraget inte gick
  igenom och varför.

---

## Del 13 — Vad agenten kostar

`AiQuotaService` finns redan och stoppar organisationer som spränger sin månadsbudget. En
agent som körs på cron över alla organisationer träffar det taket — och prod-nyckeln får
aldrig ligga i `apps/api/.env`, av precis det skälet (#385).

Två krav:

1. **Agenten respekterar kvoten.** Den är inte undantagen för att den är automatisk.
2. **En agent som stoppas av kvot ska fela synligt** — i inkorgen och i loggen. Det värsta
   utfallet är en agent som tyst slutar arbeta medan inkorgen ser lugn ut, eftersom "inget
   behöver dig idag" då betyder motsatsen till vad det står.

**Uppmätt 2026-08-30 — och farhågan är redan verklighet.** `AiQuotaService` kastar
synligt på alla fyra vägarna (månadskvot `:104`, org-dagskostnad `:182`,
användardagskostnad `:212`, med `logger.warn` före varje). **Men på cron försvinner det.**
De tre AI-jobben i `notifications.service.ts` (`:406` 07:00 vardagar, `:533` 18:00 söndag,
`:648` 08:00 den 1:a) fångar per organisation och fortsätter loopen:
`logger.error("Morning insights generation failed for org …")`, nästa org.

Hyresvärden får ingen morgonrapport, **ingen notis om att den uteblev, och ingen retry**.
Felet finns bara i loggen — och `ErrorLog` mättes tyst 2026-08-29. Det här är alltså inte
en risk att bygga bort i framtiden; det är ett befintligt tyst fel i den enda AI-funktion
som redan kör autonomt. En agent som tyst slutar svara hyresgäster är värre än en som
felar högt.

Mät dessutom kostnad per avslutat ärende. Ett ärende som kostar mer än det sparar är en
produktfråga, inte en teknisk.

---

## Del 14 — Agenterna

### Agent 1 — hyresgästkontakten

Vald först inte för att den är viktigast ekonomiskt, utan för att den **tvingar fram hela
agentarkitekturen till låg ekonomisk risk**. Ett misstag betyder fel hantverkare, inte
fel siffror i en årsredovisning.

**Gör själv:** svara på hyra, förfallodag, OCR och avtalsinformation; ta emot felanmälan,
ställa följdfrågor, bedöma allvar, skapa ärende, återkoppla; *berätta* om en betalning
registrerats (läsning — se Del 9).

**Förbereder:** påminnelser, känsliga svar, senare hantverkarbokning.

**Rör aldrig:** bindande utåtriktade handlingar.

### Första skarpa loopen

```
hyresgäst → agent → förstår problemet → följdfrågor → bedömer
          → skapar MaintenanceTicket → återkopplar → historiken uppdateras
```

*Mätt:* det enda riktiga hindret i loopen är att `tenant-ai.service.ts:180–222` måste
kunna ta emot `tool_result` från ett skrivande verktyg.

Hantverkarbokning ingår **inte** förrän `MaintenanceTicket.assignedToId` är utredd — det
är en naken `String?` utan relation.

### Efter

| # | Agent | Kärna |
| --- | --- | --- |
| 2 | Pengar in | bankavstämning, obetalda hyror, kravtrappa |
| 3 | Förbrukning | mätaravläsning, IMD, debitering |
| 4 | Bokföring | kontering, periodavslut |
| 5 | Affärsögat | avvikelser, kostnadsproblem, möjligheter — byggs sist, kräver att resten är tillförlitligt |

### Shadow mode

Innan en agent får agera skarpt ska den kunna köras i skuggläge: läsa, resonera, välja
verktyg, simulera — men varje skrivande åtgärd kräver godkännande.

Hyresvärden ska se: *vad hade agenten gjort · varför · vilken information den använde ·
hur säker den var · vad som hade krävt godkännande.*

Skuggläget körs mot **verkliga fall**, inte syntetiska happy paths. Det är också där
observationslagret föds.

---

## Del 15 — Öppna beslut

1. I vems namn skriver agenten — Evenos eller hyresvärdens?
2. Ska hyresgästen veta att det är en AI? *(rekommendation: ja)*
3. Får den svara direkt, dygnet runt? *(rekommendation: ja för det den gör själv)*
4. Beloppstak när den binder pengar.
5. Vad händer när hyresvärden inte svarar? Ingen utan varmvatten kan vänta tre dagar.
6. Vad får avbryta utanför den dagliga genomgången?
7. Frågebudget per dag.
8. Ska klagomål skiljas från felanmälan?

Sedan tidigare: #535, #555, #572, #576, #577, #580, #550, #568, #531.

---

## Del 16 — Vad vi inte ska göra

- Bygga en chatbot ovanpå appen och kalla den agent
- Ge agenten förmågor människan inte har
- Lägga behörigheter i systemprompten
- Låta observationer skapa delegationer automatiskt
- Använda `pendingActionId` som permanent execution identity
- Skapa parallella sanningskällor
- Bygga en separat historik som måste skrivas parallellt med varje domänoperation utan
  verifierat skäl
- Gömma befintliga manuella funktioner eller ersätta dashboarden med inkorgen
- Låta agenten blockera människan
- Bygga hantverkarbokning innan datamodellen är korrekt
- Lita på mockad databas för samtidighet
- Använda "testsviten är grön" som enda bevis
- Markera en etapp klar utan negativ verifiering

---

## Del 17 — Implementationsprocess

Innan kod ändras: **inspektera nuvarande implementation · verifiera varje sifferpåstående
och filreferens i den här planen · identifiera vad som redan finns · identifiera vad som
saknas · återanvänd befintlig arkitektur · implementera minsta säkra förändring · skriv
negativa tester · kör dem · försök aktivt få skydden att falla · kör hela sviten ·
dokumentera exakt vad som faktiskt verifierats.**

### Git-disciplin vid varje negativ kontroll

Från repo-roten, i den här ordningen, **varje gång**:

```
1. utgå från rent och grönt tillstånd      5. återställ (git checkout -- <filer>)
2. verifiera grönt                         6. verifiera grönt igen
3. injicera regressionen
4. verifiera RÖTT
```

Committa **före varje** injektion — `git checkout --` tar med sig allt ocommittat i
filen. Sondnamn ska grepas först och bevisligen inte finnas sedan tidigare.

---

## Verifiering

Ingen etapp är klar för att testsviten är grön. Varje säkerhetskontroll ska demonstreras
genom att den **kan falla**, och varje förväntat antal ska härledas ur källan — aldrig
"fler än noll".

**Historiken.** Ta ett verkligt objekt, härled för hand det förväntade antalet händelser
ur källtabellerna, kräv `expected == actual`. Luckorna: ta bort en besiktning i testdata
→ luckan ska dyka upp. Registervakten: påhittad källa → faller; registrerad → tyst.

**G0 — allt mot riktig Postgres, aldrig mockad:**

| Prov | Förväntat |
| --- | --- |
| Samma bekräftelse två gånger | exakt 1 effekt |
| Två olika bekräftelser | exakt 2 effekter, var och en mot sin identitet |
| Två **samtidiga** försök, samma identitet | exakt 1 effekt |
| Krasch efter claim, före execution | 0 spår, 0 effekt, svaret ≠ "redan utförd" |
| Retry efter den kraschen | tillåten |
| Replay efter lyckad execution | "redan utförd", ingen andraeffekt |
| Deterministisk identitet borttagen | **regressionen ska falla** |

**G1.** En agentaktör skriver och skrivningen bär grunden. Negativ kontroll: samma
skrivning utan grund ska vara omöjlig att uttrycka — visa felet.

**Delegation.** Tak 2 000 kr: 1 999 tillåtet · 2 000 tillåtet · 2 001 nekas. Återkalla →
1 000 nekas. Historiken visar både skapandet och återkallelsen.

**Observation.** Skapa en observation som uppfyller varje tröskel, kör agenten → den ska
**inte** utföra, bara föreslå. Bevisa dessutom i kod att observationstabellen inte kan
vara authority source.

**Persistent uppdrag.** Skapa ett uppdrag, starta om processen, läs det, godkänn → ska gå
igenom. Inget beroende av webbläsare, `conversationId`, kort TTL eller klientens state.

**Kapplöpningen.** Skapa ett uppdrag, utför samma sak manuellt, godkänn uppdraget → ingen
dubbel effekt, och en synlig rad om varför det förföll.

**Minnet.** Lägg in fler preferenser än en prompt rimligen rymmer, ställ en fråga vars
svar bara finns långt ned → den ska hittas. Det är hela skillnaden mellan hämtat och
uppläst minne, och exakt det som gick sönder i `MEMORY.md`.

**Delmängdsregeln.** Gå varje verktygs `humanPath` för hand och nå samma resultat.
Negativ kontroll: ta bort vägen i en kopia → vakten faller.

**Agent OFF — körs efter varje etapp, inte en gång i slutet.** Stäng av agenten, kör hela
sviten, `pnpm typecheck`, och en manuell genomgång av huvudvyerna och de kritiska
arbetsflödena. Allt ska fungera som tidigare. En förmåga som tyst blivit agentberoende
upptäcks bara här.

**Hela sviten.** `cd apps/api && npx jest` — hela, aldrig per modul. Sharda inte i förväg.
Faller den, **rapportera felet, maskera det inte**. Plus `pnpm typecheck` och lint.

*Uppmätt 2026-08-30 — och första körningen var själva fyndet:*

| | Sviter | Tester | Tid | Utfall |
| --- | --- | --- | --- | --- |
| Utan DB uppe | 322/330 | 3362/3398 | 160 s | **EXIT 1** |
| Med Postgres + Redis | 330/330 | 3398/3398 | 89 s | EXIT 0 |

De åtta som föll utan databas (`pending-action-claim.concurrency`,
`action-idempotency`, `ai-journal-idempotens.db`, `append-only.db`,
`ai-effect-extension`, `mark-paid.concurrency`, `auto-renew-claim`,
`waterfall-lock-order.concurrency`) **failar i stället för att hoppas över** — kanariefågeln
*"sviten körs mot en RIKTIG databas"* finns i båda idempotensspecarna. Ett hoppat test
hade varit grönt, och det var precis felet i #565.

`CLAUDE.md`:s siffror är föråldrade: 300 sviter / 3070 tester → **330 / 3398**, och
parallellt tog 89 s mot de 117,9 s som står i filen. Mät om dem vid tillfälle.

Går något inte att bevisa: skriv **BLOCKERAT**, inte grönt.
