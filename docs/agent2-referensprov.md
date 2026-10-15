# Agent 2 — referenser före fördelning, experiment

## Uppföljning 2026-10-15: tillgodo och återbetalning i lokal SQLite

En separat prototyp prövar nu sparat tillgodo, användning på nästa avi och
återbetalning efter avslutat avtal. Den använder transaktioner i en lokal
SQLite-fil och symboliska bokföringskonton. **Det är inte produktens
PostgreSQL-databas eller bokföringstjänst.** Ingen produktionskod, riktig
bankanslutning eller modell används.

Den viktigaste iakttagelsen är att samma oförändrade betalningsdata fortfarande
lämnar **250 kr som verksamheten är skyldig hyresgästen**. Tillgodo på nästa avi
löser inte detta ensamt: testhyresgästen betalar fortsatt 9 800 kr varje månad
för en hyra på 9 775 kr. Nästa avdrag gör då nästa överskott större.

| Månad i försöket | Tidigare tillgodo används | Kontant till avin | Nytt tillgodo efter betalning |
| ---------------- | ------------------------: | ----------------: | ----------------------------: |
| 1                |                      0 kr |          9 775 kr |                         25 kr |
| 2                |                     25 kr |          9 750 kr |                         50 kr |
| 10               |                    225 kr |          9 550 kr |                        250 kr |

Nio källposter används och en källpost återstår. Historiskt skapade tillgodon
är 1 375 kr och använda tillgodon 1 125 kr; nettoskulden är 250 kr. Att nio
poster är förbrukade betyder alltså **inte att nio ekonomiska åtaganden har
försvunnit**. Vi räknar inte om de tio ursprungliga överskottsbetalningarna
till bara ett kvarstående betalningsärende för att nå målet tjugo.

De två kronologiska körningarna, med olika ordning inom samma bankdag, ger
samma beslut och ekonomiska slutläge. Ursprungsfacit är oförändrat:
**1 970 strikt godkända, tio avvikelser för överskottshanteringen och tjugo
utan identifierbar entydig fördelning.** Alla 2 000 bankbetalningar återspelas
utan nya ekonomiska effekter; stängning och återöppning av databasen bevarar
tillståndet. Körningarna använder samma 2 000 unika, påhittade betalningar.

**Indatagräns:** belopp, datum, banktext och bank-ID är oförändrade. OCR-fältet
återskapas däremot från testets `ocrFranHyresgast`, inte från den äldre
importörens härledda `rawOcr`. I 168 fall hade importören plockat ut årtalet
`2026` trots att testbetalaren inte angav OCR: 126 avinummerfall och 42
namn/period-fall. Dessa referensfält är tomma här. Denna projektion används
även i de tidigare fristående referensproven; den förutsätter tillförlitlig
information om OCR-källan och är **inte en återkörning av hela bankimporten**.
Alla sparade bankfält är alltså inte identiska, även när betalarens uppgifter
är oförändrade. Produktionsvägen för detta återstår att verifiera.

I en **separat kopia** av databasen lägger testet till tre nya uppgifter som
saknas i originalunderlaget: ett antaget avtalsslut, ett testverifierat
returkonto knutet till källbetalningen och en testbekräftad bankutbetalning
på 250 kr. Begäran reserverar beloppet men minskar inte skulden. Först den
bekräftade testutbetalningen minskar både bankmedel och skuld med 250 kr.
Detta bevisar prototypens händelsekedja under dessa antaganden, **inte en
riktig bankutbetalning, kontoverifiering eller att originalmaterialet klarar
målet högst tjugo**.

Prototypens regler och verifiering:

- Tillgodo kräver uttryckligen aktiverad testpolicy per avtal och får användas
  endast inom samma organisation, hyresgäst och avtal. Saknade månader,
  tidigare obetalda avier och redan betalda eller ännu inte utställda avier
  får inte kringgås. Avdraget begränsas till aktuell restskuld.
- Varje ekonomisk rörelse behåller bankradens UUID, testfallets ID och
  källavin. Kredit mot en ny avi minskar skuld och kundfordran; den skapar
  ingen ny inbetalning. Ören bevaras per bankrad, avi och tillgodokälla.
