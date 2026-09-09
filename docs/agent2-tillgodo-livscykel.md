# Agent 2 — isolerat livscykelprov för tillgodo

Experimentet prövar en **föreslagen policy**, inte en godkänd produktionspolicy.
På originalets tio månader kvarstår en sista tillgodopost utan senare avi.
Målet högst 20 mänskliga granskningsbetalningar nås därför inte inom denna
horisont. Ett separat prov med en elfte månad får inte räknas in i originalet.

Bas är utkast-PR #870, gren `codex/agent2-overskottsprov`, HEAD
`8d8063a6b42a2a410847a73244e017cf79c97d44`. Dess CI var SUCCESS vid kontroll
2026-09-09: <https://github.com/yasineken2002-sys/eken/actions/runs/34393500032>.
Ny arbetsgren är `codex/agent2-tillgodo-livscykel` i den överförda Codespaces-ytan.
STARTA-HAR, gemensam överlämning, CLAUDE.md, inventeringen och
`docs/agent2-overskottsprov.md` är lästa. Mac-kopiorna används inte.

## Förhandsbestämd policy och avgränsning

Antaganden och förväntningar frystes i commit `9c03df2f`,
`docs/eval/tillgodo-livscykel/policy-v1.json`, före körningen. Implementationen
frystes separat i `3a568de6`. Originaldata, originalfacit, tidigare rapporter
och samtliga 57 kontrollprov är oförändrade.

En identifierad betalning reglerar aktuell skuld. Överskott får en egen post
med organisation, hyresgäst, avtal och ursprungsbankhändelse. Experimentet
antar ett aktivt avtal och ett uttryckligt stående medgivande att använda
tillgodo på exakt nästa kalendermånads ännu inte utfärdade avi inom samma
organisation, hyresgäst och avtal. Avdraget visas vid utfärdandet. Antagandet
om utfärdandedag kommer från den befintliga syntetiska projektionen; faktisk
leverans till kund har inte verifierats.

En redan utfärdad avi ändras inte tyst. Saknad/otydlig nästa avi, avslutat
avtal, saknat medgivande eller begärd återbetalning håller beloppet utestående.
Flera avtal för samma person slås inte ihop. Ingen återbetalning genomförs.
Återföring är en särskild spårbar åtgärd. Den behåller ursprungligt visat
avibelopp och markerar behov av mänsklig rättelse.

**Färdighanterad enligt experimentets antaganden** kräver korrekt allokering,
testverifikation och fullständig spårad användning av betalningens eventuella
tillgodo. En skapad tillgodopost eller ett samlat kundärende räcker inte.
En vanlig delbetalning kan vara korrekt ekonomiskt hanterad samtidigt som
avin fortfarande har skuld. Detta är inte produktionsmässig slutavstämning.

## Två tydligt skilda betalningsflöden

**A, oförändrad betalningsström:** alla 2 000 bankhändelser behåller datum,
belopp och identitetsunderlag från #870:s hashbundna publika projektion.
De tio överskotten kommer från samma hyresgäst: 9 800 kr mot 9 775 kr per
månad, ursprungligen 25 kr extra vardera, totalt 250 kr. När nästa avi visar
25 kr avdrag men kunden fortsätter betala 9 800 kr blir nästa tillgodo 50 kr.
Posterna växer sedan till 75, 100, …, 250 kr. Nio äldre poster används, men
det sista större tillgodot finns kvar. Summan av skapade poster är inte ny
extra inbetald likvid: den inkluderar belopp som återkommer som nytt tillgodo.

**B, alternativt kundflöde med ändrade indata:** första och sista överbetalningen
behålls uttryckligen. Åtta mellanliggande betalningar följer visat avibelopp:
`betalning-57-1` blir 9 750 kr, `betalning-57-2` till `betalning-57-8` blir
9 775 kr. Alla ändringar listas före/efter i resultatet och i det frysta
kontraktet. Den första posten om 25 kr förbrukas utan nytt överskott nästa
månad. Sista originalbetalningen skapar fortfarande 25 kr utan senare avi.
B är **inte originaltestet**, och påstår inte att alla nio senare betalningar
följer avin. Om även den sista ändrades skulle just det sista originalfallet
försvinna; därför är undantaget uttryckligt och förhandsbestämt.

Ett separat litet kontrollprov visar också att betalning av hela grundhyran
efter ett avdrag återskapar lika stort tillgodo, även utan ytterligare 25 kr.

## Resultat och separat omräkning

Alla fyra återspelningar och den oberoende omräkningen passerade. Tabellen
gäller **per 2 000 händelser**; båda ordningarna inom dagen ger samma rader,
skulder och tillgodosaldon. Korrekta allokeringar bedöms mot originalfacit för
de oförändrade fallen och det förhandsbestämda nya kontraktet för tillgodokedjan.

