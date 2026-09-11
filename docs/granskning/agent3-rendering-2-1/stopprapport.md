# Steg 2.1 — stopp vid omfattningsgränsen

**Steg 2.1 är inte levererat.** Det formaterade arbetsutkastet är 440 ändrade
produktionsrader, men är ofullständigt och underkänt av granskning/typecheck.
Minsta nu kända sammanhängande rättning uppskattas till 497–530 rader, alltså
47–80 över taket 450. Det är en implementationuppskattning, inte ett matematiskt
bevis för alla möjliga omdesigner. Ingen granskare har visat en korrekt,
granskbar lösning inom 450. Arbetet stoppas enligt beställningens budgetregel;
ingen ytterligare uppdelning föreslås.

Den nya PR:n innehåller föreunderlag, lanseringsnotering, kontrakt och detta
stoppunderlag. **Ingen produktionsändring i arbetsutkastet committas eller pushas.**
Utkastet finns som `ofullstandigt-utkast.patch` och kvar i den egna worktreen.
Patchen är en uttryckligen ofärdig produktionsskiss på 440 rader, inte en testhjälpare
eller en färdig implementation gömd i dokumentation. Applicera eller aktivera den inte.

## Exakt utgångspunkt och arbetsplats

Godkänd bas: `5ae9906b152307eae0d79eec719d4303a042742c`.
Egen gren: `codex/agent3-rendering-2-1`.
Egen katalog: `/workspaces/eken-fran-mac-20260909/arbete/agent3-rendering-2-1`.
Första commit med fryst föreunderlag: `5326762fa1d0b9840896d382785ad230f9c47603`.
PR-basen är `codex/agent3-utskicksgrind-2b`, verifierad på exakt den godkända SHA:n.
#877–879 och deras grenar är orörda. Inga andra worktrees har ändrats.
Ingen merge, rebase, reset, amend, force-push, driftsättning eller aktivering.

## Konkret återstående omfattning

| Del                                                                                                   | Nettoökning från utkastets 440 rader |
| ----------------------------------------------------------------------------------------------------- | -----------------------------------: |
| Separat ägd browser för explicita kontexter; behåll samma kärna och lämna äldre PDF-vägar oförändrade |                                20–35 |
| Bind faktisk PDF-renderkod, mallhjälpare och Puppeteers JavaScript/transitiva beroenden               |                                18–30 |
| Bind dynamiskt laddad `react-dom/server` i mejlmotorn                                                 |                                    3 |
| Tre återstående datumformat i avin behöver uttrycklig UTC                                             |                                    6 |
| Rätta CSV-anrop till statisk `deliveredAt`                                                            |                                    2 |
| Skydda14 nya renderer-ID:n och verklig browserkörning i CI                                            |                                  6–8 |
| Avvisa dubbla datumfält även när ett av dem har felaktigt format                                      |                                  2–4 |
| Återstående typnarrowing                                                                              |                                  0–2 |
| **Beräknad total**                                                                                    |                          **497–530** |

Den första 448-skissen saknade full browserlivscykel och transitive kodberoenden.
Räknefel 500/560 i en tidig granskaruppskattning rättades öppet före implementation;
de används inte som stoppgrund. Dagens grund är faktiskt formaterad diff plus
konkreta, oberoende verifierade kvarstående krav. Enbart UTC/CSV och minsta CI
skulle ge 454 mot nuvarande struktur, innan integritetsluckorna rättas.

## Blockerande fynd i arbetsutkastet

Radnummer nedan avser den sparade patchens resulterande arbetsfiler, inte PR:ns
oförändrade produktionsfiler.

- `invoices/pdf.service.ts:253`: identiteten omfattar maskinmiljö och två
  wrapperfunktioner, men inte de fem HTML-kärnorna/mallhjälparna/Puppeteer-JS.
  Samma godkända identitet kan därför acceptera ändrat renderinnehåll.
- `mail/mail.renderer.ts:56`: `module.children` före första rendering missar
  `react-dom/server`, som installerad React Email laddar dynamiskt i
  `@react-email/render/dist/node/index.cjs:175`. Granskaren fann 39 statiska
  beroenden och noll ReactDOM-filer i den förväntade grafen.