- Händelse-ID och bankradens ID hindrar dubbletter. Samma ID med ändrat
  innehåll avvisas. Ett injicerat fel före commit återställer alla poster.
  Två samtidiga återbetalningsförsök i separata SQLite-anslutningar kan
  reservera samma pengar endast en gång.
- Återbetalning kräver avslutat avtal utan öppen aviskuld och en uttrycklig
  testverifiering av mottagarkontot för just källbetalningen. Belopp,
  mottagare och bankbekräftelse måste stämma. Timeout frigör inte reservation;
  ett slutligt testavslag gör det. En sen motstridig bekräftelse avvisas.
- Datum jämförs som UTC-tidpunkter. Retroaktiva pengadispositioner avvisas
  efter en senare disposition på avtalet; de behöver ett separat förfarande
  i en verklig integration. Tidszoner får inte göra en framtida avi tillgänglig.
- **99/99 unittest-metoder passerar**, varav 46 nya livscykelprov och 53
  tidigare referens-/text-/överskottsprov. Bland regressionerna finns
  okänd organisation, ändrat datum i en återbetalningsbekräftelse,
  bakdaterade händelser och tre tidszonsfall.
- Modellanrop: noll; modellavgift: **0 kr**. Detta mäter inte driftkostnad
  per riktig banktransaktion. Inga riktiga bankanrop eller utbetalningar sker.

Rårapport, källhashar, logg och oberoende kontroll finns i
`docs/eval/referensprov-v3/`. SQLite-filerna sparas lokalt i testkatalogen;
de ingår inte i Git. Rapporten innehåller databasens ekonomiska poster så att
beloppen kan räknas om utan prototypens kontrollfunktion.

### Vad som återstår före produktionsintegration

Produktens `rent-notice-credit.service.ts` avvisar i dag kreditering av betalda
eller delbetalda avier eftersom kundtillgodo och återbetalning saknas.
`RentNoticePaymentSource` har bara bankavstämning och manuell betalning.
Den befintliga betalningsbokningen debiterar bank varje gång; den får därför
inte återanvändas oförändrad för tillgodo. En kreditnota återför hyra och är
inte samma sak som att använda redan mottagna pengar.

Nästa produktionssteg behöver en egen beständig tillgodomodell, godkänd
kontomappning, hantering av låsta perioder, migration, koppling till riktiga
bankbesked och tester genom produktens bokföringstjänst. Denna prototyp
omfattar en hyresavi per avtal/månad i SEK. Avgifter, ränta, kreditnotor,
annulleringar och rättsliga villkor är inte implementerade här. Befintlig
`apps/api/src/reconciliation/` har inte ändrats. **99,98 % i drift och högst
tjugo manuella betalningar är fortfarande inte bevisat.**

Kör den isolerade livscykeln från reporoten; utdatakatalogen måste vara ny:

```sh
python3 -B -m unittest discover -s apps/api/scripts -p 'test_referensprov*.py' -v
python3 -B apps/api/scripts/eval_referensprov_credit.py /tmp/ny-kreditlivscykel
python3 -B apps/api/scripts/audit_referensprov_credit.py /tmp/ny-kreditlivscykel
```

Avsnitten nedan beskriver tidigare steg; ovanstående livscykelprov tillkommer
utan att göra deras historiska körningar till produktionsbevis.

## Uppföljning 2026-10-15: textfel och separat överskott

Texttolkningen i experimentet är korrigerad. `oktober 2026`, `okt 2026`,
`okt. 2026`, `2026-10`, `2026/10` och `10/2026` identifierar samma lagrade
hyresperiod. Perioden härleds aldrig från bankdatum eller förfallodatum.
Kända namn och avireferenser tas bort före periodtolkningen, så datumdelen i
ett avinummer inte blir en extra instruktion.

Parsern har en sluten grammatik. Oförstådda ord, datumformat, relativa perioder,
negationer, osäkerhet och okända symboler stoppar automatisk fördelning. Den
får inte falla tillbaka till en äldre skuld när betalningen innehåller en
instruktion som inte förståtts. Detta är **inte allmän språkförståelse**:
vanliga men ännu inte stödda uttryck kan därför kräva fler granskningar hos
riktiga kunder. Inga sådana verkliga frekvenser är uppmätta.

