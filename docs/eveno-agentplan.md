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

### Läge `e9227ee4` — 2026-09-08

**Mätt mot koden, inte mot minnet av den.** Raderna nedan är samma spår-regel som
resten av planen: de säger vad som fanns när de skrevs.

**Nio av elva rader är KLAR:** 1, 1b, 2, 2b, 3, 4, 5, 7, 8, 10. Etapp 11+ (agent
2–5) är inte påbörjad och står med `—`.

**Två rader väntar på VERKLIGA FALL, inte på kod.** Det är hela skillnaden mellan
dem och de nio: det som saknas går inte att bygga, det måste inträffa.

| rad | vad som FINNS | vad som SAKNAS för KLAR |
| --- | --- | --- |
| **6** — inkorgen + skuggläge | producent, inkorg, facit, deterministisk triage, mätkorpus (54 ärenden, körning 9) | `Organization.shadowAgentEnabled = true` för **en** organisation, och **en riktig felanmälan** som ger **ett förslag** |
| **9** — agent 1 skarp | växeln, utföraren, de fyra grindarna, anspråket, reapern, "Gjort" med ångra | dessutom `agentExecutionEnabled = true`, **tre godkännanden** i obruten svit (som föder ett delegationsförslag), **en delegation**, och **ett utfört uppdrag** (`status = EXECUTED`) |

**Ingen organisation har någon av flaggorna på.** Båda är `false` som default och
är OWNER-grindade på fältnivå i `OrganizationsService` — och skarpt läge kräver
dessutom att skuggan är på, samt stängs automatiskt när den stängs av.

**Vad kriterierna INTE säger.** Rad 6 lyder "den föreslår rätt i verkliga fall".
Mätkorpusen ersätter inte det: 54 konstruerade ärenden säger vad agenten gör, inte
vad den gör mot en riktig hyresvärds ärenden. Rad 9 lyder "ärenden avslutas utan
att hyresvärden rört dem" — det kräver att kedjan går hela vägen en gång, och den
har aldrig gjort det i drift.

**Kortaste vägen dit, i ordning:**

1. Slå på `shadowAgentEnabled` för en organisation som faktiskt får felanmälningar.
2. Låt den samla förslag tills hyresvärden godkänt **tre** av samma typ i följd —
   då föreslår systemet självt en delegation (`kanBliDelegation`).
3. Godkänn delegationen. Nu finns en rätt att utöva.
4. Slå på `agentExecutionEnabled`. Utföraren tar nästa `WOULD_EXECUTE` som rör
   ett av de **fem** verktyg som är både delegerbara och uppdragsdugliga.
5. Ett `EXECUTED` med `aiToolExecutionId` i "Gjort" är beviset. Då — och först
   då — går rad 6 och rad 9 till KLAR.

Steg 1 är det enda som kräver ett beslut; resten följer av att systemet används.

---

Bygg inte UI först. Bygg först de mekanismer som gör agenten säker.

**Historiken ligger först — och det är ingen avvägning mot Execution Truth.** Historiken
är inte agentarbete. Den är en läsfunktion med full nytta för en människa med agenten
avstängd, alltså ett rent bygge av Regel 3, och den är underlaget varje senare agent
läser. Bygger vi agenten först får den gissa om saker som redan står i databasen.