| Mått, efter tio månader | A: oförändrad ström | B: åtta ändrade betalningar |
| --- | ---: | ---: |
| Korrekta allokerade betalningar | 1 980 | 1 980 |
| Allokeringsrader / avier med noll restskuld | 2 055 / 1 980 | 2 055 / 1 980 |
| Färdighanterade utan människa, under antagandena | 1 979 | 1 979 |
| Felaktiga beslut mot experimentkontraktet | 0 | 0 |
| Skapade tillgodoposter / summa | 10 / 1 375 kr | 2 / 50 kr |
| Använt tillgodo | 1 125 kr | 25 kr |
| Utestående poster / summa | 1 / 250 kr | 1 / 25 kr |
| Identitetskonflikter / oidentifierade | 10 / 10 | 10 / 10 |
| Faktiska granskningsbetalningar enligt provregeln | 21 | 21 |
| Tillgodokundärenden + olösta betalningsärenden | 1 + 20 = 21 | 1 + 20 = 21 |
| Kontrollerade balanserade testverifikat | 4 009 | 4 001 |
| Högst 20 inom tiomånadershorisonten | Nej | Nej |

De 21 är arbetsärenden enligt den angivna indelningen, inte 21 oberoende
hyresgäster och inte uppmätt arbetstid. Sista källbetalningen
`betalning-57-9` är ett granskningsfall även om dess egen avi är reglerad.

Den oberoende omräkningen importerar varken beslutsmodell, körskript eller
SQL-adapter. Den kontrollerar facit, varje bankrad, ägare, tidsordning,
allokering, avibelopp, restskuld, kreditkälla/användning, samtliga åtta
databastabeller och exakt innehåll/balans i verifikaten. Åtta negativa
mutationer avvisades: tappat öre, fel avtal, dubbel användning, dold ändring
av B-indata, falsk färdigstatus, obalanserat verifikat, dolt sluttillgodo och
användning före tillgodots uppkomst.

Separat kontrollsumma i heltalsören:

| Belopp | A | B |
| --- | ---: | ---: |
| Bank | 1 542 574 750 | 1 542 552 250 |
| Bankallokering | 1 522 886 500 | 1 522 996 500 |
| Skapat tillgodo | 137 500 | 5 000 |
| Ofördelat, kvar för granskning | 19 550 750 | 19 550 750 |

För båda gäller `bank = bankallokering + skapat tillgodo + ofördelat` samt
`skapat tillgodo = använt tillgodo + utestående tillgodo`. Återstående skuld
räknas genom hela tidslinjen, inklusive avdrag vid utfärdande.

**Separat elfte månad, augusti 2026:** en ny avi på 9 775 kr läggs i en egen
förlängning av respektive slutläge. En uttrycklig `PLAN_NEXT`-händelse med
testets antagna medgivande kopplar den kvarvarande posten till avin före
utfärdandet. A visar 250 kr avdrag och en ny betalning på 9 525 kr; B visar
25 kr avdrag och 9 750 kr att betala. I båda blir tillgodot noll. Av de
ursprungliga 2 000 är då 1 980 färdighanterade och 20 kvar för granskning;
med den nya betalningen är materialet **2 001**, varav 1 981 färdighanterade.
Detta villkorade utfall är verifierat i både Python och PostgreSQL, men
kräver ny avi, ny justerad kundbetalning och antaget medgivande. Det är inte
ett uppnått 20-mål i originalets tio månader.

Originalmåttet ligger kvar separat på **1 970 korrekta automatiska / 0 felaktiga /
30 granskning**. #870 gav 1 980 korrekta allokerade betalningar, 10 tillgodoposter
om totalt 250 kr men fortfarande 30 granskningsbetalningar. Inget av dessa
äldre mått skrivs om med det nya experimentets facit.

## Vad befintlig redovisning ger — och inte ger

Inventeringen i `docs/agent2-overskott-inventering.md` gäller fortsatt. Före
databasbygget kontrollerades särskilt `accounting.service.ts:435`
(`createNumberedEntry`: balansering, org-bunden idempotens och möjlighet till
yttre transaktion), `:3711` (avibetalningsverifikat) och `:3878` (återföring).
Det är byggstenar, inte en färdig tillgodoreskontra eller verifierad integration
av denna livscykel. Ingen av dessa produktionsfunktioner anropas av experimentet.

De egna SQL-tabellerna är `scope`, `notice`, `bank`, `credit`, `allocation`,
`credit_use`, `voucher` och `operation`, alltid i egna `exp_*`-scheman.
Kontona heter endast `TEST_BANK`, `TEST_RECEIVABLE`, `TEST_CREDIT`, `TEST_RENT`
och `TEST_UNALLOCATED`. De är fiktiva testkonton utan BAS-nummer eller beslutad
koppling till kontoplanen. De 20 oidentifierade/konfliktfyllda betalningarna
hålls på testets ofördelade roll och räknas fortfarande som granskning.

