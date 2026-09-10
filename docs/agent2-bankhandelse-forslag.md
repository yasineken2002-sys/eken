# Oapplicerat ändringsförslag: bankhändelsens identitet efter #874

**Produktionsfixen är inte införd.** Den tillåtna leveransen är ett sammanhängande
[patchförslag](eval/bankhandelse-forslag/kandidat.patch), SQL-komponentprov och
samordningsunderlag. Inga produktionsfiler har ändrats. Användarens uttryckliga
förbud mot ändringar i `apps/api/src/reconciliation/**` gäller fortfarande.

I SQL-komponenten blir två verifierat skilda hundralappar **två betalningsrader,
200 kr**. Exakt återimport blir en betalningsrad och ett syntetiskt anropsspår.
Detta bevisar varken ändrad faktisk import eller exakt en bokförings-/köeffekt.
#874:s faktiska före-resultat kvarstår: **11 godkända och 20 avvikande kravfall**.

## Bas och källor

- #874 är fortfarande öppet utkast på `fa15d0d9f3eae17d04afc4d46165cb45205373fa`,
  gren `codex/agent2-bankimport-identitet`. [CI 34415107029](https://github.com/yasineken2002-sys/eken/actions/runs/34415107029)
  är avslutad **grön på exakt denna SHA**, 61 lyckade kontroller.
- Egen gren: `codex/agent2-bankhandelse-forslag`, skapad från ren verifierad bas.
  Main `27a720d4b6fb194fed83c760ce713c6aa70a0ad5` kontrollerad igen, inte integrerad.
  I ursprungligt granskade import-/PSD2-/schemaområdet skiljer endast fyra
  StrictString-rader i `confirm-import.dto.ts`. I kandidatens utökade målområde
  skiljer även `payment-shadow.service.ts`: main har äldre konstantnamn och
  mindre prompttext (6 tillagda/16 borttagna rader jämfört med basen). Kandidaten
  behåller #874-versionen; ändrar bara identitetsgrinden, inga modellinställningar.
- CLAUDE.md läst; inga tillämpliga AGENTS.md hittades i arbetsytans föräldrar,
  rot eller berörda underkataloger. Tidigare överlämning och #874:s faktiska
  rapport, falltabell, resultat och kod lästa. Mac-kopiorna används inte som bygge.
- [Beslutsmodellen](eval/bankhandelse-forslag/beslutsmodell.md) fryst i `b1e5e7c`.
  Nya 31 komponentfall/facit frysta i `9f9b692b`. Första körningen avslöjade ett
  aliaseringsfel i **den nya testgeneratorn**: två fall märkta samma händelse
  hade fått olika ID. Ursprungsversion och felutfall finns kvar i `diagnostik-1`.
  Korrigerade indata v2 frystes i `215a606d`, med **oförändrat krav/facit**.
  Detta ändrar inget av #874:s 31 fall eller originalets 2 000 betalningar.
- SQL och elva tilläggskontrollers krav frysta i `695b539fb8f25a2df8ed1d339d0bfc4135b76acd`
  före körning. [Senaste körningsmanifestet](eval/bankhandelse-forslag/korning-v4/manifest.json)
  innehåller exakta SHA-256 för körda källor och **154 bevarade filer**, inklusive
  historiska data/facit och berörda produktkällor. Originalets 2 000 återspelades
  inte och inga nya matchningsprocenttal beräknades.

## Beslut och minsta samordnade ingrepp

| Underlag | Bankobservation | Ny pengaeffekt |
| --- | --- | --- |
| Samma verifierade konto/namespace/ID och samma finansiella innehåll | Ny oföränderlig observation länkas till samma händelse | Ingen upprepning efter avslutat försök. PENDING får återupptas genom ett atomiskt anspråk. |
| Olika verifierade ID inom samma konto/namespace | Två observationer och två händelser även med samma dag/belopp/OCR | Var sin betalningsrad och sitt importinitierade försök. |
| Samma lokala ID, två verifierat olika bankkonton | Konton och organisation hålls åtskilda | Två händelser; inte en global externalId-nyckel. |
| Fil/API, ny provider eller nytt samtycke utan identitetsbrygga | Underlaget sparas med känd källa; saknad bindning anges | Ingen ny effekt för den obestyrkta observationen. Likhet är varken bevis för samma eller olika pengar. |
| Samma identitet med ändrat belopp, referens eller status | Båda versionerna bevaras och konflikt spärrar fortsatt automatisk hantering | Ingen tyst uppdatering, ny allokering eller återföring. |

Kandidaten är större än att ta bort en sökning därför att lagring, fil/API,
avbrott och befintliga kringvägar måste hänga ihop. [Målfilmanifestet](eval/bankhandelse-forslag/kandidat-manifest.json)
anger exakt bas-/efterhash och skyddsstatus för varje fil. Det är fortfarande
ett **ändringsförslag**, inte en installationsklar eller typkontrollerad produktfix.

1. `reconciliation.service.ts:388,445`: ersätt likhetsdedup i båda ingångarna med
   observation → serverbundet namespace → unik händelse. `computeBankDedupKey:265`
   får finnas kvar för kompatibilitet/likhet men avgör inte identitet. OCR-
   extraktion och befintliga match-/allokeringskroppar lämnas oförändrade utom
   identitetsgrinden vid inträde och innanför befintliga betalningstransaktioner.
2. Föreslagen `bank-event-gate.ts` och SQL-migration: organisationsbundna
   register/bryggor, append-only observationer, BankEvent och PENDING/STARTED/
   DONE/UNCERTAIN/LEGACY. Råinsättningen transporterar befintlig aktörskontext
   centralt och bevarar saldo. Prisma-extensionen körs inte vid denna SQL-insättning;
   riktig aktörsstämpling, effektsökväg och schema-/Prisma-paritet måste verifieras
   efter frigivning. NULL betyder okänd, aldrig påhittad HUMAN.
3. `psd2-sync.service.ts:112–138`: bevara faktiskt provider-/samtyckes-/konto-
   sammanhang per hämtad transaktion. Det är indata till serverregistret, inget
   bevis i sig. Cursor och sidindelning lämnas som separat #874-avvikelse.
4. Separata held/resumed-räknare, observations-ID:n, organisationsbundet
   personaluppslag samt synliga identitetsmått. CSV/BgMax/PDF får inte redovisa
   en väntande observation som import eller dubblett. Färskhets- och periodgrind
   ser även observationer utan betalningsrad. `CONFIRMED` i PDF-avser fortfarande
   bekräftat importunderlag; extra utfall behövs för dess ekonomiska hantering.
5. Automatisk ommatchning och skuggurval/utförande respekterar spärrade händelser.
   Samtliga tre allokeringskärnor, även samlingsbetalningens vattenfall, tar samma
   organisationslås innan banklåset. Token för det
   vinnande försöket kommer endast från serverns interna körningskontext.
   Normal köplacering är aldrig färdighantering; köens verkliga leverans körs inte här.

## Verifierat kontra kvarstående per krav

[Separat eftertabell för rättad SQL-komponent](eval/bankhandelse-forslag/korning-v4/falltabell.md)
innehåller exakt en rad per nytt fall. Den är **inte en efterkörning av #874**.

| Krav | #874 före / oförändrad produktion | Separat SQL-komponent efter |
| --- | --- | --- |
| Två olika ID, samma 100 kr/dag/OCR | I01: 1 rad / 100 kr, avvikelse | Fall 01: 2 rader / 200 kr / 2 testanrop, med syntetiskt styrkt namespace. |
| Exakt återimport | I02: 1 rad, 1 observerat match-/köanrop | Fall 02: 1 rad / 100 kr / 1 markör; två observationer. Riktig kö/allokering otestad. |
| Samtidiga återimporter / skilda händelser | Inga samtidighetsbevis i #874 | Fall 03–04: 1 respektive 2 rader; verklig låsväntan i två PostgreSQL-sessioner. Separat kontroll av samtidigt anspråk: en vinnare. |
| Organisation/konto/provider | Org provad, konto/namespace tappas eller är okänt | Fall 05–09: org/konto skilda, styrkt providerbrygga återanvänder händelse; obundet samtycke eller klientens verified-flagga ger ingen effekt. |
| Fil/API, båda ordningar | Likhet kan tappa skilda händelser | Fall 10: obestyrkt observation hålls; fall 11/12: styrkt samma ger 1 rad, styrkt olika ger 2. Nytt syntetiskt bevis, inte originalindata. |
| Spara/krascha/återförsöka | #874 bevisar inte atomisk fortsatt hantering | Fall 21: rollback av observation+händelse+betalning; 22: PENDING återupptas en gång; 23/24: STARTED kvarstår öppet med 0/1 markör, inget nytt försök. |
| Äldre rader | Okänt konto/namespace kan inte rekonstrueras | Fall 14–17: ingen backfill/ändring; oklar kontinuitet hålls. Fall 15 har olika beskrivningar och hålls nu också. Separat helt innehållslikt bryggprov skapar ingen ny betalning. |
| Ändrat innehåll/status | I05 kallas dubblett utan ändringssignal | Fall 18–20: bevarad konflikt; ingen ny eller omskriven betalning. Konflikt före anspråk stoppar det. |
| Äldre OCR/del-/samlingsbetalning | Historiska metoder och krav bevarade | Fall 27 provar belopps-/OCR-bevarande. Matchkroppars textparitet kontrollerad; inga nya verkliga del-/samlingsallokeringar påstås verifierade. |
| Cursors, tom sida, konto-fel, sidindelning | Kända #874-avvikelser | Inte åtgärdade eller omprovade av SQL-komponenten. |

Före slutgranskning: 31/31 komponentkrav, 10/10 negativa omräkningskontroller
och 11/11 extra SQL-kontroller godkända. Den körningen bevaras i `korning-v2`. Efter första rättelsen kördes
samma 31 komponentindata igen på `4b3e9eee`, med oförändrad fil/facit.
**31/31 skärpta krav**, **10/10 negativa kontroller**, **11/11 tidigare SQL-kontroller
plus 6/6 granskarfall** passerar. Mot det äldre komponentfacitet uppfylls
**30/31**: endast fall 15 ändras från 0 till 2 held-observationer och öppen
identitet. Denna striktare spärr är en redovisad kravändring, ingen förbättring
av oförändrat gammalt mått. Resultat/hashes: [korning-v3](eval/bankhandelse-forslag/korning-v3/omrakning.json)
och [granskarfall](eval/bankhandelse-forslag/granskning-komplettering-resultat.json).
Efter återgranskning kördes samma 31 indata även på `11a39c80`: åter **31/31
skärpta krav, 30/31 äldre krav och 10/10 negativa kontroller**, se
[korning-v4](eval/bankhandelse-forslag/korning-v4/omrakning.json). Status-, valuta-
och negativa beloppskonflikter mot legacy bedöms nu före nybetalningsgrinden.
Tre ytterligare förhandsfrysta fall isolerar respektive signal.
**20/20 SQL-kontroller** (11 tidigare + 9 granskarfall) passerar, se
[slutlig komplettering](eval/bankhandelse-forslag/granskning-komplettering-resultat-v2.json). CSV använder
rätt parameter `filename`; PDF behåller index före filtrering; filproveniens
sparas även när separat verifierad identity-metadata finns.
Tre negativa textkontroller fångar var sin borttagen allokeringsgrind.
Riktig import/Prisma/kö körs fortfarande inte av dessa efterprov. De negativa kontrollerna fångar tappad hundralapp,
dubbelt anrop/belopp, fel summa, förlorad observation, förfalskad kontolänk,
fel organisation, ändrad äldre rad, dold osäkerhet och påhittad samtidighet.
#874:s 5/5 harnesskontroller passerar igen; ny oberoende omräkning av dess
oförändrade inspelning ger 90 verifierade hashvärden, 18/18 negativa kontroller
samt samma 11 PASS / 20 FAIL. Ingen avvikelse har döpts om till godkänt.

## Övergång, antaganden och kvarstående bevis

Ingen verklig providers ID-kontrakt är verifierat; bara Stub/Mock finns i den
lästa anslutningen. Positiva nya prov förutsätter separat syntetisk administrativ
bevisning om samma fysiska konto, ID-stabilitet, slutligt innehåll/datum och
kontinuitet mellan källor/samtycken. En bindning förutsätter att den mottagna
externalId redan är det styrkta kanoniska ID:t; olika leverantörers olika nummer
får inte bindas ihop utan en verifierad översättning, vilken inte implementeras
här. Även leveransens ursprung måste vara betrott: en uppladdad fil, dess hash
eller en ID-kolumn bevisar inte bankens innehåll. Dagens filcallers tillför ingen
verifierad identity-metadata och förblir därför hållna. Positiva filkomponentprov
förutsätter separat syntetiskt styrkt leverans; autentiseringen provas inte.
Registret är tomt efter föreslagen migration.
Ingen klient kan själv skapa denna bevisning genom OCR eller en flagga.

Gamla betalningsrader och `@@unique([organizationId, externalId])` bevaras.
Nya rader har null i gamla externalId; original-ID finns i händelse/observation.
En brygga till äldre rad kräver uttryckligt granskat samband och innehållskontroll.
Alternativt krävs styrkt avgränsning mot äldre historik, immutable bankdatum och
kontroll att inga okopplade äldre rader motsäger gränsen. Migrationstid räcker inte.
Inga historiska belopp, allokeringar eller konton skrivs om.

**Aktivering är en separat spärr:** utan verifierade bindningar hålls dagens
filflöden och API-observationer utan komplett identitet. Det är säkert mot en
ny dubbel effekt men ingen acceptabel tyst driftsättning. Registrering av verkliga
bevis, hantering av öppna observationer/avbrott samt begriplig personalvy måste
beslutas och provas innan aktivering. Denna första kandidat har läsning och
spärr, ingen upplåsnings-/omfördelningsfunktion: gamla HELD-observationer förblir
synligt öppna. Säkert styrkta nya händelser går automatiskt i komponentproven.

SQL-proven kör PostgreSQL 16.13 i egen verifierat tom databas, Unixsocket,
`network=none`, inga portar/värdvolymer, tmpfs, 512 MB och en CPU. Provider,
Nest, Prisma och dess extensions ersätts helt; BankTransaction/Organization är
minimala syntetiska gränstabeller. Markörer ersätter all matchning, allokering,
bokföring och kö. Riktig unikhet, rollback och låsväntan provas; värdkrasch,
produktionsdatabasens fulla schema, Redis, leveransgarantier och låsordning
med samtliga befintliga arbetare gör det inte. Gamla skribenter tar inte det
nya organisationslåset: ingen överlappande driftsättning får antas säker.

Efter uttrycklig frigivning behövs typ-/Prisma-validering, migration mot tom
**fullständig isolerad** testmodell, de oförändrade 31 #874-fallen mot faktisk
kandidat och riktade verkliga allokerings-/köprov med felinjektion. Ingen
exakt-en-gång-garanti får härledas från den enda raden eller markören.

## Reproduktion

Befintlig Python, Node 24 och redan installerad `postgres:16-alpine`; inga
installationer. Kontrollera disk och `pgrep -af '[j]est|[t]sc'`, kör sekventiellt.
Kommandona ändrar endast egen ny utkatalog/testcontainer eller patchartefakten.

```sh
python3 -B apps/api/scripts/bankevent_proposal/run.py --out /tmp/bankevent-new-run
python3 -B apps/api/scripts/bankevent_proposal/audit.py /tmp/bankevent-new-run --review-requirements --out /tmp/bankevent-new-run
python3 -B apps/api/scripts/bankevent_proposal/review_controls.py --out /tmp/bankevent-new-controls.json
python3 -B apps/api/scripts/bankevent_proposal/audit.py docs/eval/bankhandelse-forslag/korning-v2 --evidence-commit 6264d3ad
python3 -B apps/api/scripts/bankevent_proposal/audit.py docs/eval/bankhandelse-forslag/korning-v4 --review-requirements
python3 -B apps/api/scripts/bankevent_proposal/check_patch.py
node --experimental-vm-modules apps/api/scripts/test_bankimport_harness.cjs
python3 -B apps/api/scripts/audit_bankimport.py docs/eval/bankimport-identitet/korning-slut/observationer.json.gz --evidence-commit ebc87b85
git diff --check
git diff --stat fa15d0d9f3eae17d04afc4d46165cb45205373fa
```

`check_patch.py` gör enbart torr `git apply --check`, TypeScript-syntaxtransform
utan körning och bytekontroll av orörda målfiler. Det är ingen typkontroll eller
körning av kandidatens importmetoder. Vanlig CI provar den oförändrade appkoden,
inte innehållet i en oapplicerad patch. Inga Jest/tsc-jobb startades lokalt.

Efter granskning frystes starkare krav i `fe9142c5`, utan ändring av
`indata-v2.json` eller `facit.json`. Hela beskrivningen är matchningsbärande,
liksom OCR/reference. Komponentfall 15 hade äldre beskrivning `SYNTHETIC LEGACY`
men ny `SYNTETISK`: enligt skärpt regel ska båda återobservationerna hållas.
Den äldre förväntningen om noll held ligger kvar oförändrad. Nya kontrollkrav
anger uttryckligen denna enda förväntningsskillnad och provas separat. Ett
kompletterande exempel med **ändrad syntetisk äldre beskrivning** visar hur en
helt innehållslik verifierad brygga kan återimporteras; det är inte originalfallet.

Granskningsrättelserna omfattar också beständig spärrlänk vid legacykonflikt,
filproveniens separat från bankbevis (format, filhash/import-ID, index i den
parsade listan — inte påstått ursprungligt radnummer), uttryckliga resultatmått
för återupptagna PSD2-försök och typad statistik. Void-låsanropet projiceras till
text för Prisma-adaptern; riktig Prisma-runtime är fortfarande oprövad.

Se [granskningsunderlaget](eval/bankhandelse-forslag/granskning.md) för självständiga
AI-granskningar och hanterade fynd. Claude granskar och mergar senare.


## Exakt samordningsgräns

Föreslagen diff omfattar elva målfiler; samtliga ligger fortfarande enbart i
patchtexten. Följande fyra mål ligger inom användarens uttryckligt skyddade
katalog och kräver uttrycklig frigivning innan de får införas här:

- `apps/api/src/reconciliation/reconciliation.service.ts`
- `apps/api/src/reconciliation/reconciliation.controller.ts`
- `apps/api/src/reconciliation/bank-statement-import.service.ts`
- `apps/api/src/reconciliation/bank-event-gate.ts` (ny fil)

Övriga sju mål är PSD2-synk, två skuggvägar, färskhet, periodkontroll,
Prisma-schema och en separat föreslagen migration. Inte heller dessa är
applicerade: leveransen innehåller ingen halv produktionsfix. Kontoplan,
originaldata och allokeringsregler ändras inte. Minsta nästa tillåtna steg efter
frigivning är att införa kandidaten samordnat på egen gren, validera full
Prisma-/typkoppling och köra de faktiska import-/allokeringsvägarna isolerat.
Aktivering och verifierade bank-/övergångsbevis är därefter separata krav;
ingen produktionsskrivning eller driftsättning är godkänd av denna rapport.