| Etapp | Innehåll | Blockerad av | Klar när | Status |
| --- | --- | --- | --- | --- |
| 1 | **Historiken** — händelser + luckor, hyresgäst/objekt/fastighet | — | full nytta utan agent; registervakten har setts falla | **KLAR** `5f94360` |
| 1b | Datamodell för utrustning och byten i en lägenhet | 1 | "vad byttes och när" går att svara på | **KLAR** #788 — skrivvägen finns, och frågan besvaras nu GENOM produktionskod |
| 2 | **G0 Execution Truth** — återupptagning, samtidighet, identitet för fler än 2 verktyg | — | de sju G0-proven gröna mot riktig Postgres, inkl. den fällda regressionen | **KLAR** (7/7) #786, mätt på `b02fc79` — alla sju mot Postgres; defekten prov 6 blottade är lagad och frågan ställs nu över samtliga 30 `ACTION_TOOLS` |
| 2b | **R5:s omfång** — formbaserat svep + kanariefågel på mängden | — | en injicerad sond utanför det härledda omfånget fäller vakten | **KLAR** `5f94360` |
| 3 | **G1 Aktörsmodell** | G0 | en agent kan skriva utan att låtsas vara en människa | **KLAR** — kriteriet är bevisat i produktionskod (etapp 8 PR 3). `AiPrincipal` har slaget `SYSTEM`, som bär `organizationId` + `origin` + `delegationId` och **aldrig ett userId**; `executeTool` tar en principal i stället för ett obligatoriskt `userId`, så en körning utan människa alls går att uttrycka; `assertActionToolAuthorized` har en delegationsgren med ett EGET bevis (`DelegationProof`), aldrig ett `ActionProof`; och spåret bär `authorityKind` + `delegationId` genom `identitetsKolumner` — kolumnerna hade funnits sedan #803 utan skrivare. Mätt mot riktig Postgres (`system-principal.db.spec.ts`): `userId` NULL, `authorityKind` DELEGATION, och `actorKind` AGENT stämplad av extensionen på domänraden — inte satt av provet. **Utföraren som anropar det är etapp 9**, och att den saknas är inte en rest i den här raden: kriteriet är att en agent KAN skriva utan att låtsas, inte att den gör det |
| 4 | G4 spår + G3 persistent uppdragskö — spåret är samma flöde som historiken | G0, G1, 1 | uppdrag från 03:00 finns 09:00 och syns i historiken | **KLAR** — kriteriet var mätt sedan `ff8422e`; det som stod ut var att kön saknade en UTFÖRARE. Den finns nu (etapp 9): `AiAgentExecutionService` utför genom `ToolExecutorService` med en SYSTEM-principal och ett `DelegationProof`, och skriver `EXECUTED`/`FAILED`/`LAPSED` med `aiToolExecutionId`. Bevisat mot riktig Postgres i `agent-execution.db.spec.ts` — 14/14, kört TVÅ gånger mot en tom databas, noll residual, negativkontroll per gren. Torrläget står kvar orört: `AiExecutionDryRunModule` importerar fortfarande INTE exekveraren, och gränsen mellan "kan inte" och "får" går mellan två moduler |
| 5 | Tool Catalog + allowlist + delmängdsregel + vakter | G1 | katalogen kastar; vakterna har setts falla | **KLAR** `1278a9b` — katalogen kastar i två oberoende byggare, alla sju fälten finns, vakt 1–11 har setts falla, och delmängdsbaslinjen är **TOM (30/30)** |
| 6 | **Inkorgen** (vy + API) och **shadow mode** på felanmälan | 1–5 | den föreslår rätt i verkliga fall utan att göra något | **DELVIS** `e6401d6` — producent, inkorg och facit ([#796](https://github.com/yasineken2002-sys/eken/pull/796)) finns och träffgraden går att läsa; **inte prövat i verkliga fall** — `shadowAgentEnabled` är av för varje organisation |

> ### Statusblock: skuggagenten mätt mot en korpus — 2026-09-08, `94c6a456` + hantverkarregistret
>
> **TVÅ FACITRADER ÄNDRADES EFTER KÖRNING 7, av en människa.** k23 gick från
> HIGH till URGENT och k60 från LOW till NORMAL — de två av tre diskutabla fall
> som lyftes ur mätningen och lämnades åt hyresvärden. Reglerna rördes INTE i
> samma omgång, och koden är oförändrad sedan `bc9f09bb`. Körning 8 är alltså
> samma agent mot ett rättat facit, och skillnaden mot k7 är facit och
> ingenting annat. Skälen står i `korpus.json`:s RÄTTELSER.
>
> **k25 rördes inte** (den var redan NORMAL) och **k08 rördes inte** (facit HIGH
> står kvar).
>
> **Kriteriet lyder "den föreslår rätt i VERKLIGA fall".** Det finns inga
> verkliga fall: skuggagenten är påslagen i noll organisationer, och prod har
> noll felanmälningar (mätt 2026-09-06). Den här mätningen ERSÄTTER inte
> kriteriet — den säger vad agenten gör på 54 konstruerade ärenden, tills det
> finns riktiga. Rad 6 står därför kvar utan status.
>
> Korpusen är `apps/api/src/ai/shadow/eval/korpus.json` (54 felanmälningar på
> vardaglig svenska med stavfel, facit per ärende, 10 fall där en FRÅGA är rätt
> och 5 där rätt svar är att inte föreslå något). Riggen är `pnpm eval:shadow`,
> temperatur 0, egen databas, och den körs **inte** i CI — femtio modellanrop
> kostar pengar varje gång. Korpusens form och rapportens summering har
> däremot prov som går utan ett enda anrop.
>
> | | k4 | k5 | k6 | k7 | k8 | **k9** | mål |
> | --- | --- | --- | --- | --- | --- | --- | --- |
> | kategori | 88,9 % | 87,0 % | 87,0 % | 87,0 % | 87,0 % | **87,0 %** | ≥ 85 |
> | prioritet | 79,6 % | 79,6 % | 72,2 % | 92,6 % | 90,7 % | **90,7 %** | ≥ 80 |
> | åtgärd | 77,8 % | 74,1 % | 87,0 % | 87,0 % | 87,0 % | **83,3 %** | ≥ 80 |
> | **tilldelning** | — | — | — | — | — | **100 % (28)** | — |
> | inget förslag | 100 % (5) | 100 % (5) | 100 % (5) | 100 % (5) | 100 % (5) | **100 % (5)** | ≥ 80 |
> | fel fråga | 1,9 % | 1,9 % | 1,9 % | 1,9 % | 1,9 % | **1,9 %** | ≤ 10 |
> | missad fråga | 6 | 8 | 1 | 1 | 1 | **2** | ≤ 2 |
> | kostnad | $0,2704 | $0,2714 | $0,2747 | $0,2748 | $0,2749 | **$0,3138** | — |
>
> k1–k3 utelämnade ur tabellen (52 ärenden, annan nämnare); talen står i #827.
>
> ### Det fjärde måttet finns — och det mäter mindre än det ser ut att göra
>
> `assignedContractorId` har varit ett av tre `SKUGGFALT` sedan etapp 6 och har
> **aldrig kunnat mäta något**: fältet hette `assignedToId`, var en naken
> `String?` utan skrivväg, och facit var därför alltid null. Nämnaren var noll i
> varje körning. Med `Contractor` (#833) finns både en mängd att välja ur och en
> relation att läsa facit ur.
>
> **28 av 54 ärenden har tilldelningsfacit**, och agenten träffade alla 28. Men
> talet ska läsas med den här uppdelningen:
>
> ```
> 23 av 28   menyn hade EXAKT ETT alternativ — svaret var forcerat
>  5 av 28   menyn hade HELA registret (åtta val) — ett riktigt val
> ```
>
> Registret har en hantverkare per yrke, just för att facit ska vara entydigt.
> Följden är att måttet på 23 av fallen inte kan falla: har modellen valt rätt
> kategori är hantverkaren given. **100 % betyder alltså "agenten använde menyn",
> inte "agenten valde rätt av flera".** Det som skulle ge måttet något att fela på
> är två hantverkare i samma yrke som texten skiljer åt — en jourfirma och en
> vanlig, till exempel — och den fixturen finns inte.
>
> ### Åtgärden föll, och det är promptens pris
>
> Åtgärd 87,0 → **83,3 %** och missad fråga 1 → **2**. Båda målen håller
> fortfarande (≥ 80 respektive ≤ 2), men riktningen är nedåt och orsaken är den
> nya promptsektionen: menyn är ~350 extra in-token (kostnaden steg $0,2749 →
> $0,3138, +14 %), och den konkurrerar med triageringen om uppmärksamheten.
>
> **Två ärenden blev OTOLKBART som gav giltiga FRÅGOR i k8** — `k47` ("det är fel
> på nåt") och `k57` ("kan ni titta på nåt när ni ändå är här"), båda registrerade
> `OTHER` och båda med facit FRÅGA om `category`. Med `OTHER` visas hela registret,
> så det är just de ärendena den nya sektionen är längst.
>
> **Orsaken är INTE fastställd.** `OTOLKBART` är två fel med samma namn — ett
> struntsvar och en fråga `ärGiltigFråga` avvisade — och riggen sparade bara
> etiketten. Jag hann inte mäta: dev-nyckelns krediter tog slut efter körning 9.
> Riggen skriver nu ut det RÅA svaret vid OTOLKBART, så nästa körning kan skilja
> de två åt utan att gissa.
>
> **k8: sex av sex mål håller fortfarande.** Prioriteten föll 92,6 → 90,7 %
> (50/54 → 49/54) av facitändringen, alltså av att måttstocken flyttades — inte
> av att agenten blev sämre. Koden är bit för bit densamma.
>
> **Och en obekväm siffra ska stå bredvid.** Utmanaren — modellens egen prioritet
> genom samma golv och tak — steg 85,2 → **88,9 %**. Rättelsen flyttade alltså
> facit MOT modellens svar, och avståndet mellan regel och modell krympte från
> 4,4 till **1,8** procentenheter. Regeln vinner fortfarande, och bortkopplingen
> står kvar; men marginalen är nu tunn nog att den ska mätas om vid nästa
> ändring i stället för att antas.
>
> Att k23 rör sig mot modellens svar (den sa URGENT) betyder att den rättelsen
> inte kan redovisas som neutral. Den gjordes ändå — argumentet hänger inte på
> vad modellen svarade — men riktningen står här så att ingen läser 90,7 % som
> en oberoende bekräftelse.
>
> Körning 1–3 mättes på 52 ärenden, 4–7 på 54: två ärenden lades till när två
> facit rättades (se `korpus.json`:s RÄTTELSER — rättelsen står där och inte här,
> eftersom den påverkar hur talen ska läsas och en PR-text läses en gång).
>
> **SEX AV SEX MÅL NÅDDA I KÖRNING 7.** Åtgärd ≥ 80 % (87,0), kategori ≥ 85 %
> (87,0), inget förslag ≥ 80 % (100), missad fråga ≤ 2 (1), fel fråga ≤ 10 %
> (1,9) — och **prioritet ≥ 80 % (92,6)**, som inte nåddes i någon tidigare
> körning.
>
> ### Prioriteten sätts av REGEL. Modellen har ingen röst i den.
>
> Det är den enda ändringen mellan k6 och k7 utöver reglerna själva, och den är
> mätt och inte vald. `tillämpaRegler` tar inte längre emot någon prioritet från
> modellen — spärren är strukturell, inte en överenskommelse, så ingen kan råka
> koppla in den igen.
>
> Fyra kombinationer, mätta offline mot k7:s egna svar (noll extra anrop):
>
> ```
> modellen ensam                                33/54  61,1 %
> golvet ensamt                                 38/54  70,4 %
> modell + regler        (ordningen till k6)    46/54  85,2 %
> REGISTRERAD + regler   (ordningen sedan k7)   50/54  92,6 %
> registrerad, modellen får SÄNKA, + regler     50/54  92,6 %
> ```
>
> Sista raden är skälet. När modellen får sänka tillför den **noll** — den
> tillför alltså varken uppåt eller nedåt, och ett fält som inte tillför något
> ska inte läsas. I k6 var samma jämförelse 72,2 mot 75,9, alltså samma tecken
> men mindre marginal; det som gjorde beslutet entydigt var att lägga reglerna
> till rätta först.
>
> **Kontrollen togs inte bort — den bytte sida.** Rapporten bär numera raden
> `prioritetMedModell`: modellens egen prioritet genom exakt samma golv och tak.
> Ligger den ÖVER `prioritet` ska bortkopplingen omprövas. Prompten ber därför
> fortfarande om `prediction.priority`, oförändrad — en modell som blivit
> tillsagd att svaret inte räknas är inte längre samma jämförelsepunkt.
>
> ### Sju regeländringar, mätta en i taget
>
> Varje rad är samma korpus, samma sparade modellsvar, en ändring isär.
>
> | | ändringen | modell+regler | reg+regler |
> | --- | --- | --- | --- |
> | | baslinje (k6, `2cfdf664`) | 39/54 | 41/54 |
> | R1 | fraser förkortade till sin distingerande del | 40 | 42 |
> | R2 | en angiven innetemperatur under 18 grader → HIGH | 41 | 43 |
> | R3 | textens kategoriord lyfter riskgolvet, inte bara formulärets | 41 | 43 |
> | R5 | vatten som LIGGER är HIGH; 'står vatten' borttaget | 43 | 45 |
> | R9 | hyresgästens egen utsaga: löst / ingen brådska → tak LOW | 44 | 48 |
> | R4 | fler än ett hushåll rapporterar samma fel → URGENT | 45 | 49 |
> | R7 | sanering av kroppsvätskor i gemensamt utrymme → HIGH | **46** | **50** |
>
> Tre av de sju lagar en regel som var FEL, inte en som saknades — och det är
> den grupp som bär mest:
>
> - **R1 var ett formfel.** 'står på glänt' kan inte matcha "står DEN på glänt";
>   ett enda mellanliggande ord räckte. Frasen är nu 'på glänt'.
> - **R5 var för bred.** 'står vatten' säger inte VAR. En pöl på en balkong efter
>   regn och en pöl på ett badrumsgolv är inte samma ärende, och ordet kunde inte
>   skilja dem — det fällde två ärenden och räddade noll. Skiljelinjen som
>   URGENT-gruppen påstår sig dra är vatten som RÖR SIG; en pöl är ett resultat,
>   och resultat är HIGH.
> - **R3 var för smal.** Riskgolvet läste bara `registreradKategori` — men
>   korpusens hela premiss är att det fältet kan vara fel.
>
> ### Taket är den enda mekanism i filen som får SÄNKA
>
> `prioritetsgolv` är ett golv och förblir det. Taket ligger på INDATA, alltså
> det värde golvet sedan jämförs mot: `prioritet = högreAv(tak ? LOW : registrerad, golv)`.
> Ett nyckelord i texten vinner därför alltid — "det rinner vatten, ingen
> brådska" blir URGENT.
>
> Risken går åt det farliga hållet (ett falskt tak sänker ett riktigt fel), och
> det står i filen med den kända kostnaden: frasen 'funkar nu' kan stå i
> "elementet funkar nu bara på halvfart".
>
> ### Två negativkontroller — och den ena visar att KORPUSEN är blind
>
> ```
> golvet får SÄNKA (högreAv → lägreAv)      spec 7 röda   ·  korpus 50/54 → 12/54
> taket flyttat EFTER högreAv               spec 1 röd    ·  korpus 50/54 → 50/54
> ```
>
> Den andra raden är beskedet: **korpusen kan inte se det felet.** Den har inget
> ärende där en avslutsfras och ett brådskeord står i samma text, så bara
> fixturen fäller det. Ett tal på 92,6 % säger alltså ingenting om just den
> ordningen — och hade jag mätt bara på korpusen hade jag inte vetat det.
>
> Den negativkontrollen fällde dessutom mitt EGET prov först: fixturen hade
> `registreradPrioritet: LOW`, och taket sänker till LOW — det hade alltså inget
> att sänka. Provet mätte att golvet lyfter ett LOW, inte att taket hålls
> tillbaka, och hela specen förblev grön med injektionen inne. Provet går nu
> igenom varje registrerad nivå.
>
> ### Fyra ärenden står kvar, och tre av dem är inte regelfrågor
>
> ```
> k19  facit URGENT · regel HIGH   inget varmvatten, "alla kranar", grannen samma
> k23  facit HIGH   · regel NORMAL hissen stått still i tre dagar, boende på plan 5
> k25  facit NORMAL · regel LOW    unken lukt i källargången, ingen ledtråd
> k57  facit LOW    · regel NORMAL "kan ni titta på en grej till när ni ändå är här"
> ```
>
> **k19** träffas numera av regeln för fler än ett hushåll och landar på HIGH i
> stället för URGENT — ett steg fel, inte ett missat ärende.
>
> **k23 och k25 var facitfrågor och är nu AVGJORDA av en människa** (k23 → URGENT,
> k60 → NORMAL, k25 och k08 orörda). Utfallet för agenten: k23 är fortfarande en
> miss — agenten svarade NORMAL, och både gammalt och nytt facit ligger över. k60
> blev en NY miss: agenten svarade LOW, vilket var rätt mot gammalt facit och är
> fel mot nytt. Rättelsen kostade alltså exakt ett ärende, och det är hela
> skillnaden mellan 50/54 och 49/54.
>
> **k57 är R3:s kända pris.** Texten nämner "kranen", alltså ett PLUMBING-ord, men
> är ingen felanmälan — den är en följdfråga. R3 lagade `k15` och kostade `k57`;
> netto noll på det steget, och vinsten kom först när taket lades till.
>
> **k63 är kvar, och raden om den var först FEL.** Ärendet är nätfiske i
> felanmälningsformuläret, registrerat som HIGH. Här stod att den registrerade
> prioriteten är "fritt vald av den som skriver". Ommätt: **portalformuläret kan
> inte sätta prioritet alls** — `tenant-portal.service.ts` hårdkodar `'NORMAL'`.
> Vägen som FINNS är hyresgäst-AI:n, där `create_maintenance_ticket` exponerar
> `priority` som enum och executorn skriver värdet rakt in.
>
> **Och korpusen kan inte härda mot det.** k50 och k63 har samma form — kategori
> OTHER, inget kategoriord, golv LOW — och motsatt facit (URGENT respektive LOW).
> Facit belönar alltså att man litar på ett registrerat värde utan textstöd i det
> ena fallet och bestraffar det i det andra. Två härdningar prövades och kostade
> båda sex ärenden (50/54 → 44/54). Det är en gräns i särdragen, inte en lucka i
> reglerna, och den står nu i `triage-rules.ts` så nästa person inte bygger om
> den. Ska något göras hör det hemma uppströms.
>
> ### Vad de här talen inte säger
>
> ### AI-granskningen fann fem defekter som korpusen inte kunde se
>
> Ingen av dem ändrade talet — **50/54 före och efter** — och det är hela poängen:
> ett mätvärde är ingen granskning.
>
> 1. **'är löst' betyder "is loose".** `löst` är neutrumformen av _lös_ lika
>    mycket som participet av _lösa_, och i en felanmälan är den första
>    betydelsen vanligast. Uppmätt: "Eluttaget i hallen är löst och gnistrar"
>    (ELECTRICAL/NORMAL) sänktes till **LOW** — åt det farliga hållet, och taket
>    släckte dessutom kategorigolvet. Frasen kräver nu subjektet: 'ärendet är
>    löst'.
> 2. **Läsytan ljög.** `golvHöjde` jämförde mot `bas`, som taket redan sänkt, så
>    BÅDA flaggorna blev sanna — och texten sa "Prioriteten HÖJDES till HIGH …
>    registrerades som URGENT" om en **sänkning**, och samma mening om ärenden
>    där ingenting ändrades. Flaggorna jämför nu mot det registrerade värdet och
>    är ömsesidigt uteslutande.
> 3. **R4:s 'flera …'-fraser hade noll vittnen** och gav mätta falska URGENT på
>    en namnskylt och en musikstörning. Strukna, kostnad 0/54. Kvar är
>    'grannen …', som bär både grannen och likheten — men med ETT vittne, och det
>    står nu utskrivet.
> 4. **`\d{1,2}` läste svansen av ett tresiffrigt tal.** "100 grader ur kranen" →
>    `'00'` → 0 < 18 → HIGH på skållhett vatten. Siffergruppen är ankrad, och
>    ordformen `minus` fångas nu också.
> 5. **`KATEGORIORD`-lånet vände felriktningen.** Frågeregeln blir TYST av en
>    falsk träff; golvet HÖJER. `'lås' ⊂ 'blåser'` och `'rör' ⊂ 'rörigt'` gav
>    NORMAL på fyra ofarliga meningar. Riskläsningen har nu egna längre former.
>
> Granskningen fällde också ett stale-påstående i filen (dubblettlogik finns sedan
> #655) och rättade motiveringen till att prompten lämnas oförändrad: skälet är
> **promptparitet** — riggen måste mäta samma prompt som körs skarpt — inte
> "kontrollen", som bara gäller i riggen och inte i produktionen, där svaret
> kastas.
>
> **En mätning granskningen föreslog är INTE gjord:** en körning utan de två
> prioritetsavsnitten i prompten, för $0,28, som skulle visa om de ~110 in-token
> kostar uppmärksamhet på kategori och åtgärd (båda 87 %, båda sämre än
> prioriteten). Den är specificerad och obetald.
>
> **Reglerna är valda med korpusen framför sig, och det är överanpassning.**
> Gränsen som dragits står i `triage-rules.ts`: ett ord får bara stå där om det
> bär en regel som går att säga i EN mening utan att nämna ett ärende. Två av
> tilläggen har exakt ETT vittne i korpusen (R4 och R7), och det står utskrivet
> vid vart och ett — talet nedan går inte att använda som belägg för dem, bara
> regeln gör det.
>
> **Korpusen körs med TOM historik**, så tystnadens fjärde fall ("samma fel står
> redan som ett öppet ärende") kan inte träffas i någon körning — det är omätt,
> inte uppfyllt. Och kriteriet på rad 6 lyder fortfarande "i VERKLIGA fall":
> `shadowAgentEnabled` är av i varje organisation, och prod har noll
> felanmälningar.
>
> `record_expense` är skuggdugligt men har noll facit-fall — att bokföra en
> utgift är inget svar på en felanmälan, och korpusen låtsas inte annat.
>
> ### Historik: de två promptändringarna och de tre defekterna (k1–k6)
>
> Står kvar oförkortade i [#827](https://github.com/yasineken2002-sys/eken/pull/827)
> och i `korpus.json`. Kort: menyn var en naken namnlista (modellen valde
> `create_inspection` 29 gånger mot facits 4), uppgiften kallades inte
> triagering, frågeregeln var död på ett alternativ som alltid var OTHER,
> nycklarna på tråden var svenska och avvisades fail-closed, och ett obligatoriskt
> `toolInput` drog till sig frågan. Konfidensen var INVERTERAD i körning 1 och
> blev användbar först i körning 3.
| 7 | G2 delegationer + "Gör alltid detta" + preferenser | 6 | hyresvärden kan delegera och se vad systemet tror om hen | **KLAR** — preferensresten är löst genom produktionskod (etapp 8 PR 4). `AiMemory` bär `provenanceKind` (`HUMAN_CONFIRMED`/`DECISION_DERIVED`/`ANTAGANDE`), `sourceKind`/`sourceId` och `confirmedBy`/`confirmedAt`; `getMemories` filtrerar i `where` så ett ANTAGANDE aldrig når en agentprompt, och varje rad som når den bär sin grund i klartext. `/delegationer` fick sektionen **Antaganden** med Bekräfta och Avvisa — planens "se vad systemet tror om hen" med BÅDA halvorna: vad du gett bort, och vad systemet gissat men ingen sagt. Ett avvisat antagande raderas inte (Del 7: att säga nej är också lärande). Mätt mot riktig Postgres, med negativkontroll per del |
| 8 | Agentens frågor + observationslager + delegationsförslag | 7 | den frågar innan du frågar, och föreslår i stället för att ta sig rätt | **KLAR** — alla tre delarna finns i produktionskod. **Observationslagret** (PR 4) är en FRÅGA och ingen tabell: `ObservationService.beslutsunderlag` svarar godkända/avvisade/delegerade/senaste ur inkorgens facit och delegationerna, och `kanBliDelegation` läser sin regel därifrån. **Delegationsförslagen** (PR 5a): tre godkännanden i obruten svit ger ETT förslag i inkorgen, idempotent per `<verktyg>\|<typ>\|<nivå>` under ett partiellt unikt index — systemet föreslår, det tar sig aldrig rätt. **Frågorna** (PR 5b): ett tredje utfall i skuggagenten, strukturerat (fält + 2–4 alternativ ur registret + vad svaret låser upp), högst en öppen fråga per ärende, ingen fråga vars svar redan finns, och svaret blir en `HUMAN_CONFIRMED`-minnespost som nästa förslag läser. **Kvar som en känd gräns, inte som en rest:** frågebara fält är `category` och `priority` — `assignedToId` saknar register tills etapp 10 ger det ett |
| 9 | Agent 1 skarp på felanmälan | 8 | ärenden avslutas utan att hyresvärden rört dem | **DELVIS** — **skarpt läge FINNS, och är påslaget för NOLL organisationer.** `Organization.agentExecutionEnabled` är `false` överallt, kräver att skuggan är på, är OWNER-grindad i tjänsten, och stängs automatiskt när skuggan stängs (varvid alla delegationer PAUSAS, inte återkallas). Utföraren kör bara de **fem** verktyg som är både delegerbara och uppdragsdugliga — mängden är härledd (`uppdragsdugliga ∩ delegerbara`), och de tre `DEDUPLICERBAR`-verktygen får en dom men aldrig en körning. Kriteriet "ärenden avslutas utan att hyresvärden rört dem" är alltså **omätt, inte uppfyllt**: det kräver en organisation som slår på växeln, och ingen har |
| 10 | Hantverkarmodell → bokningsflöde | 9 | `assignedToId` är en riktig relation | **KLAR** — båda kriterierna uppfyllda. **Relationen:** `Contractor` (org-scopad, yrkeskategorier ur SAMMA `MaintenanceCategory` som ärendet) och `MaintenanceTicket.assignedContractorId` som riktig FK med `assignedAt`/`assignedByUserId` (#833). Mätt före bygget: `assignedToId` hade NOLL skrivare i repot och noll rader med värde — skuggagentens tredje jämförelsefält kunde alltså aldrig mäta något. Kolumnen är utfasad men kvar tills `ai/shadow` bytt till det nya fältet (TODO i schemat). **Bokningen:** `ContractorWorkOrder` + arbetsorder via `MailService` med en svarslänk som är hashad, engångs och kortlivad; hantverkarens svar blir en händelse i historiken. Verktyget `book_contractor` är `MOT_TREDJE_PART`, `agentAllowlist: false`, `policyBeslutad: false` och **IRREVERSIBEL** — avbokningen är ett NYTT mejl, en kompenserande handling, inte en ångring (samma klassning som `prepare_contract_signing`). Vakt 7:s manifest uppdaterat avsiktligt: 9 → 10 verktyg med utåtriktad förmåga. **Bokningen går hela vägen i ett db-spec-flöde** (13 prov mot riktig Postgres: skicka → hantverkaren svarar via länken → historiken). **Hyresjuristens besked ändrade designen:** rättslig grund för att dela hyresgästens kontaktuppgift är avtalets fullgörande, INTE samtycke — ett samtyckesfält hade varit sämre, eftersom ett återkallat samtycke tar bort grunden medan avhjälpandeskyldigheten står kvar. Delningen är därför hyresvärdens val per bokning, default AV, och utlämnandet syns för hyresgästen i efterhand. **Öppet:** integritetspolicyn nämner inte hantverkare som mottagarkategori — egen PR, eftersom en ändring där utlöser omaccept för varje kund |
| 11+ | Agent 2–5 | 9 | var och en enligt samma etappform | **FÖRSLAG finns för agent 2** — [Del 14b](#del-14b--förslag-agent-2-pengar-in) mäter pengaflödets 17 verktyg, pekar ut producentens söm (den omatchade betalningen) och föreslår etapperna A–E. Ingenting är byggt, och etapp D är i dag TOM: `match_bank_transaction` är `MOT_HYRESGAST` och därmed inte delegerbar. Agent 3–5: — |

### Mätt status — etapp 1–2b mot `5f94360`, 3–4 mot `dbe12ff`, 5 mot `1278a9b`

**Samma regel som [`docs/revision-status.md`](./revision-status.md): en rad här är ett
SPÅR, inte ett faktum.** Sha:n är poängen — den säger vilket tillstånd raden beskriver,
inte när någon skrev den. Läs `dbe12ff` respektive `5f94360` som **var mätningen
gjordes**, inte att den gäller i dag. Mät om innan du bygger på en rad:

```bash
git merge-base --is-ancestor 5f94360 HEAD && echo "raden mätt mot en förfader"
git log --oneline 5f94360..HEAD -- apps/api/src/history apps/api/src/ai \
  apps/api/src/common/actor apps/api/scripts/check-action-tool-authorization.mjs
```

`—` i statuskolumnen betyder **inte mätt i den här omgången**, aldrig "inte gjord".
Raderna 6–11+ bär `—`, och en tom cell är inte ett godkännande.

**Etapp 0 finns inte längre i tabellen.** Den ströks 2026-09-05 — skälet står
under rubriken "0" nedan, och det är värt att läsa innan någon lägger tillbaka
den.

Etapp 3 och 4 mättes i #775 mot `dbe12ff` och står oförändrade här. **Etapp 5 mättes
om mot `1278a9b` (2026-09-05) och är KLAR** — se stycket "Etapp 5 — Tool Catalog"
längre ner. Etapp 1–2b mättes om mot
`5f94360` (2026-09-05): `dbe12ff` är förfader till `5f94360`, och den enda commit däremellan
som rör de mätta sökvägarna är #773 (`8743f72`), som bara LÄGGER TILL delmängdsvakten
`check-tool-human-path.mjs` och `human-path.ts`. Ingen av raderna nedan ändrade bedömning;
det som ändrades är radnummer och sha.

**0 — STRUKEN UR ETAPPTABELLEN 2026-09-05, mätt mot `fa680cf`.** Raden hörde aldrig
hemma i produktens byggordning.

`MEMORY.md` är **utvecklingsverktygets** minnesindex — Claude Codes
`~/.claude/projects/-workspaces-eken/memory/` — inte Evenos. Produktens minne är
`AiMemory`/`AiMemoryTenant` (`schema.prisma:3301`, `:3350`) med
`ai/memory.service.ts` som läsväg, och kravet på det står i Del 10 under "Minnet
ska sökas i, inte läsas upp". Det är en senare etapp, inte den här.

Att `MEMORY.md` växte över sin gräns och tyst slutade minnas är fortfarande ett
bärande exempel i planen, och står kvar där det används (Del 10). Ett exempel är
inte en leverans.

**Mätt, med kanariefågel på sonden:**

```
MEMORY.md i repot                                      0
filer i repot som nämner MEMORY.md                     1  — den här planen
sonden (kontrollera-index) i repot                     0
minnesfiler i repot                                    0

samma grep på CLAUDE.md (finns bevisligen)            26  ← sonden FUNGERAR
```

Nollan är alltså ett svar, inte ett trasigt instrument. En vakt i
`apps/api/scripts` hade fått en TOM MÄNGD att mäta — grön för alltid, och exakt
den blindhet CLAUDE.md kallar den vanligaste defekten i vakter. Att bygga den
hade gjort raden KLAR utan att göra något mätbart, vilket är sämre än att stryka
den.

Gränsen och 1:1-sonden finns och är självtestade, på rätt plats:
`~/.claude/scripts/kontrollera-index.sh --self-test` (fem sonder som var och en
fäller och tystnar). Mätt 2026-09-05: `109/200 rader · 176 filer · 176
refererade`. Den hör till verktygslådan och versioneras där.

**1 — KLAR.** `apps/api/src/history/` (18 filer), register `history-sources.registry.ts`,
kvittering `history-sources.ack.json`. Tre nivåer i API:t — `history.controller.ts:25`
(hyresgäst), `:40` (objekt), `:50` (fastighet), med luckorna på `:64`/`:69`/`:74` — och i
web via `TenantsPage.tsx:353`, `UnitsPage.tsx:437`, `PropertiesPage.tsx:415`.
**Full nytta utan agent:** ingen AI-flagga finns någonstans i vägen (noll träffar på
`AI_ENABLED`/`aiEnabled`/`isAiEnabled` i `apps/api/src/history/` och i `HistoryTab.tsx`),
så fliken nås med agenten av. **Vakten har setts falla:** `check-history-registry.mjs
--self-test` kört 2026-09-05 — regel-, omfångs- (alla tre formerna) och
kommentarkanariefåglarna RÖTT, registrerad källa TYST, exit 0. Blockerande i CI som
`history-registry-guard` (`ci.yml:1543`, i `ci-passed`:s `needs` på `:2038`).

**1b — KLAR. Skrivvägen finns, och kriteriet mäts genom produktionskod.**

Raden stod som DELVIS därför att läsvägen fanns men ingenting kunde skriva raderna.
Mätt före bygget, och det bekräftade exakt den beskrivningen:

```
moduler/kataloger med "equip"                        0
*.controller.ts som nämner equipment                 0
unitEquipment.create i produktionskod                0   (bara en fixtur + två specar)
apps/web/src med utrustnings-feature                 0   (bara historikens visningshjälpare)
assertNoEquipmentCycle-anropare i produktionskod     0   (bara sin egen spec)
```

Alltså **ingetdera** — varken endpoint utan UI eller UI utan endpoint.

**Vad som byggdes.** `apps/api/src/equipment/`: fem endpoints under `/v1/equipment`, alla
org-scopade och `@Roles('MANAGER','ADMIN','OWNER')`, med DTO:er som VÄRDEimport.
Org-scopningen är ett UPPSLAG och inte ett filter på svaret — en annan organisations
lägenhet ger 404, inte en tom lista, för en tom lista är ett svar.

**Bytet är en händelse, inte en uppdatering.** Registreringen skriver fyra saker i EN
transaktion: efterträdaren, `removedAt` + `replacedById` på föregångaren, en `REPLACED`
på den gamla och en `INSTALLED` på den nya. En efterträdare utan händelse vore ett byte
utan spår; en händelse utan efterträdare vore ett spår efter något som inte finns.

`assertNoEquipmentCycle` får därmed sin **första anropare i produktionskod** — den fanns
sedan läsvägen men hade bara sin egen spec, och en mekanism utan anropare skyddar inget.

**Append-only, och rättelse som en ny händelse.** `UnitEquipmentEvent` bär en
databastrigger (#585). Provet går förbi tjänsten med flit: det är databasen som ska säga
nej. En felregistrering rättas med en ny händelse som bär `correctsId`, `@unique` — två
rättelser kan inte peka på samma original, för en förgrenad rättelsekedja är ingen
rättelse.

**Tre nya kolumner, och NULL betyder OKÄNT på alla tre.** `cost` (okänt ≠ noll —
"gratis" och "vi vet inte" måste gå att skilja åt), `attachmentUrl`, och `performedById`
+ `actorKind`. De två sista svarar på **olika frågor** och är därför två fält:
`actorKind` är VILKEN SORTS aktör som skrev raden (stämplas av mekaniken, härledd ur
schemat), `performedById` är VILKEN MÄNNISKA som utförde arbetet — hyresvärden kan
registrera ett byte en montör gjorde.

> `performedById` är `onDelete: Restrict`, INTE `SetNull`. `SET NULL` är en kaskad-UPDATE
> som tabellens append-only-trigger avvisar — exakt interaktionen som bröt
> organisationsraderingen i #585. Migrationen skrevs dessutom **för hand**: `prisma
> migrate diff` tog med ett `DROP INDEX` på HNSW-indexet, som skapas av rå SQL och därför
> "saknas" i varje differens. Att låta det följa med hade tappat vektorindexet i prod.

**Kriteriet mäts genom produktionskod, inte i riggens egen fråga.**
`equipment-write-path.db.spec.ts` registrerar två byten och ställer frågan via
registrets EGEN `load` (`HISTORY_SOURCES.find(k => k.table === 'UnitEquipmentEvent')`).
Kopplas källan bort blir provet rött; en rigg som ställt sin egen fråga hade varit grön.
Svaret kräver rätt ordning (äldst först) och rätt aktör (var sitt byte, var sin
människa). Historiken bär nu också kostnaden som `amount` och märker ut rättelser, så två
rader med samma text och olika belopp inte blir en gåta.

**Registervakten är sedd falla.** Ändringen lägger ingen ny Unit-relation, så vakten
fäller inte av sig själv — den mätningen står i PR-texten tillsammans med sondens
utfall: en injicerad relation på `model Unit` ger `❌ R1` och exit 1 före registrering.

**Web:** fliken *Utrustning* på lägenhetens detaljvy, med lista, "Lägg till" och
"Registrera byte" i modal. Formulärets REGLER bor i en ren modul (`equipment-form.ts`)
och inte i JSX — en regel som bara finns i en komponent kan bara prövas genom att
rendera och klicka, och ett sådant prov faller lika gärna på en klassändring.

**2 — DELVIS, fem av sju prov.** Per prov, mot riktig Postgres där inget annat sägs:

| # | Prov | Utfall | Belägg |
| --- | --- | --- | --- |
| 1 | Samma bekräftelse två gånger → 1 effekt | KLAR | `numbered-entry-race.concurrency.spec.ts:203` (B1) |
| 2 | Två olika bekräftelser → 2 effekter, var mot sin identitet | KLAR | `:215` (B2); `ai/tools/ai-journal-idempotens.db.spec.ts:78` (A2) |
| 3 | Två samtidiga försök, samma identitet → 1 effekt | KLAR | `:236` (B3); `pending-action-claim.concurrency.spec.ts:115` (samtidiga anspråk, med negativkontroll `:119`) |
| 4 | Krasch efter claim, före execution → 0 spår, 0 effekt, svar ≠ "redan utförd" | **KLAR** | `ai/g0-crash-retry-replay.db.spec.ts:304` mot riktig Postgres. Alla tre halvorna är nu prov och inte prosa: `AiToolExecution` 0 rader, `JournalEntry` 0 rader, och uppspelningen ger den ärliga meningen — aldrig "redan utförd". `:348` mäter dessutom GRÄNSEN mot processdöd: ett kastat fel lämnar exakt ETT `AiMessage` mer än en krasch skulle, och rör inte anspråket. |
| 5 | Retry efter den kraschen | **KLAR** | `:365`–`:430`, ur kraschtillståndet. Fyra utsagor: anspråket går **inte** att ta igen (`:365`) — det är designen, inte en defekt, och produktionskoden säger det rakt ut (`ai-assistant.service.ts:993`); omtaget genom en NY bekräftelse lyckas med exakt EN effekt och EN körning (`:377`); den nya raden är en annan rad med **samma** `toolInputHash` (`:392`); och omtag efter en krasch **efter commit** ger fortfarande ETT verifikat, buret av den innehållshärledda `sourceId` (`:430`). |
| 6 | Replay efter lyckad execution → "redan utförd", ingen andraeffekt | **KLAR** | "Ingen andraeffekt" mot Postgres (`:476`). Meddelandet på BÅDA spårformerna: FÖRE_EFFEKTEN `:501`, TRANSAKTIONELL `:546` — och dess andra medlem `record_expense` `:579`, båda hela vägen genom `executeTool`. Defekten som gjorde raden DELVIS är lagad (se stycket nedan), och frågan ställs dessutom över samtliga 30 `ACTION_TOOLS` (`:650`) så att en tredje väg inte kan glömma fälten tyst. |
| 7 | Deterministisk identitet borttagen → regressionen faller | KLAR | `:330` (B4); `ai/tools/ai-journal-idempotens.db.spec.ts:91` (A3) |

**Attrappen är borta.** Prov 4, 5 och 6 går sedan `59f4f7b` mot riktig Postgres i
`apps/api/src/ai/g0-crash-retry-replay.db.spec.ts` (10 prov). Sömmen är
**`ToolExecutorService`-injektionen, inte Prisma**: anspråket (`ai-assistant.service.ts:1251`)
och utförandet (`:1045`) är två skilda anrop utan delad transaktion, och mellan dem körs
bara rena funktioner. Prisma är därför riktig hela vägen, så det atomära anspråket,
treutfallsuppslaget (`:1240`) och körningsuppslaget (`:976`) utvärderas på riktigt.

Filen skriver ut vad den INTE kan se: ett kastat fel är inte processdöd. Skillnaden är
mätt och inte antagen — catch-blocket (`:1053`) skriver ETT `AiMessage` och gör inget
annat; det rör varken anspråket eller `AiToolExecution`.

**Prov 5 bar planens egen poäng — *klockan 03:00 finns ingen som ber om ett nytt förslag*
— och svaret är mätt: anspråket går INTE att ta igen, med flit.** Ett engångsanspråk som
kan återuppstå är inget engångsanspråk, och det är det som gör att 24 samtidiga
bekräftelser ger EN körning (prov 3). Återupptagningen måste därför gå via en NY
bekräftelse på samma innehåll, och det som gör den vägen säker är den innehållshärledda
`sourceId` (`ai-journal-source.ts`) — inte anspråket. För en obevakad 03:00-körning är
det producenten i uppdragskön som måste kunna utfärda den nya bekräftelsen; anspråket
kommer aldrig att göra det åt den.

**FYNDET ÄR LAGAT — och uppräkningen ersatte stickprovet.** Prov 6 stod som DELVIS i
`59f4f7b` därför att uppspelningen efter ett **bevisligen** lyckat
`create_journal_entry` svarade *"det går INTE att bekräfta att åtgärden utfördes"* —
spegelbilden av den defekt den ärliga formuleringen byggdes för att laga.

Orsaken var att `AiToolExecution` skrevs från **sju** ställen som var och ett räknade upp
identitetsfälten för hand. Sex gjorde det lika; det sjunde,
`skrivTransaktionelltSpar`, skickade varken `conversationId` eller `confirmedAt`, och
uppspelningsuppslaget (`ai-assistant.service.ts:976`) kunde därför aldrig matcha.

Lagningen är strukturell, inte punktvis — sju uppräkningar blev **en**:

```
identitetsKolumner   ai-audit.service.ts   ENDA stället kolumnerna räknas upp;
                                           begin/log/writeInTransaction läser den
spårIdentitet        tool-executor.ts      ENDA stället identiteten byggs;
                                           delas av alla fyra skrivvägarna
skrivTransaktionelltSpar tar `ToolExecutionIdentity` som ETT värde i stället för
två lösa fält — halva identiteten går inte längre att skicka av misstag.
```

**Mätt biverkan av typningen:** med `exactOptionalPropertyTypes: true` är den NATURLIGA
formen av defekten inte längre skrivbar. Att plocka ut ett par fält i stället för att
sprida identiteten är ett *kompileringsfel*; att återinföra defekten kräver att man
uttryckligen skriver `conversationId: null, confirmedAt: null` efter spridningen —
alltså en avsiktshandling.

**Och stickprovet blev ett instrument.** Fyndet beskrevs först som "två verktyg". Det var
sant och för snävt: en tredje väg som glömmer fälten hade uppstått lika tyst. Frågan
ställs nu över **alla 30 `ACTION_TOOLS`**, där varje verktygs skrivare HÄRLEDS ur dess
deklarerade spårform (FÖRE_EFFEKTEN → `beginToolExecution`, TRANSAKTIONELL →
`writeInTransaction`, BÄST_MÖJLIGA → `logToolExecution`), med en kanariefågel som FÄLLER
på en spårform utan känd skrivare. Filen skriver ut vad uppräkningen inte kan se: den
mäter att varje SKRIVARE bevarar identiteten, medan att ANROPAREN skickar den ägs av de
tre proven som går hela vägen genom `executeTool`.

**2b — KLAR.** `otherFiles` finns inte längre i vakten — den enda kvarvarande träffen i
hela repot är en historisk kommentar i `check-history-registry.mjs:37`. Omfånget härleds:
`PROOF_SIGNALS` (`check-action-tool-authorization.mjs:113`), `samlaKällfiler` (`:116`),
`härledProofFiler` (`:130`), över rötterna `apps/api/src` och `packages/shared/src`
(`:643`–`:651`). Mängdkanariefågeln finns (`:313`–`:315`, *"NOLL filer i R5:s omfång"*,
samma form som exekverarkanariefågeln) och prövas i självtestet (`:578`), tillsammans med
kontrollen att härledningen tar mekanismfilerna och lämnar fakturans egna `claimed`.
R5 är dessutom skärpt från fil- till funktionsnivå (`:325`–`:332`). Landade i #596;
kroppsavgränsningen lagades i #747.

**Vakten HAR setts falla — negativkontroll körd 2026-09-05 mot `5f94360`.** Raden fick
inte stå som KLAR på att mekanismen ser rätt ut i källtexten; kravet i "Klar när" är att
en injicerad sond utanför det härledda omfånget fäller vakten. Sondnamnet grepades först
till noll träffar under svepets båda rötter (`AiUppdragSondService`: 0, `ai-uppdrag.sond`:
0), så ingen träff kan förväxlas med något som redan fanns.

```
git status --short   FÖRE                              (tomt — rent träd)

baslinje, vakten normalt                          →  GRÖN, exit 0
   R5: 5 filer i omfånget, härledda ur 503 källfiler
sond apps/api/src/ai/ai-uppdrag.sond.ts på disk   →  RÖD,  exit 1
   ❌ apps/api/src/ai/ai-uppdrag.sond.ts
      skapar ett bevis (`claimed: true`) utan ett atomärt anspråk i samma funktion
sonden borttagen                                  →  GRÖN, exit 0

git status --short   EFTER                             (tomt — rent träd)
```

Sondens styrka lästes ur vaktens egna trösklar, inte gissades: den måste dels tas UPP av
omfånget (matcha `PROOF_SIGNALS` — den bär `actionProof`), dels BRYTA R5 (ett `claimed:
true` som inte är en typdeklaration, i en funktionskropp utan både `updateMany(` och
`count === 1`). Det är precis den fil en hårdkodad tvålista aldrig hade prövat — och som
det härledda svepet namnger.

En anmärkning om återställningen: sonden var en NY fil och därmed ospårad, så
`git checkout -- apps/api/src/ai/ai-uppdrag.sond.ts` kunde inte ta bort den (`pathspec
did not match any file(s) known to git`). Den togs bort med `rm -f "${SOND:?}"` på den
namngivna sökvägen. `git checkout --` återställer ÄNDRADE spårade filer; en injicerad ny
fil kräver en radering, och den som antar det förra lämnar kvar sin sond.

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

### Mätning 2026-09-04 — etapp 3, 4 och 5 mot `dbe12ff`

Alla tre står på **DELVIS**, och det som fattas är olika saker i varje rad. Talen
nedan är körda mot koden, inte lästa ur en tidigare rad.

**Etapp 3 — G1 Aktörsmodellen.** Tre av fyra dimensioner är byggda och fäller.

| | Mekanism | Läge |
| --- | --- | --- |
| VEM | `ActorKind` (`schema.prisma:32`), stämplad av `actorStampExtension` vid tre gränser (`common/actor/actor.context.ts:76`) | **23 modeller** bär kolumnen (härlett ur DMMF) |
| FÖR VEMS RÄKNING | `AiPrincipal`, obligatorisk vid AI-gränsen (`common/ai-origin/ai-origin.context.ts:53`, `:112`) | persisteras som `AiToolExecution.userId`/`tenantId` |
| MED VILKEN RÄTT | bara *att* en människa bekräftade (`requiredConfirmation`/`confirmedAt`) | **halv** — se nedan |
| INOM VILKEN GRÄNS | `organizationId` | 22 av 23 direkt, `Unit` via `Property` |

Den negativa kontrollen är ett **fel, inte ett SAKNAS** — kört:

```
runAsAi utan uppdragsgivare  → KASTAR "AI-körning utan uppdragsgivare: aktörsobjektet saknas"
bindande verktyg utan bevis  → KASTAR ForbiddenException (assertActionToolAuthorized)
```

Det som **fattas** är vägen från domänraden till grunden. `aiToolExecutionId`
finns på **4** modeller (`InvoiceEvent`, `JournalEntry`, `AiAssignment`,
`AiToolEffect`), medan `actorKind` finns på 23 — för de övriga 19 går vägen bara
via `AiToolEffect(entityType, entityId)`, och det är en koppling, inte ett fält.

**Delegationsgrunden finns sedan 2026-09-05** ([#803](https://github.com/yasineken2002-sys/eken/pull/803), etapp 7). `AiToolExecution`
och `AiAssignment` bär nu `authorityKind` (`APPROVAL | DELEGATION`, **NOT NULL**)
och `delegationId`. NOT NULL är hela poängen: en nullbar pekare hade betytt tre
saker samtidigt — "en människa godkände", "raden skrevs innan delegationer
fanns" och "ingen har svarat" — och en kolumn som betyder tre saker kan inte
uttrycka någon av dem. Befintliga rader är `APPROVAL`, och det är ett **faktum**
och inte en gissning: delegationer fanns inte när de skrevs.

**Etapp 4 — G3/G4.** Riggen kördes i **två skilda processer** mot en tom,
nyskapad databas med egna förutsättningar. En ny `PrismaClient` hade delat
process, modulcache och `AsyncLocalStorage` med skrivaren och alltså inte prövat
något:

```
[A] pid=38821  skrev uppdraget + kallelsen, dog
[B] pid=39133  hittade det, status=AWAITING_APPROVAL, toolInput intakt
[B] besluta(APPROVED) → decidedByUserId satt, anspråket atomiskt
```

Uppdraget överlever alltså natten, och godkännandet går igenom.

**Andra halvan — *"och syns i historiken"* — är nu också mätt** (mot `71d2998`).
Den var det inte när stycket ovan skrevs, och lydelsen då stod sig: **noll av 20**
`HISTORY_SOURCES` läste `AiAssignment`, och modellen stod inte i
`history-sources.ack.json`. `check-history-registry.mjs` kunde inte se det —
`AiAssignment` hade varken tenant-, unit- eller propertyrelation, så vakten
ställde aldrig frågan om den. Det var en riktad blindhet, inte ett fel i vakten.

Åtgärden angrep just den blindheten och inte bara symtomet. `AiAssignment` fick
tre nullbara FK:er — `tenantId`, `unitId`, `propertyId`, satta vid skapandet ur
uppdragets omfång och prövade mot organisationen — varefter vakten **KRÄVER** en
källa i alla tre dimensionerna. Kanariefågeln kördes i den ordningen, med
schemat committat och källan ännu inte skriven:

```
FÖRE  node apps/api/scripts/check-history-registry.mjs → exit 1
      R1 Tenant.aiAssignments · R1 Unit.aiAssignments · R1 Property.aiAssignments
EFTER exit 0 — Tenant 24 relationer (16 registrerade, 8 kvitterade) ·
      Unit 10 (8/2) · Property 9 (7/2)
```

Omfånget **härleds inte ur `toolInput`**, och det är en mätning: av de 23 verktyg
`dugligaVerktyg()` släpper fram har bara **sex** någon av
`tenantId`/`unitId`/`propertyId` i sitt inputschema — tre, två, två. **Sjutton**
har ingen alls. En härledning ur nyttolasten hade alltså varit blind för tre
fjärdedelar av kön, på det tysta sättet. NULL i de tre kolumnerna betyder därför
"rör inget enskilt objekt", inte "vi vet inte".

Källan `ai-assignment` har **fyra** händelsetyper, inte sex, och aktören är den
som faktiskt agerade:

| händelse | aktör | belägg |
| --- | --- | --- |
| `AI_ASSIGNMENT_CREATED` | `AGENT` | controllern har inget `POST`; `skapa()` nås bara serverside |
| `AI_ASSIGNMENT_APPROVED` / `_REJECTED` | `HUMAN` | `besluta()` nås bara från `@Patch(':id/decision')` med `user.sub`; ingen AI-väg dit |
| `AI_ASSIGNMENT_EXPIRED` | `SYSTEM` | cronen `ai-assignment-expiry` |

`EXECUTED` och `FAILED` skrivs **inte**. `AiAssignmentStatus` har fyra värden, och
schemat säger uttryckligen att de två läggs till av den PR som bygger utföraren,
tillsammans med det som skriver dem — ett enumvärde ingenting kan skriva är en
vokabulär som ser ut som en mekanism, och en historikrad för ett tillstånd som
inte kan uppstå är samma fel en nivå upp.

Provet är `apps/api/src/history/ai-assignment-history.db.spec.ts`: mot riktig
Postgres, med egna förutsättningar, kört två gånger mot en tom databas. Ett
uppdrag skapat 03:00 läses 09:00 ur hyresgästens historik med `AGENT` som aktör;
ett uppdrag i en annan organisation syns inte, och inte heller ett för en annan
hyresgäst i SAMMA organisation — den andra avgränsningen är den org-filtret
ensamt hade släppt igenom.

**Varför raden ändå står som DELVIS.** Kriteriets båda halvor är mätta, men kön
har fortfarande **ingen producent och ingen utförare**. Inget uppdrag har alltså
uppstått klockan 03:00 i drift — riggen bygger sitt eget — och spåret (G4) slutar
vid människans beslut. Raden flyttas när något skriver i kön av sig självt.

Del 12:s kapplöpning: **grinden vid skapandet finns** (`assignment-eligibility.ts:90`,
23 av 30 `ACTION_TOOLS` dugliga, de 7 avvisade alla `DEDUPLICERBAR`).
**Omprövningen vid utförandet saknas — bekräftat, inte antaget**: i
`src/ai/assignments/` finns noll referenser till `ToolExecutorService` utom i en
kommentar, noll anropare av `skapa()`, och noll skrivare av
`AiAssignment.aiToolExecutionId`. Ingen producent, ingen utförare — precis som
tjänstens eget docblock säger.

**Etapp 5 — Tool Catalog. KLAR, mätt mot `1278a9b` (2026-09-05).**

Tre villkor, alla uppfyllda:

1. **Katalogen kastar**, i två oberoende byggare: `buildToolCatalog()`
   (`ai-tools.catalog.ts:351`) och `buildEffectCatalog()`
   (`effect-idempotency.ts:1121`), den senare även vid `traceIntegrity: 'OKÄND'`.
   Prövat: 30/30 gröna i `ai-tools-catalog.spec.ts` + `effect-idempotency.spec.ts`.
2. **Alla sju fälten finns** — se tabellen nedan. `effectClassification` står som
   "delvis" och det är avsiktligt: axeln *anteckning | utåtriktad handling* är
   inget eget fält, därför att den går att härleda ur två redan mätta mängder.
   Ett tredje fält hade lånat ett svar de två ger — samma fälla som CLAUDE.md
   beskriver under "Återanvänd inte ett fält som svarar på en ANNAN fråga".
3. **Vakt 1–11 har setts falla.** Alla elva finns och är prövade i båda
   riktningarna; ingen av dem är en kontroll med tom mängd.

**Det som stod kvar var delmängdsregeln, och den är stängd.**
`tool-human-path.baseline.json` gick 7 → 0 i fyra steg
([#773](https://github.com/yasineken2002-sys/eken/pull/773) byggde ratcheten,
[#782](https://github.com/yasineken2002-sys/eken/pull/782),
[#785](https://github.com/yasineken2002-sys/eken/pull/785),
[#787](https://github.com/yasineken2002-sys/eken/pull/787)).
`check-tool-human-path.mjs` läser **30 verktyg, 30 med en verifierad mänsklig väg,
0 utan**.

Baslinjefilen finns kvar TOM och får inte raderas: R5c (ett namn i baslinjen som
inte är ett verktyg) kan bara falla om det FINNS en baslinje att läsa, och
"ingen fil = noll poster" hade gjort en raderad fil oskiljbar från en tom.
`läsBaslinje` kastar därför vid saknad fil, trasig JSON eller saknat
`poster`-fält — negativkontrollerat i #787, alla tre ger exit 1.

Av planens sju fält fanns tre när etappen skrevs. Fyra tillkom:

| Fält | Läge |
| --- | --- |
| `toolName` | finns — nyckeln i `EFFECT_DECLARATIONS` |
| `effectClassification` | **delvis** — `effectIdempotency`, `idempotencyUnit`, `traceDurability`, `traceIntegrity`, `externalHandle` finns. Axeln *anteckning \| utåtriktad handling* är fortfarande inget EGET fält, men den går numera att härleda ur två mätta mängder: vakt 7:s manifest (skickar den något?) och `authorityScope` (vems rätt?). Att göra den till ett tredje fält vore att låna ett svar de två redan ger |
| `requiresApproval` | finns, **härlett** ur `ACTION_TOOLS` — ingen andra lista |
| `humanPath` | **byggd** ([#773](https://github.com/yasineken2002-sys/eken/pull/773), `8743f72`) — `ai/tools/human-path.ts` + `check-tool-human-path.mjs`, ratchet i tre riktningar |
| `agentAllowlist` | **byggd** ([#784](https://github.com/yasineken2002-sys/eken/pull/784), `59f4f7b`) — `boolean`, medveten reduktion av planens "vilka agenter": agentidentiteter finns inte i koden, och en mängd med tom domän är en vokabulär som ser ut som en mekanism. **9 av 30** är `true` |
| `supportsUndo` | **byggd** ([#784](https://github.com/yasineken2002-sys/eken/pull/784), `59f4f7b`) — `VÄG{fil,symbol}` \| `IRREVERSIBEL{skäl}` \| `INGEN_EFFEKT`. Aldrig bara `false`: "går inte att backa" och "ingen letade" ser likadana ut. 22 vägar slås upp i kod, 7 är irreversibla med skäl, 1 har ingen effekt |
| `authorityScope` | **byggd** ([#784](https://github.com/yasineken2002-sys/eken/pull/784), `59f4f7b`) — `EGEN_ORG` \| `MOT_HYRESGAST` \| `MOT_TREDJE_PART`. Uppmätt: 12 · 16 · 2 |

Vakterna i Del 10, en rad var:

| # | Vakt | Läge |
| --- | --- | --- |
| 1 | `sourceId = NULL` på AI-verifikat | `check-ai-journal-source.mjs` R1/R2 |
| 2 | förbrukat claim ger "redan utförd" | samma vakt, defekt B + `ai-confirm-crash-honesty.spec.ts` |
| 3 | skrivande verktyg utan deterministisk identitet | `check-effect-idempotency.mjs` R1–R5 |
| 4 | samma identitet ger inte två effekter | 6 `.db.spec.ts` mot riktig Postgres |
| 5 | historikdomän saknas i registret | `check-history-registry.mjs` |
| 6 | verktyg utan `humanPath`, och `humanPath` som inte finns | **byggd** ([#773](https://github.com/yasineken2002-sys/eken/pull/773), `8743f72`) — **baseline tom sedan [#787](https://github.com/yasineken2002-sys/eken/pull/787)**, 30/30 verktyg har en väg; filen finns kvar tom så R5c fortfarande kan falla |
| 7 | **befintligt** verktyg får **ny utåtriktad förmåga** | **byggd** ([#779](https://github.com/yasineken2002-sys/eken/pull/779), `f6b24cf`) — `check-tool-outward-capabilities.mjs` + `tool-outward-capabilities.json` |
| 8 | `agentAllowlist: true` på något som inte är hyresvärdens egna register | **byggd** ([#784](https://github.com/yasineken2002-sys/eken/pull/784)) — `check-tool-authority.mjs` R1, fyra härledda villkor |
| 9 | `MOT_TREDJE_PART` utan externt handtag | **byggd** ([#784](https://github.com/yasineken2002-sys/eken/pull/784)) — R2; flyttade `mark_sent_to_collection` till `MOT_HYRESGAST` |
| 10 | något som bokför eller skickar deklareras oåterkalleligt utan skäl | **byggd** ([#784](https://github.com/yasineken2002-sys/eken/pull/784)) — R3, tröskel **80** tecken |
| 11 | en ångerväg som pekar på en metod som inte finns | **byggd** ([#784](https://github.com/yasineken2002-sys/eken/pull/784)) — R4, symbolen slås upp som KOD, `\p{L}`-avgränsad |

**Vakt 7 är byggd** (2026-09-05, mätt mot `f6b24cf`). Stycket nedan beskrev
tidigare varför den saknades, och analysen stod sig: `check-ai-tool-effects.mjs`
R5/R6 jämför `EFFECT_PRODUCING_TOOLS ∪ effectFree` mot `ACTION_TOOLS`, och de
mängderna ändras inte när ett *befintligt* verktyg får en ny förmåga.
`externalHandle` deklarerades men **prövades inte mot koden** — noll träffar på
fältnamnet i `apps/api/scripts/`. En deklaration utan vakt.

`check-tool-outward-capabilities.mjs` härleder i stället förmågorna ur koden på
METODNIVÅ och diffar mot ett committat manifest åt BÅDA hållen. Räckvidden:

```
case-kropp → ett steg via privat hjälpare i exekveraren
           → den anropade metodens kropp i den klassens egen fil
             → ett steg via privat hjälpare där
```

Hoppet över injektionsgränsen behöver ingen typgraf — mottagarens typ står i
konstruktorn. Gränsen är mätt: ett svep som stannar i exekverarens fil ger 12
kandidater och missar `send_invoice_email`, vars kö ligger i
`invoices.service.ts:1611`; att i stället klassa hela `InvoicesService` som sänka
hade fällt `create_invoice` och `mark_invoice_paid` — tillbaka till tjänstenivåns 23.

**Fyra regler.** R1 kräver att varje typ som injiceras i exekveraren är klassad
som sänka eller kvitterad som inåtriktad med skäl — det är den regeln som gör att
sänkordlistan inte kan ruttna, och skälet till att ingen SMS-regel finns (noll
träffar på `sms|twilio|46elks` i hela `src`; en regel med tom mängd som aldrig kan
fyra är en kommentar). R2 diffar manifestet åt båda hållen. R3 kräver att en
utåtriktad förmåga är förenlig med `EFFECT_DECLARATIONS` och har ett
ställningstagande i `HUMAN_PATHS`. R4 fäller på tom mängd.

> ### ⚠️ VAKTEN FANN TVÅ VERKTYG DEN HÄR PLANENS EGEN MÄTNING MISSADE
>
> Mätningen 2026-09-01 gav "fem mot tredje part, sju med extern effekt". **Sju var
> fel — det är NIO**, och de två som saknades är:
>
> | Verktyg | Kedjan | Stod som |
> |---|---|---|
> | `transition_lease_status` | `transitionStatus(ACTIVE)` → `dispatchActivationJobs({origin:'manual'})` (`leases.service.ts:1010`) → `enqueueWelcomeMail` (`:766`) → Bull → `lease-activation.worker.ts:59` → Resend-mejl till hyresgästen | `externalHandle: EJ_TILLÄMPLIG` |
> | `create_tenant_and_lease` | samma kedja | `externalHandle: EJ_TILLÄMPLIG` |
>
> `origin: 'manual'` är hårdkodat på den vägen, så mejlet är inte villkorat av
> något AI:n väljer. Båda är nu rättade till `FÖRE_DISPATCH` — job-id:t är härlett
> (`welcome-${tenantId}`) och känt före dispatch.
>
> **Felet var i metoden, inte i räkningen** — precis som rättelsen 2026-09-01
> ovan. Den mätningen sökte `mailService` och `pdfQueue`; `LeaseActivationQueue`
> heter ingendera. En kanalsökning friar fel verktyg, och den fällan har nu slagit
> till TVÅ gånger i samma dokument. Vakten härleder mottagartypen ur konstruktorn
> och kan därför inte missa en kö den inte känner namnet på.

**Vad vakten inte kan se**, utskrivet i dess egen fil: anrop två steg bort,
dynamiska anrop (`this[namn](…)`), och en tjänst som byter beteende utanför
räckvidden ovan. `MailQueue` räknas därför som sänka i sig, så `MailService` inte
behöver följas vidare.

Ommätt 2026-09-05 efter [#784](https://github.com/yasineken2002-sys/eken/pull/784). **De tre fälten finns nu**, obligatoriska i typen och
fail-closed i `buildEffectCatalog` — katalogen kastar med verktygets namn och
frågan i klartext om något av dem saknas i runtime, och `effect-idempotency.spec.ts`
prövar alla tre kasten plus motprovet att `agentAllowlist: false` INTE kastar
(kontrollen är `typeof !== 'boolean'`, inte en falsy-kontroll — den hade fällt 21
av 30 korrekt deklarerade verktyg).

Fyra nya korsregler vaktar dem, alla mot mängder som redan mäts av något annat:
inga nya listor att underhålla. `check-tool-authority.mjs` R1–R4, var och en sedd
falla mot skarp kod.

**Kriteriets fem villkor, mätta:**

| villkor | läge |
| --- | --- |
| katalogen kastar | ✅ tre nya fail-closed-kast, prövade |
| vakt 1–7 har setts falla | ✅ |
| `agentAllowlist` | ✅ 9 av 30 |
| `authorityScope` | ✅ 12 EGEN_ORG · 16 MOT_HYRESGAST · 2 MOT_TREDJE_PART |
| `supportsUndo` | ✅ 22 vägar + 7 irreversibla med skäl + 1 utan effekt |
| verktyg utan mänsklig väg | ❌ **5 kvar** (`tool-human-path.baseline.json`) |

**Raden är därför DELVIS, inte KLAR** — och det som återstår är den sista raden i
tabellen, ingenting annat. Delmängdsregeln säger att agenten aldrig får kunna mer
än människan; fem verktyg bryter fortfarande mot den, och baslinjen är en ratchet
som bara får krympa (7 → 5 i [#782](https://github.com/yasineken2002-sys/eken/pull/782)).
Att flytta raden till KLAR med de fem kvar hade gjort kriteriet till en formalitet.

**Ordningen härifrån, beslutad 2026-09-04.** Tre saker mätningen fann byggs
medvetet INTE i samma omgång, och skälet står här så att nästa person inte tar
frånvaron för ett förbiseende:

1. **Ytorna för `create_journal_entry` och `record_expense` byggs i en egen PR.**
   De två är det starkaste fyndet — AI:n kan bokföra en verifikation hyresvärden
   inte kan bokföra själv — men en bokföringsyta är ett eget arbete, inte en
   bilaga till en vakt. Tills dess är de dokumenterade undantag i en baslinje som
   bara får krympa.
2. **Historikkällan för `AiAssignment` byggs i en egen PR efter delmängdsvakten.**
   Etapp 4 står som DELVIS just av det skälet, och raden ska inte flyttas förrän
   källan finns — inte förrän någon tycker att den borde finnas.
3. **Vakt 7 byggs efter att etapp 2b landat — och 2b HAR landat** (#596, #747).
   Villkoret var att vakten annars ärver R5:s blindhet från ett omfång som inte är
   formbaserat; omfånget härleds numera ur koden och har en mängdkanariefågel, så
   spärren är borta. Vakt 7 kan byggas.

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

**BYGGT 2026-09-02** (etapp 4), mätt mot `b0d72f6`. Ett fjärde skäl tillkom vid
mätningen och är det starkaste: `AiPendingAction.conversationId` är en FK mot
`AiConversation` med `onDelete: Cascade` — en agent utan konversation kan inte ens
INFOGA en rad. Bristen är strukturell, inte semantisk. Och förslaget lever dessutom
bara i React-state (`AiPage.tsx:46`), så det överlever inte ens en sidladdning.

`AiAssignment` vänder på alla fyra: full input på servern, ingen
konversationsbindning, ingen delad TTL, och **en `deadline` per uppdrag**.

Tidsgränsen är **data, inte en konstant**, och det är inte en smaksak. Att låna
`PENDING_ACTION_TTL_MS` hade gjort den TREdubbelt använd —
`ATERUPPTAGNING_TAK_MS = PENDING_ACTION_TTL_MS` finns redan — så en justering av
uppdragens gräns hade flyttat återupptagningsmotorns tak utan att något blev rött.
`check-assignment-deadline.mjs` fäller den härledningen i fyra former.

Vad som finns: kön, grinden vid skapandet (se Del 12), det synliga förfallet vid
tidsgräns, kallelsen via `Notification` och läsytan `/uppdrag`.
**Producenten finns sedan 2026-09-05** ([#790](https://github.com/yasineken2002-sys/eken/pull/790), etapp 6): skuggläget på felanmälan
skriver `AiAssignment` med `shadow: true`. Kön är alltså inte längre tom med en
läsare — den fylls av verkliga fall.

Vad som **fortfarande inte** finns: en **utförare**. Ett godkännande i skuggläge
utför ingenting, och det är inte en inställning utan en frånvarande kodväg: ingen
fil under `ai/shadow/` importerar `ToolExecutorService`, och
`shadow-producer.db.spec.ts` räknar `AiToolExecution` före och efter en körning —
noll. Utföraren är etapp 8–9.

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

**BYGGT 2026-09-05** ([#803](https://github.com/yasineken2002-sys/eken/pull/803)). `AiDelegation` + `AiDelegationEvent`, den senare med
samma `BEFORE UPDATE`-trigger som de tio andra append-only-tabellerna — nu elva.

**Status är BERÄKNAD, inte en kolumn.** Tillståndet härleds ur händelserna plus
klockan, av samma skäl som skuld är ett beräknat tillstånd: en lagrad status kan
glida isär från det den sammanfattar, och avvikelsen är osynlig. `EXPIRED` skrivs
ändå som en händelse när ett pass ser det — beräkningen är sanningen, händelsen
är kvittot på att systemet *såg* det.

**Mängden är ÅTTA av trettio, inte nio.** Ett fjärde villkor tillkom vid bygget:
`supportsUndo.kind !== 'INGEN_EFFEKT'`. `export_sie4` är `agentAllowlist: true`
men bygger bara en buffert och returnerar den — att ge bort rätten till det är
inte farligt utan MENINGSLÖST, och en meningslös post i en rättighetslista är
värre än ingen, eftersom den ser ut som ett beslut någon fattat. Villkoret står
i `delegation-scope.ts` och inte som en ändring av `agentAllowlist`: det fältet
svarar på "får en agent göra detta obevakat", och svaret för `export_sie4` är
fortfarande ja.

**Frekvensvillkor krävs för `DEDUPLICERBAR`-verktyg** (tre av de åtta:
`create_inspection`, `create_invoice`, `create_maintenance_ticket`). En omkörning
ger där en ANDRA rad, och en delegation utan tak hade gjort en obevakad loop till
en obegränsad. `IDEMPOTENT`-verktyg behöver inget: deras egen nyckel utesluter
dubbletten.

**Växeln av → PAUSAD, inte återkallad.** Att stänga av skuggagenten är inte att
ta tillbaka en rättighet. Hyresvärden som slår på den igen ska få tillbaka det hen
gav, och historiken ska visa att pausen var systemets (`actorKind: SYSTEM`), inte
människans.

**`assertDelegated` producerar inget bevis.** Den svarar ja eller nej med skäl och
returnerar bara delegationens id — den skriver ingenting, sätter ingen flagga och
rör inte `claimed`. **Den har ingen anropare utöver proven**, och det är
avsiktligt: utföraren som skulle anropa den är etapp 8–9, och en grind utan
anropare är ärligare än en grind som anropas från en väg ingen prövat.

Vad som **fortfarande saknas i etapp 7**: delegationen föds inte ur inkorgen än
("Gör alltid detta"), och det finns ingen sida där hyresvärden ser vad systemet
tror om hen. Båda är egna PR:er.

### R5:s omfång — protokoll över en blindhet som är ÅTGÄRDAD

> **Avsnittet är HISTORIK.** Rubriken löd "R5 faller inte — vakten är blind för ny kod",
> och den beskrivningen var sann 2026-08-30. **Den är inte sann om dagens kod.** Etapp 2b
> landade i #596 (kroppsavgränsningen lagad i #747): `otherFiles` finns inte längre,
> omfånget härleds ur koden, och mängden har en egen kanariefågel. Samma sond som var GRÖN
> här fäller nu vakten med exit 1 — belägget står i Del 3:s statusblock, rad 2b. Texten
> står kvar därför att den säger vad blindheten KOSTADE, inte vad koden gör.

Planen påstod att en delegationsgrind skulle fälla R5 i
`check-action-tool-authorization.mjs`. **Det var falskt, och mätt.**

Regeln prövade då bara filer i `otherFiles` — en **hårdkodad lista om två filer**:
`ai-assistant.service.ts` och `tenant-ai.service.ts`. En ny delegationsmodul låg inte i
den mängden och prövades aldrig.

Negativkontroll 2026-08-30, med sondnamnet `AiDelegationService` grepat först (0 träffar):

```
sond på disk, vakten körd normalt        →  GRÖN, exit 0        ← blindheten
samma filinnehåll matat in i evaluate()  →  1 brott             ← sonden var stark
```

Sonden var alltså stark; **omfånget var blint**. Vakten hade en kanariefågel för
exekverare (*"NOLL exekverare lästes"*) men **ingen för `otherFiles`** — parametern
defaultade till `[]`, och R5 mätte då ingenting utan att bli röd. Det är husets
kanariefågelregel i renodlad form: en kontroll som inte kan falla mäter ingenting.

Två följder, båda utförda:

1. **Rådet i sak står kvar:** delegationen ska inte producera `ActionProof` utan vara en
   separat `assertDelegated`. Två producenter av samma bevis är hur en spärr blir otydlig.
   Rådet vilade då på en spärr som inte fanns — det var en förhoppning, inte en vakt. Nu
   vilar det på en spärr som finns.
2. **R5:s omfång är formbaserat med en egen kanariefågel** (etapp 2b), och R5 är dessutom
   skärpt från *filnivå-samförekomst* till funktionsnivå: en delegationstjänst som av egna
   skäl råkar göra `updateMany` med `count === 1` passerar inte längre bara av det.

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
   märks, en ny förmåga i ett gammalt gör det inte. **BYGGD** (#779):
   `check-tool-outward-capabilities.mjs`, metodnivå, manifest diffat åt båda hållen.

Minst en ska vara en kommentar-mot-kod-kontroll: kommentaren beskriver
identitetsprincipen, vakten fäller när implementationen slutar följa den.

**Vakt 7 byggs FÖRST, inte sist.** Verifieringen visade varför: vakt 1–6 är i praktiken
namnlistor, och en namnlista kan bara fälla det någon redan tänkt på. Regeln mot
effekttaxonomin är den enda som fångar att ett *befintligt* verktyg fått en ny utåtriktad
förmåga — och därmed den enda som gör konstruktionen värd något. Byggs den sist ger de
andra falsk trygghet under tiden.

**Innan någon agentvakt byggs: rätta R5:s omfång — UTFÖRT** (etapp 2b, #596/#747).
`otherFiles` ersattes av ett formbaserat svep med en kanariefågel på omfånget, precis som
exekverarkontrollen redan hade. Villkoret är alltså uppfyllt; det står kvar därför att
det säger VARFÖR ordningen var den — inte som en kvarvarande uppgift.

**Varje ny vakt ska dessutom ha en omfångskanariefågel, inte bara en regelkanariefågel.**
Det är lärdomen av R5: regeln fungerade, mängden den prövade var tom. En vakt vars
parameter defaultar till `[]` mäter ingenting och är grön för alltid.

### Känd lucka: ingen ångerväg för en manuellt registrerad betalning

Mätt 2026-09-07, funnet av bokförings-experten i granskningen av agent 2
([Del 14b](#del-14b--förslag-agent-2-pengar-in)) och efterkontrollerat i källan.

`mark_invoice_paid` deklarerade `supportsUndo: VÄG` mot
`invoices.service.ts:update`. Symbolen finns — men metoden kastar
`Endast utkast kan redigeras` för allt som inte är `DRAFT`, och en betald faktura
är aldrig `DRAFT`. Den enda verkliga reverseringen,
`reverseJournalEntryForPayment`, har sina enda anropare i `unmatchTransaction`,
som kräver en `BankTransaction` — och en manuell betalning har ingen
(`InvoicePayment.bankTransactionId` är `NULL` just för den vägen).

**Det finns alltså ingen kodväg som backar en manuellt registrerad betalning.**
Deklarationen är rättad till `IRREVERSIBEL` med skälet i klartext, så
hyresvärden får veta det i stället för att skickas till en knapp som inte finns.

**Att bygga ångervägen är INTE beställt här, och raden ska inte läsas som en
uppgift.** Rättelsen i huvudboken är en ny verifikation, inte en radering — så
"ångra" betyder i praktiken en motbokning som någon måste besluta om. Att bygga
den mekaniskt vore en andra utförandeväg med samma behov av delegation, bevis
och spår som den första (samma resonemang som i `undo-hint.ts`). Frågan hör
därför hemma i [Del 15](#del-15--öppna-beslut), inte i en vakt.

**Vad R4 inte kunde se, och varför det inte är ett vaktfel.** R4 frågar om
symbolen står i den namngivna filen. Den kan inte fråga om symbolen är NÅBAR för
det tillstånd verktyget lämnar efter sig — det vet bara databasen. Gränsen står
numera utskriven i `check-tool-authority.mjs` med det här fallet som exempel.
Tills ett prov mot riktig Postgres bär frågan är det enda som håller den en
människa som läser deklarationen, och det är inte en betryggande ordning.

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

> **RÄTTAD 2026-09-02, mätt mot `b0d72f6`.** Den ursprungliga lydelsen krävde att
> omprövningen sker *"atomärt i samma transaktion som effekten"*. Mätningen visade
> att kravet inte är en mekanism utan 28 refaktoreringar, och att det dessutom
> skyddar mot fel kapplöpning. Ersättningsregeln nedan är starkare och byggbar.
> Den gamla lydelsen står kvar längst ned, eftersom en plan som tyst skriver om
> sig själv inte går att lita på.

Regel 5 kräver en mekanism, inte en förhoppning.

Ett uppdrag som väntat sedan i natt beskriver en värld som kanske inte finns längre —
hyresvärden kan ha bokat rörmokaren själv, betalningen kan ha kommit in, ärendet kan vara
stängt.

### Mekanismen: FÖRE_EFFEKTEN, aldrig "atomärt"

Ett uppdrag prövar sina förutsättningar på nytt **före effekten**. Skyddet mot en
dubblett kommer från **verktygets egen nyckel** — inte från en transaktionsgräns.

Och därför får bara verktyg vars effektklassificering **utesluter en andraeffekt**
alls bli ett uppdrag. Grinden sitter vid **skapandet**, inte vid utförandet:
`apps/api/src/ai/assignments/assignment-eligibility.ts`.

| krav | vad som gäller |
| --- | --- |
| klassificering | `effectIdempotency: IDEMPOTENT` — ett `DEDUPLICERBAR` duger inte, för "en post *kan* konsulteras" är ingen garanti |
| spår | `traceDurability.plats` ≠ `INGET`, ≠ `KÖ_FÖNSTER` |
| dugliga i dag | **23 av 30** `ACTION_TOOLS`; de 7 avvisade är alla `DEDUPLICERBAR` |

### Varför den gamla lydelsen inte höll

Mätt i koden 2026-09-02:

```
tool-executor.service.ts        4 407 rader · 56 case-etiketter
$transaction i den filen        2      (create_journal_entry, record_expense)
traceIntegrity=TRANSAKTIONELL   2 av 30
```

De övriga 28 delegerar till domäntjänster som **äger sin egen transaktion**.
Exekveraren kan inte gå med i den, så en förutsättningskontroll skriven i
uppdragslagret hamnar per konstruktion i en annan transaktion än effekten.

Även det bästa befintliga prejudikatet visar gapet: kontraktsradens anspråk
`SCANNED → COMMITTING` är atomiskt, men effekten (`createWithTenant`) körs utanför
det (`contract-scan-batch.service.ts:625`).

### Och varför ersättningsregeln är starkare

En transaktion skyddar bara mot en kapplöpning **inom processen**. Verktygets nyckel
skyddar även när effekten redan skedde **i går, av en människa, i en annan session**
— vilket är den kapplöpning den här delen faktiskt handlar om.

Priset är ett tidsfönster mellan omprövningen och effekten. I det fönstret kan
världen flytta sig, och utfallet blir då **ingenting** — nyckeln känner igen sig.
Det är önskat.

### Det som står kvar oförändrat

Håller förutsättningarna inte längre utförs ingenting, och uppdraget förfaller
**synligt** med en rad i inkorgen: *"Skulle bokat rörmokare — du hade redan gjort det
08:14."*

- Godkännandet är ett *tillstånd att utföra om världen fortfarande ser likadan ut*, inte
  ett löfte att effekten inträffar.
- Ett tyst förfall är förbjudet. Hyresvärden måste kunna se att uppdraget inte gick
  igenom och varför.

### Vad som ännu inte finns

Omprövningen har ingen hemvist förrän **utföraren** byggs (etapp 8–9). Etapp 4 byggde
kön, grinden, det synliga förfallet vid tidsgräns, kallelsen och läsytan — men
ingenting utför ett uppdrag, och ingenting producerar ett. `AiAssignmentStatus` har
därför bara fyra värden; `LAPSED`, `EXECUTED` och `FAILED` läggs till av den PR som
bygger det som skriver dem.

<details>
<summary>Den ursprungliga lydelsen (ersatt 2026-09-02)</summary>

> **Mekanismen:** ett uppdrag prövar sina förutsättningar **på nytt i utförandeögonblicket,
> atomärt i samma transaktion som effekten**. Håller de inte längre utförs ingenting, och
> uppdraget förfaller **synligt** med en rad i inkorgen.

</details>

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

### Agent 3 — första granskningsdelarna (utkast, ej driftgodkännande)

#858 bygger en läsande avvikelsevy, #859 visar beräkningens källor.
Fortsättningen i [agent3-api-underlag.md](./agent3-api-underlag.md) flyttar
rapporten till API:t och binder varje varning till regelversion och källrader.
Fortsättningen i [agent3-bedomningar.md](./agent3-bedomningar.md) bygger
beständiga mänskliga bedömningar med revisionshistorik. Verkligt oberoende
granskat jämförelsematerial och agentens vidare uppföljning återstår. Inga flaggor eller
automatiska debiteringsåtgärder har aktiverats av dessa byggen.

[agent3-assistent-underlag.md](./agent3-assistent-underlag.md) kopplar samma
granskningsfråga till operatörsassistenten som ett läsverktyg. Verktyget visar
trendtäckning, aktuella källor och senaste bedömning. Det är ännu ingen autonom
uppföljningsloop och ger inte något uppmätt driftfacit.

[agent3-granskningsko.md](./agent3-granskningsko.md) ger webben och assistenten
samma urval och prioritering av bedömningsarbete. Ändrat underlag återkommer
vid nästa rapportläsning. Bedömd betyder inte åtgärdad; automatiska jobb,
notifieringar och oberoende verkligt facit återstår.

### Shadow mode

**BYGGT 2026-09-05** (etapp 6), i två PR:er: producenten ([#790](https://github.com/yasineken2002-sys/eken/pull/790)) och
inkorgen ([#794](https://github.com/yasineken2002-sys/eken/pull/794)).

Planens fem krav nedan är fem fält på `AiAssignment`, och detaljvyn visar dem i
just den ordningen — handling → motivering → underlag → säkerhet → vad som hade
krävt godkännande. Ordningen är inte kosmetisk: det är den ordning man behöver
för att kunna säga EMOT ett förslag.

| kravet | fältet |
| --- | --- |
| vad hade agenten gjort | `toolName` + `toolInput` |
| varför | `reasoning` |
| vilken information den använde | `evidence` |
| hur säker den var | `confidence` (nullbar — "vet inte" är inte 0) |
| vad som hade krävt godkännande | `consequence` |

**Godkännandet är ett FACIT, inte en handling.** Planens formulering nedan säger
att varje skrivande åtgärd kräver godkännande; i den här etappen utförs
ingenting ENS vid godkännande, eftersom utföraren inte finns (etapp 8–9). De två
är förenliga bara av det skälet — inte för att beslutet betyder något annat — och
bekräftelserutan säger det rakt ut. Utan den texten godkänner hyresvärden något i
tron att det händer, och den missuppfattningen är värre än ett dåligt förslag.

**Facit skrivs när ärendet avslutas** ([#796](https://github.com/yasineken2002-sys/eken/pull/796)): `outcome` får de fält
`prediction` har, i samma söm-familj som skapandet — efter transaktionen,
fire-and-forget, med sväljd fångst. Skrivningen är IDEMPOTENT (`updateMany` med
hela objektet som värde), så ett ärende som avslutas två gånger ger samma facit.

> **Vad mätningen inte kan se, och det är den enda kända vägen till ett för högt
> tal:** om människan ändrade kategori BARA för att agenten föreslog det är facit
> agentens eget förslag i retur, och träffgraden mäter påverkan i stället för
> riktighet. Det går inte att avgöra ur databasen. Det står i
> `shadow-outcome.service.ts`.

**Träffgraden är en FRÅGA, aldrig en lagrad procent** (`prediction` mot `outcome`,
per fält). Nämnaren är rader med FACIT — ett förslag som ingen ännu avslutat
ärendet för är varken träff eller miss. Att räkna det som en miss hade gjort
måttet till en mätning av hur snabbt hyresvärden stänger ärenden. KPI-kortet
visar därför `—` och inte `0 %` innan facit finns.

> **Varför raden är DELVIS och inte KLAR.** Kriteriet säger *"den föreslår rätt i
> VERKLIGA FALL"*, och skuggläget är avstängt för varje organisation:
> `Organization.shadowAgentEnabled` är `false` som default. Att slå på det för en
> kund är ett beslut som hör till människan, inte till den här PR:en. Raden
> flyttas när flaggan varit på för minst en riktig organisation och träffgraden
> går att läsa.


Innan en agent får agera skarpt ska den kunna köras i skuggläge: läsa, resonera, välja
verktyg, simulera — men varje skrivande åtgärd kräver godkännande.

Hyresvärden ska se: *vad hade agenten gjort · varför · vilken information den använde ·
hur säker den var · vad som hade krävt godkännande.*

Skuggläget körs mot **verkliga fall**, inte syntetiska happy paths. Det är också där
observationslagret föds.

---

## Del 14b — FÖRSLAG: Agent 2 "Pengar in"

> **FÖRSLAG, inte beslut.** Ingenting i det här avsnittet är byggt. Det är en
> mätning av vad som redan finns och ett förslag på etappform — skrivet i samma
> form som agent 1 (skugga → korpus → torrläge → skarpt bakom växel), så att
> jämförelsen mellan de två går att göra. Mätpunkten är `85cbc72b`. Läs raderna
> som ett spår och mät om innan du bygger på dem.

### 1. Verktygen i pengaflödet

Mängden är avgränsad på `HUMAN_PATHS`-rutten: de verktyg vars mänskliga väg går
till `/reconciliation`, `/avisering`, `/collections`, `/invoices`, `/accounting`,
`/reports` eller `/rent-increases`. **17 av katalogens 31.** Kolumnerna är lästa
ur `EFFECT_DECLARATIONS` (`apps/api/src/ai/tools/effect-idempotency.ts`),
`HUMAN_PATHS` (`apps/api/src/ai/tools/human-path.ts`) och vakt 7:s manifest
(`apps/api/scripts/tool-outward-capabilities.json`).

| verktyg | idempotens | authorityScope | allowlist | supportsUndo | utåtriktad | mänsklig väg | delegerbar i dag |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `import_bgmax_file` | IDEMPOTENT | EGEN_ORG | ja | VÄG | – | /reconciliation · Importera | **JA** |
| `match_bank_transaction` | IDEMPOTENT | MOT_HYRESGAST | nej | VÄG | – | /reconciliation · Matcha transaktion | nej — FEL_SCOPE |
| `unmatch_transaction` | IDEMPOTENT | MOT_HYRESGAST | nej | VÄG | – | /reconciliation · Häv matchning | nej — FEL_SCOPE |
| `generate_rent_notices` | IDEMPOTENT | EGEN_ORG | ja | VÄG | – | /avisering · Generera hyresavier | **JA** |
| `send_overdue_reminders` | IDEMPOTENT | MOT_HYRESGAST | nej | IRREVERSIBEL | **JA** | /avisering · Skicka påminnelser | nej — EJ_ALLOWLISTAD |
| `pause_reminders` | IDEMPOTENT | MOT_HYRESGAST | nej | VÄG | – | /collections · Pausa | nej — EJ_ALLOWLISTAD |
| `resume_reminders` | IDEMPOTENT | MOT_HYRESGAST | nej | VÄG | – | /collections · Återuppta | nej — EJ_ALLOWLISTAD |
| `export_for_collection` | IDEMPOTENT | **MOT_TREDJE_PART** | nej | IRREVERSIBEL | **JA** | /collections · Exportera | **ALDRIG** |
| `mark_sent_to_collection` | IDEMPOTENT | MOT_HYRESGAST | nej | IRREVERSIBEL | – | /collections · Markera som skickad | nej — EJ_ALLOWLISTAD |
| `create_invoice` | DEDUPLICERBAR | EGEN_ORG | ja | VÄG | – | /invoices · Ny faktura | **JA** |
| `send_invoice_email` | DEDUPLICERBAR | MOT_HYRESGAST | nej | IRREVERSIBEL | **JA** | /invoices · Skicka via e-post | nej — EJ_ALLOWLISTAD |
| `mark_invoice_paid` | DEDUPLICERBAR | MOT_HYRESGAST | nej | VÄG | – | /invoices · Registrera betalning | nej — EJ_ALLOWLISTAD |
| `create_journal_entry` | IDEMPOTENT | EGEN_ORG | nej | VÄG | – | /accounting · Ny verifikation | nej — EJ_ALLOWLISTAD |
| `record_expense` | IDEMPOTENT | EGEN_ORG | nej | VÄG | – | /accounting · Registrera utgift | nej — EJ_ALLOWLISTAD |
| `close_period` | IDEMPOTENT | EGEN_ORG | nej | VÄG | – | /accounting · Stäng period | nej — EJ_ALLOWLISTAD |
| `export_sie4` | IDEMPOTENT | EGEN_ORG | ja | INGEN_EFFEKT | – | /reports · SIE4-export | nej — INGEN_EFFEKT |
| `apply_rent_increase` | IDEMPOTENT | MOT_HYRESGAST | nej | VÄG | – | /rent-increases · Ny hyreshöjning | nej — EJ_ALLOWLISTAD |

**Tre av de åtta delegerbara verktygen ligger i pengaflödet:**
`import_bgmax_file`, `generate_rent_notices`, `create_invoice`. Skärningen mot de
uppdragsdugliga (`uppdragsdugliga ∩ delegerbara`, de fem utföraren kör) ger
**två**: `import_bgmax_file` och `generate_rent_notices`.

**Ett verktyg är aldrig delegerbart:** `export_for_collection` är
`MOT_TREDJE_PART`, och skälet är Del 6 — rätten kan bara ges i hyresvärdens egna
register.

**Ingen mänsklig väg saknas.** `saknas`-mängden i `HUMAN_PATHS` är tom sedan
2026-09-05, så delmängdsregeln lägger inget hinder för agent 2.

**Och ett hål som inte syns i tabellen: befarad kundförlust har inget verktyg
alls.** Nedskrivningen 1510 → 1515 sker uteslutande i cronen
`reclassifyProbableLosses` (`rent-bad-debt.service.ts:123`). Agenten kan alltså
inte ens FÖRESLÅ en avskrivning — inte för att någon beslutat det, utan för att
verktyget aldrig skrevs.

### 2. Producentens söm — och vad den ger i beslut per månad

Frågan är var agent 2 ska hakas på, som agent 1 hakades på
`maintenance.service.create` (`maintenance.service.ts:307`, `enqueueSafely`).
Fyra kandidater mättes.

| kandidat | var i koden | beslut/mån, 10 lgh | varför |
| --- | --- | --- | --- |
| avi genererad | `avisering.scheduler.ts:41` (`0 7 1 * *`) | **0** | cron, ingen frågas; `generate_rent_notices` är bara den manuella vägen |
| avi förfallen | `notifications.service.ts:357` (09:00) | **0** | ren statusändring SENT → OVERDUE |
| bankfil importerad | `reconciliation.service.ts:697` (BgMax), `:577` (CSV), `:396` (API/PSD2), `bank-statement-import.service.ts` (PDF) | **≈10** | färskhetsgrinden kräver betalningsdata ≤ `paymentDataStaleDays` (default **3**) dygn gammal, annars pausas hela trappan |
| **betalning omatchad** | `reconciliation.service.ts:1050` (OCR olöst) och `:1109` (fuzzy ger upp) | **0–13** | en rad per inbetalning som faller ur alla tre matchningsgrenar |
| påminnelse skickas | `rent-reminder.service.ts:233` (10:00, dag 7) | **0** | automatisk |
| inkasso-redo | `rent-reminder.service.ts:524` (11:00, dag 21) | **0** | automatisk |
| befarad kundförlust | `rent-bad-debt.service.ts:123` (12:00) | **0** | automatisk, och saknar verktyg |
| inkasso-export | `/collections`, `export_for_collection` | **0–1** | den enda mänskliga handlingen i hela trappan |
| färskhetspaus | `payment-freshness.service.ts` | **≤1 larm per stale-period** | idempotent via `paymentDataStaleAlertedAt` |

**Det viktigaste resultatet är en nolla, inte ett maxvärde: kravtrappan ställer
inga frågor.** Alla fyra stegen — förfallomarkering, påminnelse, inkasso-redo och
nedskrivning — körs av cron utan att någon människa tillfrågas. Det finns alltså
ingen "föreslå påminnelse"-lucka att fylla: påminnelsen skickas redan. En agent
som föreslog den hade föreslagit något som händer ändå.

**Sömmen är därför den omatchade betalningen**, och den är strukturellt exakt
parallell med agent 1:s: en enda punkt där systemet ger upp och lämnar ett
ärende åt en människa. Punkten är `matchTransaction` som returnerar `false` —
alla fyra ingest-vägarna löper ihop där.

Volymen är bunden uppåt av antalet **inbetalningar**, inte av antalet rader i ett
kontoutdrag: alla fyra vägarna avvisar icke-positiva belopp, på tre mätta ställen
(`reconciliation.service.ts:409` `NON_POSITIVE`, `:631` `row.amount <= 0`,
`bank-statement-import.service.ts:220` `amount > 0`). Uttag hamnar aldrig i
kön.

> **Talen ovan är en MODELL, inte en produktionsmätning.** Underlaget är
> kadenserna i cron-uttrycken och tröskelvärdena i schemat
> (`rentReminderDay` 7, `rentInkassoDaysAfterReminder` 14,
> `paymentDataStaleDays` 3), plus antagandet 10 avier och ~10–13 inbetalningar i
> månaden. Träffgraden i den befintliga automatiken är **omätt** — produktionen
> har ingen trafik att mäta på. Spannet 0–13 är avsiktligt brett och ska ersättas
> av en mätning innan någon bygger på det.

**Färskhetsimporten är hög i dag och försvinner i morgon.** ~10 importtillfällen i
månaden är ett artefakt av att betalningsdata matas för hand. `Psd2SyncService`
matar `ingestFromApi` och därmed `paymentDataThrough` — när P3-adaptern landar är
den sömmen borta. Att bygga en agent på den vore att bygga på en ställning.

### 3. Vad "förslag" betyder för agent 2

| # | förslaget | verktyg | vad som faktiskt skrivs | idempotens | ångring | får FÖRESLÅ | får UTFÖRAS utan människa |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | matcha en omatchad inbetalning mot en avi/faktura | `match_bank_transaction` | allokering (`RentNoticePayment`/`InvoicePayment`), avi → PAID/PARTIAL, `BankTransaction` → MATCHED, betalningsverifikat 1930/1510 — allt i en transaktion | IDEMPOTENT | VÄG (`unmatch_transaction`, som bokför ett MOTVERIFIKAT) | ja | **delvis** — ja för OCR/referens (identitet), **nej för fuzzy** |
| 2 | häv en matchning som blev fel | `unmatch_transaction` | allokering bort, status tillbaka, motverifikat | IDEMPOTENT | VÄG | ja | nej |
| 3 | importera bankfilen så betalningsdatan blir färsk | `import_bgmax_file` | `BankTransaction`-rader + `autoMatchAll` + `paymentDataThrough` framflyttad | IDEMPOTENT | VÄG | ja | ja för mottagandet — **ärver rad 1:s gräns** för de matchningar importen utlöser |
| 4 | pausa kravtrappan vid inaktuell betalningsdata | `pause_reminders` | `Organization.remindersEnabled = false` | IDEMPOTENT | VÄG (`resume_reminders`) | ja | ja — skyddande, reversibel, och färskhetsgrinden gör redan samma sak obevakat |
| 5 | skicka påminnelse | `send_overdue_reminders` | påminnelseavgift bokförs + mejl + `collectionStage` → REMINDED | IDEMPOTENT | **IRREVERSIBEL** | ja | **nej** när det är agentens val — se skälet nedan |
| 6 | exportera ett krav till inkasso | `export_for_collection` | underlag till R2, kravsteg framåt | IDEMPOTENT | **IRREVERSIBEL** | ja | **aldrig** |
| 7 | markera kravet som överlämnat | `mark_sent_to_collection` | `collectionStage` + pausar påminnelser | IDEMPOTENT | **IRREVERSIBEL** | ja | **aldrig** |
| 8a | **befarad** kundförlust (1510 → 1515) | inget verktyg — cron `reclassifyProbableLosses` | omklassning i balansräkningen, ingen resultatpåverkan | — | — | ja, men onödigt | **ja** — cronen är rätt mekanism, bygg inget verktyg |
| 8b | **konstaterad** kundförlust (1515 → 6352) | inget verktyg — `confirmLoss`, endast människa | resultatpåverkande avskrivning | — | — | **ja, och bör byggas** | **aldrig** |
| 9 | registrera en betalning manuellt | `mark_invoice_paid` | betalningsverifikat | DEDUPLICERBAR | **deklarerad VÄG — men vägen finns inte, se nedan** | ja | **nej** |

**Rad 4 och 5 är redan lösta av maskinen och ska inte bli förslag.**
Färskhetsgrinden pausar redan per organisation (`evaluateAndAlert` i alla tre
kravtrappe-cronarna), och påminnelsen skickas redan. Kvar som meningsfulla
förslag är rad 1 och 2 — matchningen och dess ångring.

**Rad 6 och 7 är bindande och alltid människans.** `export_for_collection` är
`MOT_TREDJE_PART` och IRREVERSIBEL; `mark_sent_to_collection` är IRREVERSIBEL.
De får föreslås, aldrig utföras utan ett ja per handling.

#### Var automatiken ger upp — de tre grenarna

`matchTransaction` (`reconciliation.service.ts:801`) har tre grenar, och bara den
sista är en gissning:

1. **OCR-match, deterministisk.** Identitetsgrinden (`ocr-identity.ts`) gör att
   ett systemtilldelat nummer alltid vinner över fritext. Ingen agent behövs.
2. **OCR satt men olöst → GER UPP MED FLIT** (`:1050`). Transaktionen förblir
   UNMATCHED och orsaken loggas som en typad anledning. Fuzzy hoppas över
   avsiktligt. **Det här är det renaste hålet: noll automatik i dag.**
3. **Ingen OCR → fuzzy** (`:1067`): belopp inom **1,00 kr**, datumfönster
   **±90 dagar**, och match bara om det finns **exakt en** kandidat över både
   fakturor och avier (`invMatches.length + noticeMatches.length !== 1` →
   `return false`). Aldrig delbetalning (`PARTIAL_ALDRIG_VID_GISSNING`).

Gren 3 **skriver i dag automatiskt på en gissning**, och koden säger själv att
frågan om det över huvud taget är rätt är ett produktbeslut i eget ärende
(`:1147–1151`). Det gör gren 3 till den mest intressanta kandidaten för
konvertering: från skrivning till förslag.

#### Facit — och varför agent 2:s facit är hårdare än agent 1:s

| fält | agentens förslag | facit |
| --- | --- | --- |
| `avi` (`rentNoticeId` \| `invoiceId`) | vilket dokument betalningen hör till | vad människan faktiskt matchade mot, eller INGET |
| `belopp` | hela beloppet eller en delbetalning | vad allokeringen blev |
| `motpart` (`tenantId`) | vilken hyresgäst | avins `tenantId` |

Agent 1:s facit är en bedömning (kategori och prioritet kan diskuteras — tre av
korpusens fall omprövades av just det skälet). Agent 2:s facit är ett **faktum**:
en betalning hör till en avi eller inte. Det gör måttet skarpare — och
kontamineringsrisken värre, eftersom förslaget kommer att stå bredvid raden när
människan väljer. Samma förbehåll som i `shadow-outcome.service.ts` gäller, med
större kraft.

#### Deterministiska regler före modellen

Agent 1:s tydligaste lärdom var att prioriteten blev **helt deterministisk**:
registrerad + regler gav 50/54 och modellen bidrog noll åt båda hållen, varefter
modellens inflytande togs bort strukturellt (`triage-rules.ts`). Agent 2 har
samma form av regler redan i koden — OCR-identitet, tolerans 1,00 kr,
90-dagarsfönster, entydighetskravet — och de ska formuleras som regler *före*
modellen får något att göra, inte efter. Ablationen (regler ensamma mot regler +
modell) är obligatorisk, av samma skäl som i #827.

### 4. Vad som återanvänds och vad som måste vara nytt

| del | läge |
| --- | --- |
| `AiAssignment` med `shadow`/`prediction`/`outcome`/`confidence`/`sourceKind`/`sourceId` | **ordagrant** — `sourceKind` är en `String`, inte en enum, och `@@index([organizationId, sourceKind, sourceId])` finns |
| inkorgen, detaljvyn, godkännandekortet, "Gjort", `undoHint` | **ordagrant** |
| `shadow-tool-gate.ts` (`provaSkuggDuglighet`, `skuggdugligaVerktyg`) | **ordagrant** — grinden är generisk |
| delegationer, `DelegationProof`, `authorityKind`, `handlingAv` | **ordagrant** |
| torrläget (`executionVerdict`, `verdictReason`, `verdictAt`, `verdictDelegationId`) | **ordagrant** — fälten finns redan på `AiAssignment` |
| utföraren (`AgentExecutionService`, kön, svepet, reapern, DB-anspråket) | **ordagrant** |
| mätriggens FORM (korpus-JSON, `rapport.ts`, `senaste-korning.json`, ablation, kostnad per körning) | **form, inte kod** — `eval-shadow-agent.ts` importerar `maintenance-shadow.service` |
| producent + kö + worker | **nytt** — nyttolasten är `{organizationId, bankTransactionId}`, inte `ticketId` |
| svepet | **nytt** — frågan är `BankTransaction` med `status: UNMATCHED, autoMatchExcludedAt: null`, inte `MaintenanceTicket` |
| `SKUGGFALT` | **nytt** — avi, belopp, motpart i stället för kategori, prioritet, hantverkare |
| korpusen | **nytt** — bankrader och avier; agent 1:s 54 fall säger ingenting här |
| `RELEVANTA_FOR_FELANMALAN` | **nytt motstycke** — verktygsmängden för pengaflödet |
| facitskrivningen | **nytt** — hakas på `manualMatch` och `unmatchTransaction`, inte på att ett ärende avslutas |

Två saker att mäta innan man bygger, inte efter:

- **`autoMatchExcludedAt` betyder redan något.** Fältet säger "automatiken hade
  fel" och sätts av `unmatchTransaction`. Det är nästan, men inte riktigt, samma
  fråga som "agenten föreslog fel". Att låna det är exakt det lån CLAUDE.md
  varnar för — skriv de två frågorna bredvid varandra innan någon frestas.
- **Registervakten (etapp 4) ser bara modeller som är relationsfält på
  `Tenant`/`Unit`/`Property`.** En `BankTransaction` är ingen av dem. Kopplingen
  får gå via den föreslagna avins `tenantId`, och det ska stå utskrivet — annars
  ser tystnaden ut som en täckning.

### 5. Risken, och var den skiljer sig från agent 1

Agent 1 valdes först uttryckligen för att **ett misstag betyder fel hantverkare,
inte fel siffror i en årsredovisning** (Del 14). Agent 2 har inte den egenskapen.
En felmatchad betalning är ett **verifikat**, inte en anteckning: den bokförs
1930/1510 i samma transaktion som statusändringen, och den enda vägen tillbaka är
ett motverifikat — huvudboken raderar inte, den korrigerar. `supportsUndo: VÄG`
är alltså sant i systemets mening och missvisande i bokföringens: ångringen
lämnar två rader, inte noll.

Följdverkan är värre än raden i sig. En betalning som matchas mot fel avi lämnar
den rätta avins `ocrOutstanding` orörd, och kravtrappan går då vidare mot en
hyresgäst som **har betalat** — förbi påminnelseavgift och inkasso-redo, med ett
mejl och en avgift som inte skulle ha funnits. Det är samma felkedja som
identitetsgrinden (`ocr-identity.ts`) byggdes för att stänga, och det är skälet
till att agent 2 aldrig kan börja i skarpt läge.

#### Vad bokförings-experten sa

Tabellen ovan gick till `bokforings-expert` (auktoriserad redovisningskonsult,
BFL 1999:1078, BAS 2024, inkassokostnadslagen 1981:739). Domen var **godkänd med
två villkor**, och båda villkoren är fynd som inte fanns i frågan.

**Villkor 1 — fuzzy-grenen bör bli ett förslag, inte en skrivning.** Skälet är
inte att gissningen ofta blir fel, utan vad ett fel KOSTAR: en felmatchning
reglerar fel fordran och lämnar den rätta orörd, varefter kravtrappan eskalerar
mot någon som betalat medan den som är i dröjsmål ligger still. Experten pekar
också på asymmetrin i koden — gren 2 vägrar uttryckligen gissa när ett OCR finns
men inte löser ut (`:1050`), och samma resonemang gäller symmetriskt för gren 3,
som bara skiljer sig i att inget OCR fanns att misslyckas med. BFL 5 kap 6 §
kräver att en verifikation tydligt visar vad den avser; en fuzzy-träff utpekar
inte fakturan, den gissar den.

**Villkor 2 — `mark_invoice_paid.supportsUndo` är felklassad.** Deklarationen
(`effect-idempotency.ts:1429`) säger `{ kind: 'VÄG', fil:
'invoices/invoices.service.ts', symbol: 'update' }`. Efterkontrollerat:
`update()` kastar `BadRequestException('Endast utkast kan redigeras')` för allt
som inte är `DRAFT` (`invoices.service.ts:420–423`), och en manuellt betald
faktura är per definition inte DRAFT. Den enda verkliga
reverseringsmekanismen, `reverseJournalEntryForPayment`, har sina enda
anropare i `unmatchTransaction` (`reconciliation.service.ts:2967`, `:2976`) —
som bara verkar på en `BankTransaction`, och en manuell betalning har ingen.
**Det finns alltså ingen fungerande väg att ångra en manuellt registrerad
betalning.** Fältet borde säga `IRREVERSIBEL`. Det är precis den defekt
CLAUDE.md beskriver: en mekanismdeklaration som ser trygg ut men inte håller —
och den är värre än ett hål, eftersom nästa person läser `VÄG` som ett besked.

**Två rader blev tre.** Rad 8 blandade ihop två bokföringshändelser, och
distinktionen vänder svaret:

- **Befarad** kundförlust (1510 → 1515) är en ren omklassning i balansräkningen
  utan resultatpåverkan, gatad på hela genomgången kravtrappan, fail-closed mot
  obokförd fordran och med spår i `RentNoticeEvent`. Att cronen sköter den
  obevakat är rätt, och ett agentverktyg för den tillför ingenting: det finns
  inget att fråga om.
- **Konstaterad** kundförlust (1515 → 6352) är resultatpåverkande och kräver
  redan i dag en människa (`confirmLoss`, `rent-bad-debt.service.ts:385`). Det
  som saknas är att **ingen någonsin lyfter fram kandidaterna**: en fordran kan
  ligga befarad i evighet utan att någon påminns om att ta ställning. Det är
  exakt "föreslå det svåra", och expertens rekommendation är ett verktyg som
  BARA föreslår — `agentAllowlist: false` och `resumptionPolicy:
  KRÄVER_MÄNNISKA` permanent, inte provisoriskt.

**Rad 5 fick en distinktion som är rättslig och inte bokföringsmässig.** Att
cronen skickar påminnelser obevakat är rutinbokföring utan diskretion: samma
regel varje gång, med avgiftstaket i 4 § inkassokostnadslagen. En AGENT som
väljer *när* och *om* introducerar ett bedömningsmoment cronen inte har — och
avgiften syns för en enskild person utanför systemet. Slutsatsen är alltså inte
"cronen borde stoppas" utan "agentvägen ska hållas hårdare än cronvägen, trots
att utfallet är identiskt".

Experten kontrollerade också övriga `supportsUndo`-poster i pengaflödet
(`match_bank_transaction` → `unmatchTransaction`, `pause_reminders` ↔
`resume_reminders`, `close_period` → `reopenPeriod`) och fann dem korrekta.

**Följduppgifter ur granskningen**, som förslag och inte som beslut:

1. gör fuzzy-grenen till ett `AiAssignment`-förslag i stället för en direktbokning
2. rätta `mark_invoice_paid.supportsUndo` till `IRREVERSIBEL` med skäl
3. nytt verktyg för **konstaterad** kundförlust som bara får föreslå
4. bygg **inget** verktyg för befarad kundförlust

### Förslag till etappform

Samma fyra steg som agent 1, med en femte rad som är ett **beslut** och inte ett
bygge.

| etapp | innehåll | grind vidare |
| --- | --- | --- |
| **A — skugga** | producent på `matchTransaction === false`, kö `ai-money-shadow` med härlett `jobId`, svep var 15:e minut som skyddsnät, `sourceKind = 'BANK_TRANSACTION'`, förslag i inkorgen. Ingen skrivning, ingen utförare. | flaggan på för minst en riktig organisation |
| **B — korpus** | bankrader + avier som fixtur, facit på avi/belopp/motpart, ablation regler ensamma mot regler + modell, kostnad per körning redovisad | **≥ 80 % per fält** på en korpus vars nämnare är rader med facit |
| **C — torrläge** | `executionVerdict` på förslagen: vad hade utföraren gjort, och hade delegationen räckt. Inga effekter. | domarna stämmer med människans beslut |
| **D — skarpt bakom växel** | `agentExecutionEnabled`, OWNER-grindad, per organisation | se nedan — mängden är i dag **tom** |
| **E — beslutet** | ska en matchning få utföras utan ett ja per handling? | Del 15, inte den här etappen |

**Etapp D är i dag tom, och det ska stå utskrivet i stället för att upptäckas
sent.** `match_bank_transaction` är `MOT_HYRESGAST` och därmed inte delegerbar;
`import_bgmax_file` är delegerbar men behöver en fil agenten inte har, och
försvinner som fråga när PSD2 P3 landar. Agent 2 slutar alltså vid etapp C om
ingen fattar beslut E — och beslut E är inte en implementationsdetalj: det är
frågan om en gissning får reglera en fordran. Att flytta `match_bank_transaction`
till `EGEN_ORG` för att få etapp D att gå att bygga vore att besvara den frågan i
förbifarten, och det är precis det Del 6 finns för att förhindra.

**Värdet av agent 2 ligger därför i etapp A–C**, och det är inte ett litet värde:
den omatchade betalningen är den enda återkommande frågan i pengaflödet där en
människa i dag står utan förslag alls.

### Läge 2026-09-08 — ETAPP A ÄR BYGGD, mätt mot `4eb856ca`

Raden ovan sa "ingenting i det här avsnittet är byggt". Det gäller inte längre
för etapp A, och de övriga etapperna är fortfarande orörda.

**Producenten.** `apps/api/src/ai/shadow/payment/`: kö (`ai-payment-shadow`,
härlett `jobId`), worker, `PaymentShadowService` och de deterministiska reglerna
i `payment-candidates.ts`. Sömmen är `matchTransaction === false`, hakad på tre
ställen — fil-ingesten, API-ingesten och `autoMatchAll` — med `enqueueSafely`,
som aldrig kastar. Svepet i `AiShadowSweepService` är skyddsnätet, i samma
låsta pass som felanmälans.

**Reglerna går före modellen, strukturellt.** `provaKandidater` avgör exakt-OCR
(ingen fråga alls) och tomma kandidatmängder (`INGEN`) utan ett modellanrop.
Modellen får bara välja bland kandidater regeln tagit fram — enumen i
verktygsschemat gör fritext omöjlig, och en grind i tjänsten är andra spärren
för den dag providern byts. Det är agent 1:s lärdom tillämpad i förväg i
stället för i efterhand.

**Egen flagga.** `Organization.shadowPaymentAgentEnabled`, default av. En
hyresvärd ska kunna pröva agent 1 utan att därmed ha sagt ja till agent 2 — ett
misstag i den första betyder fel hantverkare, i den andra fel fordran.

**BETEENDEÄNDRINGEN, och det är den enda.** Är flaggan PÅ slutar avstämningens
fuzzy-gren bokföra och lämnar raden till ett förslag. Det är
bokförings-expertens villkor 1. Beslutet är medvetet DELVIS: att stänga grenen
för alla i samma ändring som inför agenten hade tagit bort en fungerande
automatik från någon som inte bett om ett alternativ. Det generella
avskaffandet är Del 15:s fråga.

**Ett ja UTFÖR matchningen**, till skillnad från agent 1 där ett godkännande
inte gör något. Därför en egen sort (`PAYMENT_MATCH_PROPOSAL`) och inte ett
`TOOL_PROPOSAL`: två rader som betyder olika saker vid samma knapptryck måste gå
att skilja åt i databasen. Utförandet går genom avstämningens EGEN
`manualMatch`, med människan som aktör — ingen andra skrivväg. Kortet visar
bokföringseffekten i klartext i en bekräftelseruta före klicket, och bara för
den här sorten.

**Facit** skrivs av `manualMatch` (matchad) och `ignoreTransaction` (`INGEN`),
och NOLLSTÄLLS av `unmatchTransaction`. En hävning säger att den förra
matchningen var fel, inte vad som var rätt — att skriva `INGEN` hade räknat ett
okänt svar som ett facit. Träffgraden är en fråga med en EGEN rad för
betalningar (`SKUGGFALT_BETALNING`: avi, belopp, motpart).

#### Mätt — regelhalvan, 40 bankrader mot 14 poster

Modellhalvan är INTE körd: dev-nyckeln saknar krediter. Talen nedan är
`provaKandidater` ensam, och de är mätta med `pnpm --filter @eken/api exec tsx
scripts/eval-shadow-agent.ts --betalningar --utan-modell` — noll API-anrop.

| mått | utfall |
| --- | --- |
| regeln svarade `INGEN_FRAGA` (kontroll) | 4 av 40 |
| regeln svarade `INGEN` utan modellanrop | 10 av 40 |
| gick vidare till modellen | 26 av 40 |
| **recall** — rätt post fanns bland kandidaterna | **19/19 · 100 %** |
| regeln ensam rätt på sina `INGEN` | 10/10 · 100 % |

**Korpusen ändrade koden två gånger, och båda gångerna åt rätt håll.** Det är
skälet till att den byggdes före mätningen och inte efter:

1. **Exakt OCR räckte inte.** Regeln stod som "exakt OCR → automatiken tar
   den". En DUBBELBETALNING bär ett KORREKT OCR — hyresgästen betalar samma avi
   två gånger — och avstämningen avvisar den som en överbetalning. Raden blev
   UNMATCHED och agenten föreslog aldrig något. Tystnad med pengar på kontot.
   Villkoret är nu att beloppet också ska rymmas i det utestående.
2. **Namnet måste bära ensamt, men bara nedåt.** Regeln krävde namn OCH belopp
   inom en bred tolerans, och missade fyra av fem DELBETALNINGAR — en
   delbetalning kan vara hur liten som helst. Asymmetrin är hela poängen: under
   det utestående är normalt, över är misstänkt. Utan takgränsen uppåt blir en
   återbetald deposition en kandidat mot mottagarens egen hyresavi.

**Två grupper är med flit överrepresenterade** — dubbelbetalning och
hyra + avgift i en rad. Det är de fall där ett fel kostar mest. Talen ska
alltså inte läsas som en förväntad träffgrad i drift.

#### Vad bokförings-experten fällde i bekräftelsetexten

Texten som visas FÖRE klicket gick till granskning, och två fynd var CRITICAL.
Båda efterkontrollerade i källan, båda lagade.

**1. Ett ovillkorat löfte om en ångerväg som inte finns.** Ångertexten sa att
matchningen alltid går att häva. `unmatchTransaction` kastar uttryckligen för en
faktura vars status är `PAID` (`reconciliation.service.ts:2632`): *"Betald är
ett slutläge … Det finns i dag ingen väg att häva en betald faktura."* Det
vanligaste utfallet av ett ja på ett fakturaförslag hade alltså varit
oåterkalleligt, med ett löfte om motsatsen på skärmen. Texten är nu villkorad
och säger GÅR INTE ATT ÅNGRA i just det fallet.

**2. "Kravtrappan" betyder inte samma sak för en faktura.** `Invoice` har ingen
`collectionStage`-stege. Påminnelsecronen läser `status: 'OVERDUE'`
(`payment-reminder.service.ts:83`), en delbetalning sätter fakturan till
`PARTIAL`, och `markOverdueInvoices` flippar bara `SENT → OVERDUE`
(`notifications.service.ts:331`) — det finns ingen väg tillbaka. En delbetald
faktura lämnar automatpåminnelserna **för gott**. Texten sa "kravtrappan
fortsätter på resten" för båda kandidattyperna; för fakturor var det ett löfte
systemet inte håller, i den värsta meningen — hyresvärden slutar bevaka något
ingen bevakar. De fyra varianterna är nu åtskilda.

**Ett tredje fynd ändrade koden, inte texten.** Depositioner togs UT ur
kandidatmängden. En matchning mot en `DEPOSIT`-avi sätter `Deposit.status =
'PAID'`, men `unmatchTransaction` synkar aldrig tillbaka den — en hävd
depositionsmatchning lämnar depositionen betald och `refund()` nekar sedan i
evighet. Det är en känd lucka i avstämningen, och agenten ska inte sprida den
till fler vägar.

Ett fjärde, mindre: beloppen gick genom `toFixed(2)` och blev "8450.00 kr" i en
text en svensk hyresvärd läser. De går nu genom `formatCurrency`.

#### Vad som INTE är byggt

Etapp B (korpus ≥ 80 % med modellen), C (torrläge) och D (skarpt läge) står
orörda. Etapp D är fortfarande **tom** av samma skäl som ovan:
`match_bank_transaction` är `MOT_HYRESGAST` och inte delegerbar. Att ett
godkännande utför matchningen ÄR inte skarpt läge — det är en människas ja per
handling, startat från en annan skärm.

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