Python väljer identitet och föreslagna operationer från publika Bank/Notice-fält.
Databasen verkställer och kontrollerar belopp, skuld, ägarskap, mål, medgivandeflaggor,
idempotens och verifikat. SQL tolkar inte själv banktext/OCR; identitetsalgoritmen
är fortfarande en fristående Python-policy. Facit och scenariofält används
bara av den separata revisorn, aldrig av beslutsfunktionen. Den ärvda publika
projektionen innehåller syntetiskt rekonstruerad kund-OCR enligt #870; detta
provar inte produktionens rawOcr-extraktion. Den nya körningen läser det
frysta publika underlaget direkt utan scenario-/facitfält.

## Databasens isolering och bevisgräns

Ingen installation behövdes. En redan lokalt cachad `postgres:16-alpine`
startades med `--pull=never`, `--network none`, utan publicerade portar eller
värdkataloger, högst 512 MiB minne och 1 CPU. Data ligger i en egen tmpfs på
högst 384 MiB. Före egna tabellskrivningar kontrolleras containeretikett,
nätverk, portar, databasnamn `eveno_tillgodo_test`, Unix-socket, datakatalog och
att inga användartabeller finns. Ingen anslutningssträng/hemlighet läses.
Containern stoppas och tas bort efter provet; inga andra filer raderas.

Första pilotstarten såg PostgreSQL:s tillfälliga initserver som redo innan
testdatabasen fanns. Den avbröts med `database does not exist`, utan skrivning
till experimenttabeller. Startgrinden korrigerades till att också kräva den
slutliga postgresprocessen som PID 1. Felet finns kvar i
`db-pilot-startfel.txt`, den efterföljande 16-falls piloten i `db-pilot.json`.
Den slutliga körningen omfattar ytterligare tre förhandskodade kontrollfall.

Slutprovet använder faktisk **PostgreSQL 16.13**. **19/19 databasfall** passerade
och upprepades i 19 nya egna scheman i samma isolerade testdatabas. De omfattar:

- Tre felpunkter under betalningens skuld/allokering, tillgodobildning och
  verifikat; tre under nästa avis utfärdande, skuldavdrag, kreditförbrukning
  och verifikat. Alla lämnar exakt oförändrad databassnapshot efter rollback;
  efterföljande försök lyckas en gång.
- Avslutat avtal, uteblivet medgivande, återbetalningsbegäran och förbjudna
  överföringar mellan organisation, hyresgäst eller avtal.
- Två samtidiga SQL-sessioner med olika operations-id:n försöker förbruka
  samma tillgodo på samma avi. Observatörssessionen ser faktisk PostgreSQL-
  väntan på lås; en lyckas, den andra får `ALREADY_ISSUED`. Exakt en användning
  och ingen negativ eller dubbel kredit kvarstår.
- Redan utfärdad avi, ändrat återimportinnehåll, återföring i fel ordning,
  rollback vid återföring samt idempotent upprepad återföring. Ursprungliga
  verifikat behålls och får länkade motverifikat.
- Obalanserat testverifikat avvisas. Använt tillgodo får inte återföras tyst
  efter bankbetalning på mål-avin. Begärd återbetalning efter skapandet
  stoppar användning. Två legitima lika stora tillgodon behåller skilda källor.

Varje huvudåterspelning verkställer 4 000 operationer (2 000 utfärdanden och
2 000 betalningar) i PostgreSQL. Samtliga återimporteras och returnerar
`DUPLICATE`, med exakt oförändrade databastabeller. Förlängningens extra avi
och tre operationer ligger utanför huvudresultatet. Alla verifikat har
positiva heltalsören och balanserar; varje förväntad verifikatrad kontrolleras
separat. Bokningsfunktionen validerar raderna, men provet påstår inte att en
privilegierad direkt SQL-skrivning utanför funktionen är omöjlig.

De befintliga **57/57** Python-proven passerade oförändrade. De nya **11/11**
Python-proven täcker bland annat redan utfärdad/saknad nästa avi, flera avtal,
namn/OCR-konflikt även med betald annan ägare, full respektive justerad
betalning och identisk/ändrad återimport. De gamla proven behåller sina
negativa identitets-, delbetalnings-, fleravi- och överskottskontroller.

Transaktionsfel och faktiska konkurrerande SQL-sessioner prövas i PostgreSQL.
Detta är starkare bevis än #870:s minnessimulering för just de provade fallen.
`fsync` och `synchronous_commit` är på, men tmpfs-provet bevisar inte hållbarhet
vid maskin-/strömavbrott, återställning från backup eller produktionens låsning.
Deduplicering förutsätter stabila syntetiska händelse-id:n; verklig bankimport
som ger ett nytt id åt samma transaktion är inte verifierad här.