Ett separat försök prövar också regeln **betala exakt angiven avi och håll
överskottet separat**. Den är avstängd i den ursprungliga policyn och stöds
bara för en uttryckligt identifierad, öppen avi efter alla konfliktkontroller.
Överskottet är inte en kreditnota, återbetalning eller tillgänglig betalning
av nästa avi. Varje post behåller bankradens UUID, testfallets ID,
organisation, hyresgäst, avtal, avi, ören och status
`HELD_PENDING_DISPOSITION`.

| Utfall per 2 000 oförändrade betalningar           | Ursprunglig regel efter textlagning | Föreslagen överskottsregel |
| -------------------------------------------------- | ----------------------------------: | -------------------------: |
| Helt avslutade enligt ursprungligt facit           |                      1 970 (98,5 %) |             1 970 (98,5 %) |
| Avi betald, separat överskott kvar att hantera     |                                   0 |                         10 |
| Identifiering/konflikt/överskott kräver granskning |                                  30 |                         20 |
| Totalt betalningar med kvarvarande åtgärd          |                              **30** |                     **30** |

Den nya regeln ger 1 980 automatiskt fördelade och beloppsmässigt redovisade
betalningar **inom simuleringen**. Det betyder inte 1 980 slutligt lösta
betalningar. De tio överskotten är tio månadsbetalningar från samma
testhyresgäst: 9 775 kr till respektive avi och 25 kr separat per betalning,
totalt **250 kr i öppna överskott**. Oförändrat ursprungsfacit ger 1 970
godkända, tio avvikelser från den gamla regeln och tjugo utan allokering.
Den nya regeln bedöms därför mot ett separat, uttryckligt förslag till facit.
**Målet högst tjugo betalningar med kvarvarande åtgärd är fortfarande inte nått.**

Validering av denna uppföljning:

- 53/53 unittest-metoder: ursprungliga 28 samt 15 text-/referensprov och tio
  prov av överskott. Textmatrisen har elva stödda skrivsätt och 41 uttryck som
  ska stoppas, prövade med äldre skuld, OCR, avinummer och unik referens.
- De tidigare fem felande banktextfallen klarar sina krav. Samtliga 13
  tidigare extrafall passerar, inklusive fem positiva kontroller och tre
  defensiva/föreslagna referensregisterfall. Dubbla avinummer inom en
  organisation är ett defensivt gränssnittsprov, eftersom databasen redan
  förbjuder tillståndet.
- Sex grundkörningar ger samma utfall som tidigare och noll felaktiga
  automatiska beslut. 150/150 delbetalningar och 75/75 samlingsbetalningar
  fortsätter att klara ursprungsfacit i varje grundvariant.
- Två ytterligare körningar med överskottsregeln ger identiska beslut i
  båda ordningarna inom dagen. Inga avvikelser från det separat deklarerade
  överskottsförslaget; inga bankindata eller ursprungliga facit ändrades.
- Per bankrad gäller belopp = allokerat + sparat överskott + oidentifierat.
  Per avi gäller ursprunglig skuld = restskuld + allokeringar. Oberoende
  omräkning av åtta körningar och deras källhashar passerar.
- Alla 2 000 källrader återspelas i varje överskottskörning utan ändrade
  saldon eller dubbla poster. Samma käll-ID med ändrat innehåll avvisas;
  fel före publicering lämnar simuleringens tillstånd oförändrat.
- Okända/betalda/framtida avier, identitetskonflikter, flera avireferenser
  och enbart månad eller gammalt OCR får inte skapa överskottsposter.
- Inga produktionsfiler, bankanslutningar, riktiga bokföringsverifikat,
  modell- eller databasjobb används. Modellavgift: 0 kr. Inga nya lokala
  Jest-/TypeScript-körningar för dessa Python-/dokumentändringar.

Råresultat, logg och manifest för uppföljningen finns i
`docs/eval/referensprov-v2/`. Det är samma 2 000 konstruerade betalningar,
inte 16 000 oberoende kundfall. Förutsättningarna för varianten med unikt OCR
nedan gäller fortfarande; dess bankindata ändras uttryckligen i experimentet.

