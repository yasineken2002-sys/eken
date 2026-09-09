# Agent 2 — lokal prototyp för kundklarläggning

Detta är en isolerad prototyp med syntetiska uppgifter, simulerad inloggning
och simulerad oberoende beviskälla. Ingen produktionspolicy, verklig
identitetsverifiering, bankanslutning, bokföringsintegration eller leverans till
kund är bevisad. Inga externa modell-, bank-, e-post- eller SMS-anrop görs.

Bas är utkast #872, `codex/agent2-identitetsgranskning-20`, exakt
`e4a72d3002c195e78c01baac4704a7326973547e`. Basens CI kontrollerades grön:
<https://github.com/yasineken2002-sys/eken/actions/runs/34402621626>.
Ny gren: `codex/agent2-kundklarlaggning-prototyp`. Överlämningen, CLAUDE.md,
rapporterna för #871/#872 och den faktiska falltabellen är lästa.

## Bevisgräns och frysta antaganden

Förväntningarna frystes **före körning** i `571f5c69`,
[`policy-v1.json`](eval/kundklarlaggning/policy-v1.json).
Ett separat serverägt intyg måste styrka behörigheten att förfoga över **just
denna överföring**, bundet till oförändrad bankhändelse, organisation, person,
hyresgäst och tillåtna avtal. Ett separat verifierat kontaktregister och en
autentiserad person måste stämma med bindningen. Kontoinnehav, namn, belopp,
inloggning, ett klick, självpåstådd referens eller uppladdat kvitto räcker inte.

I B installeras detta som `SIMULATED_INDEPENDENT_ATTESTOR` av testbootstrap.
Ingen HTTP-väg kan lägga till eller upphöja bevis. Den verkliga källa som
skulle kunna styrka denna behörighet är **ännu inte etablerad**. Den får inte
ersättas med en vanlig kundbekräftelse i en framtida integration. Nuvarande
bankanslutnings tillgång till fler identifierande fält är fortfarande okänd.

Ingen säker mottagare innebär inget utkast, ingen kundlänk och ingen visning
för gissade kunder. Banktext som kan nämna andra kunder visas inte i kundvyn.
Kvarvarande motstridiga identifierare går alltid till personal, även med
intyg och bekräftelse. OCR-checksiffran bevisar inte betalningsavsikten.

Kunden anger uttryckliga heltalsören på egna tillåtna avier. Delbetalning och
flera avier inom samma avtal stöds. Kunden kan uttryckligen välja ett annat
eget tillåtet avtal; fördelning över flera avtal hålls för personal. Ingen
tyst flytt, automatisk återbetalning eller framtida kvittning görs. Styrkt
överskott kan hållas separat, men betalningen är då **inte färdighanterad**.

## A och B hålls åtskilda

**A:** exakt de 20 hashbundna originalbankraderna, utan nya bevis. Fälten går
från sparad offentlig bankprojektion till ärende. Falltabellen väljer endast
vilka 20 som granskas. Gold/facit och generatorns hyresgästetiketter används
inte i beslut. Befintlig OCR-/avi-konflikt bevaras från offentliga bank- och
avifält. Ingen ny helåterspelning av 2 000 har gjorts.

**B:** 13 helt nya transaktions-ID:n `B-*`, med små testbelopp och separata
syntetiska avier. De innehåller nya antaganden om betalningsbehörighet,
mottagare, simulerad inloggning och svar. Det är aldrig originaltestet med
förbättrad matchning. Förväntningarna är:

| Ömsesidigt uteslutande betalningskategori | A: original 20 | B: nya 13 |
| --- | ---: | ---: |
| Helt automatiskt utan människa | 0 | 0 |
| Löst med kundens medverkan | 0 | 3 |
| Kräver personal, ännu inte avslutat | 20 | 8 |
| Väntande/olöst (inklusive osänt utkast) | 0 | 2 |
| Summa betalningsärenden | 20 | 13 |

Tre positiva B-fall är full betalning, delbetalning och samlingsbetalning på
två avier inom samma avtal. Övriga är tillgodo, avböjande, timeout,
förfalskat underlag, saknad behörighet över pengarna, referenskonflikt,
motstridigt svar, ändrad skuld, väntan och osänt utkast. Varje kundsvar är
mänsklig medverkan; väntan och personalplacering är aldrig lyckat avslut.

Förhandsbestämd penningkontroll för B: fyra testbetalningar, fem
allokeringsrader, 405 kr bank = 380 kr allokerat + 25 kr utestående tillgodo.
Tillgodot gäller `B-credit`, ett av de åtta personalärendena; det räknas inte
en gång till. `B-debt-changed` får en särskilt märkt felinjektion på minus ett
öre i testskulden efter frågan. Den är inte en ny bokförd betalning, och
provet påstår inte fullständig huvudboksavstämning för den muterade skulden.

Historiken ändras inte: originalmått **1 970/0/30**. #871 hade under sina
antaganden 1 980 allokerade, 1 979 färdighanterade, noll fel och 21
granskningsbetalningar. Den separata sista tillgodobetalningen
`betalning-57-9` ligger kvar utanför dessa 20 och nya B: 250 kr utestående i
#871 A respektive 25 kr i dess alternativa B. Ingen ny procentsats för hela
2 000 eller garanti om 99,98 % anges.

## Lokal demo

