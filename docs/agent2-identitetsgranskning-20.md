# Agent 2 — tjugo identitetsfall efter #871

**0 av 20 kan lösas säkert med befintliga verifierade bankuppgifter.** Tio
saknar betalningsavsikt i bankfältens innehåll och tio har en verklig konflikt
mellan OCR och avinummer/fullnamn. De kräver i nuläget en spårbar uppgift från
kund eller personal. Inget befintligt tappat fält har visats lösa något av
dessa fall. Detta är en fallgranskning, inte en ny matchningskörning eller
produktionsimplementation.

Bas: #871, `codex/agent2-tillgodo-livscykel`, HEAD
`6c2f06f071ff19d2bd994c8ee09ba4af8c94b5c2`. PR var öppen som utkast och dess
[CI](https://github.com/yasineken2002-sys/eken/actions/runs/34398332211) var
`completed/success` på exakt denna HEAD vid kontroll 2026-09-09.
Ny gren: `codex/agent2-identitetsgranskning-20`. Arbetsytan var ren.
CLAUDE.md och de faktiska referens-, överskotts- och livscykelrapporterna är
lästa. Deras resultat finns i filerna; ingen saknad rapport har antagits.

## Entydig kategorisering — nämnaren är 20

| Primär kategori för de befintliga händelserna | Antal | Innebörd |
| --- | ---: | --- |
| Säkert lösbar med befintliga verifierade uppgifter | 0 | Ingen ytterligare sådan uppgift finns belagd |
| Verifierat lösbar enbart genom ändrad integration/betalningsupplevelse, utan ny mänsklig uppgift | 0 | Ingen levererad bankpayload eller annan verifierad mekanism styrker det |
| Kräver mänskligt bevis med nu känt underlag | 20 | 10 saknade identifierare + 10 referenskonflikter |
| Kan ännu inte kategoriseras från tillgängligt fallunderlag | 0 | Samtliga 20 kan placeras ovan |
| **Summa** | **20** | Varje transaktions-ID förekommer exakt en gång |

Kategorierna gäller vad som är **belagt för de frysta händelserna**, inte
vilken framtida produkt som kan förebygga dem. Leverantörers faktiska fälttäckning,
kunders svar och framtida förebyggande effekt är fortfarande okända. Att
banktjänsten möjligen har fler fält ger inte rätt att flytta ett fall till
integrationskategorin. Kundbekräftelse är mänsklig medverkan även om personalen
slipper ett arbetsärende. Ett svar kan beröra flera betalningar, men varje
berörd betalning har då fått mänskligt stöd.

## Tabell — en rad per faktiskt problemfall

Den fullständiga tabellen med **exakt 20 rader** finns i
[falltabell.md](eval/identitetsgranskning-20/korning-1/falltabell.md).
Den visar stabilt syntetiskt ID, datum/belopp/text/referens, importens lagring,
matchnings-/agentfält, konkurrerande avier/avtal, hinder och minsta ytterligare
bevis. Inga riktiga personuppgifter används. Namnen där är generatorns
syntetiska namn, inte verifierade kontoinnehavarnamn.

[fall.json](eval/identitetsgranskning-20/korning-1/fall.json) innehåller dessutom
observerade bankrader från alla fyra historiska DB-körningar, samtliga deras
sparade kandidatnummer, fullständig referensrelaterad avilista inklusive betalda,
och skulder före respektive betalning i alla fyra sparade #871-lägen.
Tabellens beloppsalternativ är uttryckliga exempel på tvetydighet, inte ett
filter som utesluter delbetalningar, samlingsbetalningar eller andra ändamål.

**Bevisnivån i tabellen:** ingen fysisk ursprunglig CSV-fil finns sparad bland
bevisfilerna. CSV-raden återskapas från den frysta generatorns bankfält, exakt
enligt den sparade körkodens format. Datum, text, belopp och `rawOcr` jämförs
med fyra sparade DB-observationer per fall: **80/80** stämmer. Fältet
`BankTransaction.reference` togs inte med i det historiska dumpformatet;
dess lagring är därför belagd genom importkoden, inte genom ett sparat DB-värde.
Ingen ny databasfråga eller import har körts här.

## Fynd i de två grupperna

`betalning-56-0` … `betalning-56-9` har text **Inbetalning**, tom referens och
9 500,50 kr på månadens 25:e. Det finns inget avsändarnamn, avsändarkonto,
avinummer eller uttryckt hyresperiod. I det publika aviregistret har bland
annat `avtal-56`, `avtal-116` och `avtal-176` exakt samma grundhyra. Bankmånad
är inte hyresperiod och samma belopp tio gånger bevisar inte att samma person
betalat. En återstående öppen skuld kan inte göra den anonyma raden identifierad.
Generatorns kännedom om `hyresgast=56` är **inte** en bankuppgift.

`betalning-58-0` … `betalning-58-9` har 10 050,25 kr och texten
`Hyra AVI-ÅÅÅÅ-MM-0059 Freja Sundberg`. Referenskolumnen innehåller däremot
**00000001198**, som hör till **Freja Nyberg / avtal-118**, inte
**Freja Sundberg / avtal-58**. Båda har exakt samma grundhyra. OCR:t har en
giltig kontrollsiffra enligt den frysta implementationen. Det visar att
numret är formellt giltigt, inte att kunden avsåg OCR-ägarens avi. Textens
samstämmiga namn och avinummer gör inte heller den motsägande OCR:n ofarlig.

Det sparade #871-förloppet visar för **10/10 konflikter** att OCR-ägarens
aktuella avi har skuld **0 öre i grundordningen** och **1 005 025 öre i omvänd
ordning** när konflikten kommer in. Detta gäller både A och B. Underlaget är
omläst ur sparade operationer, utan nya beslut. Att filtrera bort en betald
OCR-ägare kan därför ge skenbar entydighet beroende på ordningen. Betald status
förklarar inte om raden är en dubbelbetalning, fel referens eller betalning
för någon annan. Identitet och aktuell betalbar skuld behöver skilda uppslag.

Originalfacit föreskriver granskning och tom allokering för alla 20. Det
användes först efter inventeringen för kontroll. Inga avsikter eller nya
bankfält har konstruerats från `facit.avseddAvi`.

## Fältspår med fil:rad

Radnummer avser den oförändrade koden vid bas-HEAD. Spårnamnen återkommer i
falltabellen. Sökvägar under `apps/api/src/reconciliation/` har enbart lästs.

| Spår | Källa och flöde | Vad det belägger |
| --- | --- | --- |
| F1 | `apps/api/src/ai/shadow/eval/kundflode-2000.ts:40`, `:198`, `:218` | Fixturetypen skiljer bankfält från metadata/facit. De två grenarna skapar tom identifiering respektive den felpekande OCR-källan |
| F2 | `apps/api/scripts/eval-kundflode-2000.ts:277`, `:332`, `:336` | Seeder tilldelar OCR; `ocrFranHyresgast` väljer vilken inmatad referens som skrivs i CSV. CSV har endast Datum, Text, Belopp, Referens |
| F3 | `apps/api/src/common/ocr/ocr.service.ts:37`, `:96`; `packages/shared/src/utils/index.ts:85` | Organisationsbunden tilldelning och kontrollsiffra. OCR-identitet får inte härledas som global organisations-/personidentitet |
| I1 | `apps/api/src/reconciliation/reconciliation.service.ts:154`, `:167`, `:526`, `:692`, `:698` | CSV väljer första igenkända kolumn för datum/text/belopp/saldo/referens. Text och separat reference sparas; rawOcr extraheras från referens före prosa |
| I2 | `apps/api/src/reconciliation/ocr-proveniens.ts:102`, `:119` | Numerisk extraktion respektive Luhn-grind på prosa. Godkänd form bevisar inte korrekt avsikt |
| D1 | `apps/api/prisma/schema.prisma:2516`; `apps/api/scripts/eval-kundflode-2000.ts:359` | DB har date, description, amount, balance?, reference?, rawOcr?, externalId?, dedupKey?. Dumpen visar bara id/datum/text/belopp/rawOcr |
| M1 | `apps/api/src/reconciliation/reconciliation.service.ts:855`, `:865`, `:956`, `:1006` | Matcharen får hela transaktionen. OCR-grenen kan returnera före senare avinummerkontroll i description+reference. #869/#871:s Python-spärr är inte integrerad där |
| M2 | `apps/api/src/ai/shadow/payment/payment-shadow.service.ts:118`, `:159`, `:245`, `:642`; `payment-candidates.ts:85`, `:191` | Skuggagentens Bankrad är id/datum/text/belopp/rawOcr, utan original-reference. Kandidater omfattar öppna avier/fakturor och saknar explicit avtals-/hyresperiodfält. Betalda identiteter ingår inte i detta uppslag |
| M3 | `apps/api/src/reconciliation/bank-transaction-views.ts:72`; `apps/api/src/ai/tools/tool-executor.service.ts:3983`, `:4008` | Avstämningsvyn innehåller reference/rawOcr. Verktygen get_bank_transactions och get_unmatched_transactions projicerar vidare text och rawOcr men tappar reference; det första har dessutom ett visningslimit |
| P1 | `apps/api/scripts/eval_referensprov.py:31`, `:63`; `referensprov_policy.py:49`, `:77`; `eval_tillgodo_lifecycle.py:31` | #869/#870 bygger en publik Bank/Notice-projektion; #871 läser den hashbundna artefakten. Inmatad OCR rekonstrueras enligt generatorn, inte från facit. Bank får org/date/amount/text/reference; Notice har ägare, avtal, period och även betalda identiteter |
| P2 | `apps/api/scripts/eval-kundflode-2000.ts:411`; `apps/api/src/ai/shadow/payment/payment-shadow.service.ts:159` | Historiskt sparat regel-/kandidatunderlag är inte ett utfört modellsvar. Inget modell-/bankanrop behövs för inventeringen |

**Bevisat tappat i gränssnittet är inte bevisat lösande:** original-reference
saknas både i skuggagentens rad och i de två bankverktygens utdata. För just
dessa 20 är det antingen tomt eller samma numeriska OCR som redan finns i
`rawOcr`. Att föra vidare fältet ger därför **0 belagda nya säkra beslut** här.
Den fullständiga banktexten finns kvar; den är inte avklippt i dessa CSV-fall.

**Andra möjliga tapp, med tydlig räckvidd:** CSV väljer en enda textkolumn och
en enda referenskolumn, så separata extra motparts-/meddelandekolumner kan falla
bort (`I1`). BgMax-vägen läser TC05 och TC20/21, referens och belopp och skapar
egen description (`reconciliation.service.ts:782`); övriga posttyper bearbetas
inte där. PDF-vägen har date/description/ocr/amount/isIncoming och klipper
description till 120 tecken (`pdf-statement-parser.service.ts:60`,
`bank-statement-import.service.ts:377`). Inget av dessa andra format/extra fält
finns som ursprungsunderlag för de 20. Ingen generell parser-/formatcertifiering
eller faktisk förlust av ett lösande fält i dessa fall påstås.

## Fyra nivåer av tillgänglig information

| Nivå | Vad vi vet | Vad vi inte får anta |
| --- | --- | --- |
| **1. Bevisligen i originalunderlaget** | Datum, belopp, text och referens enligt F1/F2; 80 observerade importerade bankrader. Konflikttexten och andra ägarens OCR finns samtidigt | Fixture-id, typ, hyresgast, period och facit är inte inkommande bankidentifierare. CSV:ns organisation väljs av riggen, inte av betalaren |
| **2. Implementation kan ta emot, men saknas här** | CSV: saldo och alternativt separat referens-/textinnehåll. API-port: externalId, bookingDate, booked, currency, amount, description, ocr?, reference? | Det finns inget externalId från banken, extra remittance, avsändarkonto eller kontoinnehavarnamn i de 20. API-porten har inga egna debtor-/avsändarkontofält. Kundnamn i fritext är inte bankverifierat namn |
| **3. Officiellt dokumenterad bankmöjlighet, obekräftad hos oss** | Enable Banking beskriver valfria debtor/debtor_account, remittance_information och reference_number. Dess entry_reference är kontobundet; transaction_id är ett detaljhämtnings-id som kan ändras | Fält i leverantörens schema är inte garanterad leverans för svensk bank, tjänst, konto, samtycke eller vår adapter. Inget sådant råsvar finns här |
| **4. Ny mänsklig uppgift** | Kundens eller behörig personals dokumenterade koppling mellan faktisk transaktion och avsedd avi/avtal, plus förklaring av motstridig referens eller fördelning | Namn, konto, historik eller ett klick på ett förvalt val får inte ensamt räknas som bevis. Anhöriga kan betala; flera avtal och del-/samlingsbetalningar måste kunna anges |

Nivå 3 kontrollerades 2026-09-09 mot
[Enable Bankings officiella API-referens, Transaction](https://enablebanking.com/docs/api/reference/#transaction).
Uppgifterna beskriver möjliga fält och identifierarnas begränsningar, inte ett
avtal eller en ansluten bank. Dokumentationen lästes publikt; inga bankendpoints
anropades. Ingen leverantörstext används för att fylla ut de frysta bankraderna.

## Faktiskt stöd i vår bankanslutning — läsande kontroll

`apps/api/src/psd2/psd2.types.ts:18` definierar ovanstående `ProviderRawTx`.
`ProviderAccount` på `:29` har konto-id, valuta och möjligt IBAN för det konto
samtycket listar; det är inte ett avsändarkonto per inbetalning.
`psd2-sync.service.ts:40` vidarebefordrar datum/status/valuta/belopp/text och
eventuell ocr/reference. `:135` skickar externalId separat till ingest, medan
organisationen kommer från vårt samtyckesjobb.
`reconciliation.service.ts:445` validerar bokförd/SEK/positiv transaktion och
sparar valda fält; valuta/status fungerar som grindar och är inte egna
BankTransaction-kolumner. `raw.ocr` prioriteras framför extraktion ur
reference/text, så originalfältens proveniens är viktig vid framtida mappning.

Factoryn `psd2-provider.factory.ts:48` väljer stub när avstängt, mock endast
utanför produktion under dess förutsättningar och kastar annars om **saknad
skarp adapter** (`:72`). `providers/mock-bank-data.provider.ts:38` innehåller
tre fasta testtransaktioner, inte livebankfält. Kodgrenen har alltså ingen
implementerad skarp Enable Banking-/Tink-adapter att verifiera en fältmappning
i. Miljövariabler, tokens, samtycken och riktiga konton har inte lästs.
Driftens konfiguration och bankens faktiska fälttäckning är **obekräftade**.
Ingen slutsats om tillgängliga avsändarkonton eller namn hos en verklig kund dras.

## Hypotetiska exempel — inte ändrade originalfall eller provutfall

| Separat exempel | Ny uppgift/ändrat antagande | Möjlig nytta och kvarvarande gräns |
| --- | --- | --- |
| HYP-EXTRA-TEXT, en ny syntetisk bankrad | En extra remittance-rad innehåller ett entydigt avinummer, och en kommande adapter bevarar den | Kan ge en ny referenssignal efter konfliktkontroll. Det fältet finns inte i originalfallen; nytt import-/beslutsprov krävs |
| HYP-ANHORIG, en ny rad för kund med bostad och garage | Bankens eventuella avsändarnamn/konto tillhör en anhörig | Ingen säker aviallokering följer. Även ett känt kundkonto skiljer inte två avtal eller ett delbelopp |
| HYP-BEKRAFTELSE, en ny referenskonflikt | Kunden anger avsedd avi, förklarar den andra referensen och knyter svaret till transaktionen; svaret lagras med behörighet och tid | Kan ge ett granskningsbart allokeringsunderlag, men är mänsklig medverkan. Ingen sådan bekräftelse finns eller har begärts i originalserien |

Inga av dessa exempel har räknats in i 20 eller 2 000. Vi har inte kört ett nytt
beslutsprov, eftersom granskningen inte hittade befintliga verifierade fält som
löser fallen. Unika avireferenser prövades redan separat i #869 utan extra
lyft för grundserien; nytt OCR-format föreslås inte som bevisad lösning.

## Minsta nästa produktändring, prioriterad

**1. Gemensam identitetskonfliktspärr före första allokering.** Låt alla
ursprungliga reference-/OCR-/avinummersignaler granskas tillsammans mot ett
organisationsbundet identitetsregister som också omfattar betalda avier.
Håll det uppslaget skilt från vilka skulder som går att betala. Vid konflikt
ska inget allokeras; visa de två faktiska signalerna och varför kontroll
behövs i befintligt granskningsunderlag. Bevara originalfält och deras källa.
Det är ett avgränsat skydd, inte en ny automatisk gissningsväg.

Förväntad nytta: skydda de **10 konfliktbetalningarna** mot den för tidiga
OCR-väg som gav fel i de historiska #868-resultaten. **0 nya automatiskt
lösta identitetsfall** är belagda av denna granskning; #871:s experiment avstår
redan korrekt. Nytta i personalminuter är inte mätt. Innan en produktions-PR
får hävda effekten behövs en isolerad körning av faktisk parser → DB → matchare
på alla 2 000 i båda ordningarna, utan modell-/bankanrop. Kontrollera inga
allokeringar/verifikat vid konflikt, även när andra ägarens avi är betald,
plus org-gräns, flera avtal, äldre OCR, 150 delbetalningar och 75
samlingsbetalningar. Originalfacit och svåra fall ska ligga kvar. Den körningen
har **inte** gjorts i denna uppgift.

**2. Spårbar komplettering i befintlig granskningsvy.** Nästa ändring efter
spärren bör kunna visa source/reference/rawOcr/text separat och ta emot en
uttrycklig, behörig uppgift om avtal, avi(er), period och fördelning med skäl.
Koppla varje svar till stabil bankhändelse och bevara tidigare motstridiga
uppgifter. Bygg inte kundutskick samtidigt. Prova separat med hypotetiska svar,
nekade svar, anhörigbetalning, flera avtal och fel organisation. Mät lösta
fall **med mänskligt stöd** och arbetstid, inte förbättrad automatiktäckning.

**3. Verifiera framtida adapterfält före en integration som ska lösa fler fall.**
Kräv ett godkänt syntetiskt/redigerat råformat och dokumenterad bank-/kontotäckning.
Bevara extra referenser utan att slå ihop konflikter, och prova fälttapp,
trunkering, tomma fält och stabil transaktionsidentitet. Ett tekniskt id eller
avsändarkonto är i sig aldrig kundens instruktion om vilken skuld som ska regleras.

## Kontroller, reproduktion och oförändrade mått

Plan och granskningsskript frystes i `13db0d97` före negativa kontroller.
Skriptet importerar ingen matchningspolicy, produktionskod, databas- eller
modellklient. Alla originalmanifestets **15 filer** verifierades mot deras
uppackade SHA-256. #870:s publika underlag och #871:s resultat/källhashar
verifierades separat. Det frysta kund-/facit-underlagets SHA-256 är
`3118bcbac637f5b56698a9b18961a8dd949c84749fba9d7fb04f2e893e1b8b47`.

Kontrollen kräver 20 unika **rätta medlemmar**, 10+10 skäl och tomt originalfacit
för allokering först i efterkontrollen. Att ersätta facit och scenario-/ägarmetadata
med oanvändbara objekt lämnar inventeringen identisk. **7/7 negativa kontroller**
avvisades: saknat, dubblerat eller utbytt fall, påhittad referens, dold konflikt,
falsk lösningskategori och dolt sluttillgodo. Befintliga **57/57** prov och
**11/11** livscykelprov passerade utan ändring. Ingen ny PostgreSQL-körning,
Jest/tsc, installation eller tung parallell körning behövdes. Före arbetet:
2,2 GB ledigt på arbetsdisken, 37 GB på /tmp, cirka 3,6 GB tillgängligt RAM.

Från arbetsytans rot, välj en ny resultatkatalog:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/audit_identitetsfall_20.py /tmp/eveno-identitetsgranskning-ny
PYTHONDONTWRITEBYTECODE=1 python3 docs/eval/identitetsgranskning-20/kontrollera-rapport.py /tmp/eveno-identitetsgranskning-ny
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/api/scripts -p 'test_*prov.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/api/scripts -p test_tillgodo_lifecycle.py -v
```

`docs/eval/identitetsgranskning-20/` innehåller plan, falltabell/JSON/manifest,
regressionsloggar, separat antal-/hashkontroll, källspår, bas-PR/CI och diffstat.
Den separata kontrollens skript och utfall sparas för reproduktion.

**Ingen omräkning av nya matchningsbeslut på 2 000 har gjorts.** Oförändrat
historiskt originalmått är **1 970/0/30**. Sparat #871 ger i båda ordningarna
**1 980 korrekta allokerade, 1 979 färdighanterade under antagandena, 0 fel och
21 granskning**. Utöver dessa 20 identitetsfall finns fortsatt
`betalning-57-9`: **250 kr tillgodo i A**, **25 kr i B**, en sista post utan
senare avi i tiomånadershorisonten. Den separata elfte månaden ändrar inte
originalets nämnare eller denna inventering.

Ingen kundkontakt, riktig betalning, produktionsskrivning, extern AI-körning
eller ändring under `apps/api/src/reconciliation/**`. `/workspaces/eken-codex`
och Mac-säkerhetskopior används inte. Ingen garanti om 99,98 % i drift.
Endast svensk utkast-PR mot #871:s gren; Claude granskar och mergar senare.