`referensprov_ledger.py` är ett register i minnet med sekventiell återspelning,
inte en färdig bokföringsmodell. Databaspersistens, samtidiga importer,
reverseringar, återbetalning, disposition av överskott och driftens deduplicering
återstår att utforma och testa. 99,98 % precision eller högst tjugo manuella
ärenden i drift är inte bevisat. Produktionsintegration ingår inte i utkastet.

Kör uppföljningen från reporoten:

```sh
python3 -B -m unittest discover -s apps/api/scripts -p 'test_referensprov*.py' -v
python3 -B apps/api/scripts/eval_referensprov.py /tmp/ny-grundrapport.json
python3 -B apps/api/scripts/eval_referensprov_surplus.py /tmp/ny-overskottsrapport.json
```

Det nya, separata workflowet `Referensprov` kör unittest-proven på relevanta
PR-ändringar. De längre återspelningarna körs lokalt och ligger frysta med
manifestet. Workflowet ändrar inte produktions-CI:s obligatoriska jobb.

## Ursprungligt resultat före textlagning och överskottsförsök

En fristående, återkopplad Python-simulering av samma frysta 2 000 syntetiska
betalningar ger **1 970 korrekta automatiska beslut (98,5 %), noll felaktiga
automatiska beslut och 30 granskningsbetalningar** med gemensam referenskontroll
och strukturerat periodstöd. Samma beslut och allokeringar i båda ordningarna
inom bankdagen. **Målet högst 20 är underkänt.**

Det här implementerar en experimentpolicy, inte produktionsmatcharen eller
betalningsagenten. Ingen databas, bokföringstjänst, bankanslutning, modell eller
extern kö kördes. Inga produktionsfiler har ändrats. Den tidigare uttryckliga
gränsen runt `apps/api/src/reconciliation/` har bevarats.

| Mätning per 2 000 betalningar                         | Korrekt automatisk | Fel/kontrollbrist automatiskt | Granskning/åtgärd |
| ----------------------------------------------------- | -----------------: | ----------------------------: | ----------------: |
| Tidigare produktionskod i lokal DB, grundordning      |     1 890 (94,5 %) |                            19 |               110 |
| Tidigare produktionskod i lokal DB, omvänd inom dagen |     1 880 (94,0 %) |                            19 |               120 |
| Simulering: gemensam referenskontroll                 |     1 890 (94,5 %) |                             0 |               110 |
| Simulering: referenser + hyresperiod/avtal            |     1 970 (98,5 %) |                             0 |                30 |
| Simulering: dessutom unikt OCR per avi                |     1 970 (98,5 %) |                             0 |                30 |

De två första raderna är historiska DB-resultat från #868, inte nya körningar.
Simuleringens tre varianter kördes i båda ordningarna: sex körningar men bara
2 000 unika grundbetalningar. Liknande slutresultat från olika körvägar bevisar
inte att produktionsintegrationen redan fungerar.

## De 30 som återstår

- 10 saknar identifierande information i bankraden.
- 10 har motstridiga identiteter mellan OCR och avinummer/fullnamn.
- 10 har 25 kr i överskott för en uttryckligen angiven avi, utan beslutad
  hantering av överskottet.

Alla ligger kvar i nämnaren och originalfacit. Vi har inte kallat en automatisk
köplacering, notifiering eller ett felaktigt beslut för en lyckad matchning.
De 80 nya matchningarna är 60 namn/period-fall och 20 felskrivna OCR med tydligt
namn/period. Fullnamn och period är unika i detta material; det är inte belägg
för deras förekomst eller tillräcklighet hos riktiga kunder.

Nästa sak att utforma om målet är 20: separat, spårbar överskottshantering för
de tio identifierade överbetalningarna. Att kalla dem färdiga utan sådan
hantering skulle byta kraven efteråt. Ingen sådan bokföringsmodell byggdes här.

## Vad som prövades

1. Samlad identitetskontroll före allokering. Både betalda och öppna avier finns
   i identitetsregistret; en tidigare betalning kan inte ta bort en konflikt.