Kräver befintlig Python 3, Docker och redan lokalt installerad
`postgres:16-alpine`. Inga beroenden installeras eller images hämtas.
Från den här worktreen:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/demo_kundklarlaggning.py
```

Servern binder enbart `127.0.0.1:8873`. Använd en **privat lokal tunnel** från
Codespaces till datorns `127.0.0.1:8873`, med oförändrad Host/Origin. Öppna
startlänken som skrivs i terminalen. Gör aldrig porten publik. En Codespaces
proxy med annat värdnamn avvisas avsiktligt; ändra inte spärren för att kringgå
det. VS Code Desktop med privat portvidarebefordran till localhost passar
detta upplägg; tunnel/visuell webbläsarkörning verifieras separat från HTTP.

Startnyckeln är demonstratörens privata kontroll för att växla mellan
simulerade personer, **ingen riktig kundinloggning**. Börja som `staff`, fånga
en B-förfrågan lokalt, växla till `alice`, öppna frågan och ange heltalsören.
`B-full` kan exempelvis få 10000 öre på `B-full-avi-1`. För `B-combined` anges
10000 + 4000 på de två egna avierna. För `B-credit` anges 10000 och separat
tillgodoval. `bob` och `other-org` har inga av dessa frågor. Startlänken ska
inte delas med en kund. Status, verifieringskälla och historik visas för
personal; kundvyn visar enbart tillåtna uppgifter. Ctrl+C tar bort endast
den egna testcontainern. Alla demouppgifter är flyktiga.

## Databasbevis och reproduktion

`tillgodo_pg.py` från #871 återanvänds oförändrad. Före första tabellskrivning
verifieras ny egen containeretikett, `network=none`, inga publicerade portar,
Unix-socket, exakt testdatabas, tom databas och lokal tmpfs. Containern har
512 MB minne, en CPU och begränsad tmpfs. Alla nya tabeller är `cf_*` i en ny
egen `exp_cf_*`-schema tillsammans med tidigare experimentets testtabeller.
Endast `TEST_*`-verifikationer förekommer, inga BAS-/produktionskonton.

Svar, allokering, skuld, tillgodo, testverifikation, status, revisionsspår och
förbrukad länk ingår i samma PostgreSQL-transaktion. Länkar binds till person,
organisation och betalning, har 30 minuters maximal giltighet, lagras hashade
och förbrukas en gång. Identiskt autentiserat återförsök med samma
begärande-ID/payload returnerar sparat utfall inom giltighetstiden. Annat
återbruk nekas. Databasradlås serialiserar svar; provet observerar faktisk
`pg_stat_activity.wait_event_type=Lock` mellan två separata psql-sessioner.

Fel injiceras efter skulduppdatering, tillgodobildning, testverifikat,
ärendestatus samt audit/länkförbrukning. Därefter ska återförsök ge exakt en
effekt. Databasen bevisar transaktionsrollback och låsväntan för just detta
prov; den bevisar inte produktionsautentisering, driftbehörigheter,
bankbevisens äkthet eller överlevnad vid värddatorhaveri. Testdatabasen har
en administrativ testanvändare, ingen verifierad produktionsrollmodell.

Kör sekventiellt, med utrymmeskontroll först:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/api/scripts -p 'test_*prov.py'
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/test_tillgodo_lifecycle.py
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/test_kundklarlaggning.py
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/eval_kundklarlaggning.py --out /tmp/kundklarlaggning-egen-korning
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/audit_kundklarlaggning.py /tmp/kundklarlaggning-egen-korning/resultat.json.gz
node --check apps/api/scripts/kundklarlaggning_demo/app.js
```

Omräkningen importerar inte server, SQL-adapter eller beslutsmodell. Den
kontrollerar originalrader, statuskedjor, kundmedverkan, intygens bindning,
ägarskap, varje allokering/tillgodo och exakt balanserade testverifikationer.
Åtta separata mutationer ska avvisas, bland annat falskt avslut, tappat öre,
fel avtal, dold kredit, ändrat original, saknad behörighet och saknad audit.
Körskriptet jämför samtliga sparade original-/facitfiler byte för byte mot
#872 och sparar deras hashvärden. Reproducerbara resultat och slutligt
kontrollutfall läggs till efter avslutad verifiering.

## Före en produktionsändring

Minsta nästa steg är att fastställa och prova en verklig, oberoende källa för
betalningsbehörighet och säker mottagarbindning. Nyttan skulle vara att
korrekta kundinstruktioner kan användas utan att ge en person annans pengar.
Hur många av originalens 20 det skulle lösa är **okänt**. Utan denna källa
ska produktflödet stanna som personalunderlag utan gissade utskick.

Verklig autentisering och återkallelse, behörigheter, verifieringskälla,
tvist/anhörigbetalning, betalningsavsikt mellan avtal, tillgodots fortsatta
hantering, återbetalning och kundinformation behöver beslut och separata
prov. Personalen kan inte avsluta ärenden genom ett enkelt överskrivnings-
kommando i denna demo. Ingen juridisk giltighet eller professionell
certifiering följer av att en AI-granskare läser prototypen.

Separata läsande specialistgranskningar görs mot samma frysta commit, högst
två samtidigt. Rolldefinitionerna används som bakgrund; deras påstådda
meriter, Claude-specifika verktyg och motstridiga dokumentuppgifter är inte
auktoritet. Fynd och bedömningar sparas separat för Claude.