- `invoices/pdf.service.ts:250`: `getBrowser` ändrar även kontrakt, besiktning,
  månadsrapport och plattformsfaktura genom Linux-/kommandokrav och hårdstopp vid
  miljöändring. Att bara flytta kontrollen lämnar en möjlig gammal fontcache i
  den delade browsern. Separat ägande/livscykel behövs för beställd avgränsning.
- `avisering/avisering.service.ts:1136,1185,1186`: kvarstående implicit tidszon.
- `collections/rent-collection-export.service.ts:490`: CSV använder ännu
  `this.deliveredAt` efter att metoden blivit statisk.
- `invoices/rendering-context.ts:48`: räknar bara giltigt formaterade datum;
  ett extra `/CreationDate (broken)` kan passera. Fryst r21-14 kräver avslag.
- Typecheck pekar dessutom ut array-/regexnarrowing och befintliga tester som
  ännu använder gamla instansingångar. Se `typecheck-utkast.log`.

Miljöantagandet måste gälla hela Chromium-livstiden. Hash vid anropsgränsen kan
upptäcka kvarstående drift men bevisar inte att filer aldrig ändrats och
återställts mellan kontroller medan en varm browser kunnat observera dem.
Skias aktuella källkod har beständiga fontconfig-/fontcacheobjekt; det är
arkitekturstöd, inte ett utfört cachebytesprov av den installerade binären:
[SkFontMgr_fontconfig](https://skia.googlesource.com/skia/+/main/src/ports/SkFontMgr_fontconfig.cpp).

## Inventering, oberoende föreunderlag och råa jämförelser

Full inventering/anropskedjor/fil:rad samt deklaration per dokumenttyp finns i
`kontrakt-och-inventering.md`. Mängden är fem betalnings-PDF-kärnor, tio
kärna/dokumenttyp-kombinationer, tre gemensamma PDF-primitiver och en mejlmotor
med 17 mallar, varav sex aktiva betalningsvarianter omfattas.

Auktoritativt föreunderlag: `before-final-1/2`, båda från basens verkliga renderer
på exakt `5ae9906b152307eae0d79eec719d4303a042742c`.16 PDF-fall per process, varav11 utan förbrukning, plus sex mail.
PDF, HTML, text och köenvelopes ligger kvar råa med SHA256 i manifesten.
JavaScripts dokumentklocka var fixerad till 2026-09-11T12:00:00Z under gammal
HTML-byggnad; Chromiums metadataklocka var verklig. Processerna var separata.
Miljön var Ubuntu 24.04.3 x64, Node 24.11.1/ICU 77.1, Puppeteer 24.40.0,
Chrome 146.0.7680.153 och UTC. Fontbytes/config finns som innehållsfrysta testresurser.

`node docs/granskning/agent3-rendering-2-1/verify-before.cjs` verifierade:

- 396 refererade artefakters råa hash och längd över sex bevarade före-serier.
- 264 råa parjämförelser, inklusive ursprunglig kontra fryst fontmiljö.
- 16/16 PDF per jämförelsepar skiljer rått endast i de två 14-siffriga tidsvärdena
  i Info.CreationDate/ModDate; verklig trailer pekar på Info-objekt 1.
- HTML/text är rått identiska. Tre köenvelopes skiljer endast genom dessa datum
  i sina avkodade PDF-bilagor. Övriga attribut/filnamn jämförs oförändrade.

Exakta råhashar, undantag och byteoffset finns i `verified-before-comparisons.json`.
Råa PDF:er är **inte** byte-identiska. Datumundantaget används bara för den
uttryckliga före-jämförelsen; inget annat innehåll filtreras bort.
Köenvelopes är inte MailWorkers fulla providerbody eller Resends avsändare.

Tidiga testmejl hade manuellt inkonsekventa fält gentemot bilagan. De rättades
före implementation och auktoritativ fångst. Äldre råserier och driver-v1 bevaras.
Originalets fixturkällfil före automatisk formattering ligger i
`fixture-source-before.ts.txt`; dess hash stämmer med samtliga före-manifest.
CI:s designkontroll fällde senare fixturens hårdkodade varumärkesfärg på
`5e4acd9149ab576dfe54a1993818a35a00ae850a`:
[röd kontroll](https://github.com/yasineken2002-sys/eken/actions/runs/34614143128/job/103311736897).
Den nuvarande fabriken använder därför `DEFAULT_BRAND_COLOR`; hela fabrikens
serialiserade resultat jämfördes med den sparade originalkällan och var identiskt.
Alla råa före-filer och manifest är oförändrade. Detta var ett verkligt CI-fel i
testhjälparen, inte den beställda avsiktliga beteendemutationen.

## Rena dokument och visuell före-kontroll

Textgranskningen visar oförändrad sidindelning mellan före-serierna:
rena kundfakturor 1100 kr, hyresfaktura 9000 kr, hyresavi 9000 kr, delmånad 4500 kr,
deposition 18000 kr, delbetald påminnelse 5060 kr, fakturainkasso 960 kr och
aviinkasso 9163,56 kr. Lång ren faktura är fyra sidor, rader 01–13/14–33/34–53/54–55.
OCR 1234567897, mottagare och datumen återfinns där respektive basmall visar dem.

Tre verkliga före-sidor rasteriserades med pdftoppm och inspekterades:
`visual-before/invoice-customer-classic.png`, `notice-rent.png` och
`invoice-customer-multipage-page2.png`. Den rena fakturan och avin visar läsbar
syntetisk logotyp, mottagare, datum, belopp och OCR. Långfakturans nederkant är
mycket trång; textboksgranskningen visar 0,786 pt överlapp mellan sista rad och
footer. Rasterbilden vid 1400 px ger inget säkert bevis för faktisk glyphkollision.
Detta är en före-inspektion, **ingen visuell före/efter-verifiering**.

Kända basbrister: modern faktura saknar synligt fakturanummer. Krediterad
förbrukningsavi och påminnelse har korrekt reducerad total men saknar synlig
kreditrad; specifikationen summerar därför inte. Dessa har inte rättats i 2.1.

Deklarationen behöver vid fortsatt bygge även ange att asOf fångas vid
insamlingsstart. En logohämtning över midnatt kan då ge föregående dags synliga
Datum jämfört med den gamla klockläsningen efter logohämtningen. Det får inte
beskrivas som absolut identiskt värde i alla levande anropsförlopp.

## Provstatus och vad som återstår

Basens verkliga rendering och oberoende före/före-mätning är genomförda.
PDF-vakten passerade i arbetsutkastet: 3 renderingsställen, 10 producenter,
59 mall-literaler i 13 filer. Typecheck är röd; detta är diagnostik och **räknas
inte** som den beställda beteendenegativkontrollen.

Ingen ny renderer har godkända r21-01–14. Inga efter-golden, efter-processprov,
beteendemutation röd→grön eller visuella efter-prov har genomförts. Inget
rättningsbehov har dolts genom att byta facit eller hoppa över tester.
Steg 1:s 17+30 prov och deras CI-kontroll har inte ändrats.
CI på dokumentations-HEAD gäller det committade före-/stoppunderlaget och
basens befintliga produktionskod; den validerar **inte** arbetsutkastet.

Lanseringsnoteringen står i `docs/revision-status.md:3` med exakt SHA-länk till 2b-26.
2.2 är inte byggt: inga snapshots binds till artefakter, ingen verklig adapter
binds till exekveraren, ingen kö/worker/grind aktiveras. Äldre dokument,
produktionsmätning och2c återstår. Modellen lovar varken reproduktion mellan
oprövade OS/motorversioner eller mottagarleverans/läsning.

## Granskare

- `rendering_determinism`: motor/resurser/fontcache och transitiva kodberoenden;
  två blockerande identitetsfynd, uppskattning 495–524 före extra parser/typfynd.
- `rendering_regression`: rena dokument, belopp, sidbrytning, statiska ingångar,
  UTC/CSV/legacy-påverkan och tidpunkten för insamlingsdatum.
- `granska_provider` (ny roll för 2.1): oberoende golden/proveniens/CI/negativa
  kontroller; verifierade råjämförelser, hittade parserluckan och stödjer stopp
  med ofullständigt 440-utkast. Egen rättningsuppskattning 487–530.

Samtliga fynd ovan kvarstår i den ofärdiga patchen. En ny budget från ägaren
behövs innan implementationen kan fortsätta. Inga ytterligare delar föreslås.