2. Explicit lagrad hyresmånad/år, avtal och hyresgäst skiljs från förfallodatum
   och bankdatum. Namn/period-stödet är deterministiska regler för en snäv
   svensk textform, inte ett AI-svar. Kandidat-/promptändringar i produktion
   återstår att bygga och prova.
3. En tydligt separat variant där korrekt inmatade vanliga hyror och
   delbetalningar använder avins unika numeriska referens. **1 635 bankreferenser
   ändras i denna variant**; detta är en antagen framtida betalningsväg, inte
   förbättring på oförändrad bankindata. Betalningssätt, leverans, bankformat och
   kunders faktiska kopieringsbeteende har inte verifierats.

Unikt OCR gav ingen extra täckning i de 2 000 grundfallen: varje hyresgäst har
ett avtal där. Separata kontrollprov visar att ett unikt avireferensuppslag
kan skilja lägenhet från garage samma månad, medan delat OCR och månad lämnar
det oklart. Nya referenser måste i en verklig lösning ha ett gemensamt,
organisationsbundet register som inte krockar med äldre OCR. Experimentets
numeriska sekvens är endast testdata, inte en migrationsdesign.

## Kontroller och begränsningar

- **28/28 unittest-prov**: aktuellt avinummer trots gammal skuld, fel hyresgäst,
  betald OCR-ägare, namn-/avtalskollisioner, referenskonflikter, periodkonflikter,
  avvikande förfallodatum, framtida avier, organisationsgräns, felaktiga belopp,
  delbetalning, samlingsbetalning och motsägande text.
- **150/150 delbetalningar och 75/75 samlingsbetalningar** godkända i varje arm.
- Hela betalningsbeloppet fördelas exakt i ören eller lämnas helt ofördelat.
  Ingen allokering får överstiga kvarvarande skuld. Restskulden följer med till
  nästa betalning; ingen simulerad mänsklig korrigering nollställer den.
- Ursprungligt kund/facit och historiska råresultat verifieras mot SHA-256 i
  det tidigare manifestet. Facit används först för efterbedömning. Ett särskilt
  prov byter hela facit mot skräp och visar identiska projicerade bankunderlag.
  Beslut fungerar också när logiska identiteter ersätts av opaka ID:n.
- Oberoende omräkning av samtliga 12 000 körningsrader, belopp, grupper och
  källhashar: godkänd. Inte 12 000 oberoende kundfall.
- Negativkontroll i minnet återinförde OCR-fördelning före referenskontroll:
  båda utvalda proven föll som avsett, utan tekniska fel. Inga filer ändrades.
- Noll modell-/API-anrop, **0 kr i externa modellavgifter för detta prov**.
  Lokal datorkostnad har inte mätts. Detta är ingen driftkostnad per matchning.
- Inga nya Jest-/TypeScript-körningar: ändringarna gäller endast Python och
  dokumentation. CI kontrollerar repot; Pythonproven är körda lokalt och ingår
  inte automatiskt i den befintliga CI-sviten.

Simuleringen testar inte bokföringsverifikat, transaktionslås, samtidighet,
återimport/deduplicering, reverseringar, fakturor/depositioner eller godtycklig
fritext. Den gamla policyn äldst-först behålls för ett identifierat ensamt
avtal utan uttrycklig avihänvisning; det är fortfarande en policy, inte bevis
för betalarens avsikt. Fler avtal eller osäker text kan ge fler granskningsfall
utanför denna testblandning. **Ingen garanti om oförsämrad produkt eller
99,98 % träffsäkerhet i drift har därmed bevisats.**

## Reproduktion

Från reporoten, Python 3 med enbart standardbibliotek:

```sh
python3 -m unittest discover -s apps/api/scripts -p test_referensprov.py -v
python3 apps/api/scripts/eval_referensprov.py /tmp/ny-referensprov-rapport.json
```

Resultatet skrivs aldrig över. Rårapport och kontrolloggar ligger i
`docs/eval/referensprov/`. `manifest.json` anger hash för uppackad rapport.
Experimentkoden frystes i `241efd4` före sammanställningen.