## Reproduktion och granskningspunkter

Från arbetsytans rot, med en redan cachad PostgreSQL-image och Docker tillgänglig:

```sh
df -h . /tmp
pgrep -af '[j]est|[t]sc'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/api/scripts -p 'test_*prov.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s apps/api/scripts -p test_tillgodo_lifecycle.py -v
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/eval_tillgodo_lifecycle.py /tmp/eveno-tillgodo-ny-korning --database
PYTHONDONTWRITEBYTECODE=1 python3 apps/api/scripts/audit_tillgodo_lifecycle.py /tmp/eveno-tillgodo-ny-korning /tmp/eveno-tillgodo-ny-omrakning.json
```

Vänta om processkontrollen ger Jest/tsc-träffar. Resultatkatalog och revisionsfil
måste vara nya; tidigare bevis skrivs inte över. Här fanns cirka 2,2 GB ledig
arbetsdisk, 37 GB på /tmp och inga Jest/tsc-processer före körningen. Inga
paket installerades eller images hämtades. Tester kördes sekventiellt, utom
de två små SQL-sessioner som själva utgjorde samtidighetsprovet.

Bevisfiler finns under `docs/eval/tillgodo-livscykel/`: `korning-1/manifest.json`
har SHA-256 för källor och uppackat resultat, `korning-1/resultat.json.gz` har
bankrader, operationer, slutlägen, faktisk DB-identitet, SQL-prov och separat
förlängning. `oberoende-omrakning.json` innehåller den separata revisionen och
negativa kontroller. `regression-57.txt` och `livscykel-11.txt` har testloggar.
`bas-870-ci.json` binder basgrenen till dess verifierade HEAD/CI.

| Fil:rad vid kodfrysningen | Granskningspunkt |
| --- | --- |
| `docs/eval/tillgodo-livscykel/policy-v1.json:1` | Förhandsbestämda antaganden och A/B-facit |
| `apps/api/scripts/tillgodo_lifecycle.py:34` | Utfärdande och spårad användning i referensmodellen |
| `apps/api/scripts/tillgodo_lifecycle.py:61` | Identitet, aktuell skuld och tillgodots källa/mål |
| `apps/api/scripts/tillgodo_experiment.sql:58` | Transaktionsfunktion och idempotens/låsning |
| `apps/api/scripts/tillgodo_pg.py:28` | Lokal isolering och kontroll före skrivning |
| `apps/api/scripts/eval_tillgodo_lifecycle.py:60` | A/B-ström och tydligt ändrade bankbelopp |
| `apps/api/scripts/eval_tillgodo_lifecycle.py:92` | Separat elfte månad |
| `apps/api/scripts/test_tillgodo_lifecycle.py:91` | Verkliga PostgreSQL-kontroller |
| `apps/api/scripts/audit_tillgodo_lifecycle.py:19` | Oberoende kontroll av hela DB-snapshoten |

Resultatets uppackade SHA-256 är
`e2419979b86bc4582285034a28db1435c109cb3ccbeef9fde879765f9bbf6fd4`.
`diff-stat.txt` redovisar den isolerade diffen mot #870; `bevismanifest.json`
binder de sparade underlagen med filhashar. PR ska vara utkast med
`codex/agent2-overskottsprov` som bas. Claude granskar och mergar senare.

## Kvarvarande beslut och arbete

- Besluta policy, faktisk behörighet och medgivande, kundinformation samt vad
  som gäller vid avslut, återbetalningsbegäran och redan utfärdade avier.
- Besluta riktiga redovisningskonton, periodhantering, avgifter, ränta, skatt,
  krediteringar och hur ofördelade belopp ska granskas och avstämmas.
- Utforma produktionsreskontra, auktorisering, aktörs-/policyspår och koppling
  till faktisk bankimport, aviutskick och befintliga verifikat. Experimentets
  superuser och testfunktioner är ingen produktionsmodell för behörigheter.
- Prova produktionsspecifika låsordningar, samtidiga rättelser, ändrade
  bankidentifierare, periodstängning, saknade konton och hållbar återställning.
  Återföring av använd tillgodo efter en betalning på mål-avin stoppas här och
  kräver en särskilt beslutad rättelsekedja.
- Hantera den sista utestående posten och de 20 identitetsfallen. Att samla
  dem i ärenden får inte ändra antalet färdighanterade betalningar.

Ingen produktionsmodell, kontoplan eller fil under `apps/api/src/reconciliation/**`
ändras. `/workspaces/eken-codex` används inte. Inga riktiga betalningar,
produktionsskrivningar eller externa AI-anrop har gjorts. Ingen garanti eller
bevisad nivå om 99,98 % i drift följer av provet.
