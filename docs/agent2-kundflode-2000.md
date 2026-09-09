# Agent 2 — 2 000 betalningar genom kundens bankflöde

Mål: högst 20 av 2 000 inkommande betalningar ska behöva mänsklig granskning.
Felaktiga automatiska matchningar, pengar på fel avi och felaktiga belopp
räknas separat. Ett felaktigt automatiskt beslut får inte förbättra täckningen.

## Förhandsbestämt material

En konstruerad kund med 10 fastigheter, 200 lägenheter, 200 hyresgäster,
200 avtal och 2 000 hyresavier för oktober 2025–juli 2026. Två identiska
kundkopior jämför befintlig import med betalningsagentens flagga av respektive
på. Samma 2 000 unika betalningshändelser spelas genom varje kopia.
Inga verkliga kunduppgifter eller bankanslutningar används.

| Betalningstyp | Antal inkommande bankrader |
| --- | ---: |
| Vanlig hyra med OCR | 1 485 |
| Helt avinummer i text | 180 |
| Två delbetalningar per avi | 150 |
| Två månaders hyra tillsammans | 75 |
| Namn och uttrycklig månad | 60 |
| Felskriven OCR med namn och månad | 20 |
| Ingen identifierare | 10 |
| Överbetalning med uttrycklig avi | 10 |
| Motstridiga identifierare | 10 |
| **Totalt** | **2 000** |

Detta är en redovisad testblandning, inte uppmätt frekvens hos riktiga kunder.
Andelarna ändras inte efter körningen för att få målet att passera. De 30
rader som enligt förhandsfacit saknar stöd för ett säkert beslut redovisas
öppet: en ensam bättre modell kan inte skapa betalningsinformation som saknas.
Facit separerar generatorns kunskap om avsedd betalare från vad bankraden
faktiskt visar. Alla dessa rader ligger kvar i nämnaren.

Betalningarna sker i datumordning, med samma OCR återanvänt per hyresgäst över
månaderna. Avier skapas månad för månad. Restskuld, tidigare felmatchningar,
delbetalningar och väntande granskning följer med till nästa månad. Ingen
låtsad mänsklig rättning nollställer historiken mellan bankrader.

## Mätväg

En egen lokal PostgreSQL 16-databas, med projektets migrationer, används.
Fastigheter, lägenheter och avtal seedas som förutsättningar. Import/parsing,
matchning, allokering, händelser och verifikat går genom befintliga tjänster.
Detta är en integration på tjänste-/databasnivå, inte ett webbläsarprov,
bankanslutning eller test av hela appens inloggning och CRUD-validering.
Populationen gäller positiva hyresinbetalningar via det generiska CSV-formatet.
Den mäter inte återbetalningar, negativa bankrader, samtidiga importer,
bankleverantörernas anslutningar eller kundernas verkliga frekvens av avvikelser.

Inga filer under `apps/api/src/reconciliation/` ändras. Endast testkundernas
växlar kan ändras. Inga mejl eller externa köjobb skickas. AI-anrop görs bara
efter separat kostnadsgodkännande och får en egen rapport. Sparade fullständiga
kandidatunderlag från den faktiska tidpunkten gör efteranalysen möjlig utan
att facit eller framtida betalningar läcker in i modellens indata.

## Uppmätt 2026-09-09

Materialet frystes i `e36ff6e` före första databaskörningen. Ordningsprovet
kördes på `d399117`: samma kund, bankrader och facit, samma produktionskod,
men omvänd ordning för betalningar med samma bankdatum. Datumordningen mellan
dagar och månader bevarades. Båda körningarna slutfördes utan tekniska bortfall.
Exitkod **1** betyder att kvalitetsmålet underkändes, inte att importen kraschade.

| Kontroll per 2 000 betalningar | Grundordning | Omvänd ordning inom dagen |
| --- | ---: | ---: |
| Automatiska, godkända mot samtliga förhandskrav | 1 890 (94,5 %) | 1 880 (94,0 %) |
| Omatchade | 91 | 101 |
| Automatiska med fel/kontrollbrist | 19 | 19 |
| Därav faktiskt fel hushåll | 0 | 10 |
| Därav annan månad än uttryckligen angiven | 9 | 9 |
| Därav avsedd avi trots identitetskonflikt | 10 | 0 |
| **Betalningar som behöver åtgärd eller granskning** | **110 (5,5 %)** | **120 (6,0 %)** |
| Tekniska fel / ej körda betalningar | 0 / 0 | 0 / 0 |

De 19 är alltså inte 19 felmottagare i grundprovet. Fältet
`felaktigtAutomatiska` i rårapporten betyder underkänt mot förhandskraven;
den oberoende Python-omräkningen skiljer den klassningen från faktisk felallokering.
Granskningsbehovet räknas i **betalningar**, inte antal klick eller unika hyresgäster.

Strikt precision bland de automatiska besluten blir 1 890/1 909 = 99,005 %
i grundprovet och 1 880/1 899 = 98,999 % i ordningsprovet. Det är syntetiska
utfall med våra förhandskrav, inte statistiskt belagd precision hos riktiga kunder.
Varken målet högst 20 granskningsbetalningar eller 99,1 % i drift är uppnått.

Flaggan för betalningsagenten av/på gav samma importutfall. **Det är inte ett
prov med AI-svar av/på**: de 91 respektive 101 köjobben fångades vid kögränsen
och kördes inte. Inga Anthropic-anrop gjordes i dessa integrationer.
Totalt fyra kundkopior/8 000 importerade rader, men bara **2 000 unika grundfall**.

Alla verifikat balanserar; allokerade bankbelopp bevaras exakt i ören.
Grundkörningen gav per kund 1 993 betalningsallokeringar och 3 993 verifikat,
ordningsprovet 1 983 respektive 3 983. Återimport av samma första betalning
gav en dubblett utan extra bankrad, allokering eller verifikat i alla fyra kopior.
Oberoende SQL-kontroll av grundprovet: noll allokeringar över organisationsgränsen,
noll konton från fel organisation, noll avvikelser mellan betald spegel och
allokeringar och noll överbetalda avier. Balans är inte bevis för rätt hyresgäst.
Samma SQL-kontroll efter ordningsprovet gav åter noll fel över alla fyra
organisationer och 8 000 bankrader; se `databaskontroll-alla-kopior.json`.

## Konkreta orsaker

1. **Motstridiga identifierare går före fördelningen utan gemensam kontroll.**
   Tio bankrader bär en annan hyresgästs riktiga OCR och avsedd hyresgästs
   uttryckliga avinummer/fullnamn. I grundordningen var OCR-ägarens avi redan
   betald; importen föll vidare till angivet avinummer. I den andra ordningen
   var den öppen: då betalades fel hushålls avi, och OCR-ägarens egen betalning
   blev omatchad. Det är en observerad orsakskedja, inte en modellgissning.
2. **80 identifierbara betalningar lämnas omatchade.** Sextio har fullnamn och
   månad, tjugo dessutom ett OCR med fel kontrollsiffra. Samtliga 80 avsedda
   avier finns i både det fulla underlaget och kandidatlistan. Informationsauditen
   hittar exakt en namn–period–belopp-träff i vart och ett, utan att använda
   facit för valet. Detta visar tillgänglig information i denna snäva textform;
   det är inte en ny matcher eller ett oberoende prov av en sådan.
3. **Årtal blir OCR.** I 42 av de sextio namn/period-fallen blir `2026` en
   `rawOcr`, eftersom det klarar Luhn. Ett giltigt kontrolltecken visar inte att
   ett nummer avser en betalningsreferens. Även 126 korrekt matchade rader med
   uttryckligt avinummer får `2026` som rawOcr: totalt 168, inte 168 missar.
   Ingen OCR-validering har försvagats eller tagits bort i detta bygge.
4. **Överbetalningar saknar rätt hantering.** Första betalningen med 25 kr extra
   lämnas omatchad. Nio senare betalningar fördelas mot gammal skuld trots
   uttrycklig aktuell avi. I november går 9 775 kr till oktober och 25 kr till
   november; efterföljande månader fortsätter följdfelet. Pengarna balanserar,
   men betalningsavsikten följs inte.

## Vägen mot högst 20 – att diskutera före produktändring

Mätningen pekar på en ordning för nästa bygge:

1. Kontrollera OCR, uttrycklig avi och hyresgäst tillsammans **före** varje
   automatisk fördelning. Kontrollera också identiteter vars avier redan är
   betalda; en lista med bara öppna skulder kan inte upptäcka alla konflikter.
   Samma beslut ska gälla oavsett ordningen inom bankdagen.
2. Ge agent och regelkontroll en uttrycklig hyresperiod och OCR-proveniens.
   Pröva namn/period-stöd med separata negativa fall: namnkollision, annan
   period, dubbel skuld, fel belopp och OCR som tillhör ett annat hushåll.
   Sänk inte säkerhetströskeln för att nå ett visst antal.
3. Utforma en spårbar hantering av överskott på identifierad betalare, exempelvis
   betald angiven avi och ett separat tillgodobelopp. Det kräver egen
   bokföringsmodell, återbetalnings-/kvittningsregler och granskning. Det är
   inte byggt eller bokfört i detta prov.

Om dessa tre förbättringar klarar motsvarande nya prov skulle de 80
identifierbara betalningarna och de tio överbetalningarna kunna hanteras
utan manuell matchning, medan tio helt oidentifierade och tio med konflikt
återstår: **20/2 000**. Det är en **villkorad målbild**, inte ett uppmätt
förbättrat resultat. I grundmaterialets oförändrade policy kräver 30 fall
granskning; att kalla överskotten automatiska utan ny hantering vore att ändra
facit för att få grönt. Ett annat kundunderlag kan ha andra andelar.

## Förberedd, ännu ej körd AI-jämförelse

`scripts/eval-kundflode-modell.ts` planerar högst **220 anrop**: de 110
problemfallen från grundkörningen, befintligt en-avi-förslag jämfört med det
redan byggda referensstödet. Grundprovet ger 220 kompletta begäranden i PLAN
och **noll anrop**. Körningen väntar på användarens nya kostnadsgodkännande.

Underlaget är sparat före respektive import. Varken framtida betalningar,
generatorns scenario eller facit går in i prompten. Befintlig belopps-/identitets-
kontroll bedöms separat från råa AI-svar. Resultaten skulle fortfarande vara
fristående förslag, inte återkopplade bankmatchningar eller automatiska beslut.
SDK-omförsök är avstängda, anropstaket är hårt och API-fel stoppar nya anrop;
ej körda observationer ligger kvar. Nycklar och råa API-fel skrivs inte ut.

## Underlag och reproduktion

Fullständiga rårapporter, kund, facit och kandidatögonblick finns i
[`eval/kundflode-2000/`](eval/kundflode-2000/). Stora JSON-filer är gzip-komprimerade
utan innehållsförändring; `manifest.json` anger SHA-256 av de uppackade byten.
Grundprovet och ordningsprovet har identiskt kund/facit. Enda förändrade
källfil mellan körningarna är riggens uttryckliga ordningsval.

Använd en **egen lokal** PostgreSQL på 127.0.0.1:56432, en databas med prefixet
`eveno_bank2000_`, pgvector och alla projektmigrationer. Sätt DATABASE_URL i
processens miljö och `ALLOW_SYNTHETIC_BANK_WRITES=1`; inga nycklar behövs.
Från `apps/api`, med byggda `@eken/shared` och `@eken/ui`:

```sh
node -r ts-node/register/transpile-only scripts/eval-kundflode-2000.ts /ny/utkatalog
node -r ts-node/register/transpile-only scripts/eval-kundflode-2000.ts /annan/ny/katalog --omvand-inom-dag
python3 scripts/analysera-kundflode-2000.py /ny/utkatalog /ny/kontroll.json
node -r ts-node/register/transpile-only scripts/eval-kundflode-modell.ts /ny/utkatalog /ny/ai-plan.json
```

Utdata skrivs aldrig över. Nya körningar får egna organisations-id:n härledda
ur utmatningskatalogen; ingen återanvänder den förra kundens tillstånd.
AI-skriptet har separat opt-in `EVAL_BANK2000_LIVE=1` efter kostnadsgodkännande.
Det accepterar bara det frysta syntetiska grundmaterialet och de 110 problemfallen.

## Kodkontroller

- Jest: 1/1 svit, 4/4 prov; noll överhoppade eller todo-prov.
- API-typkontroll (`tsconfig.typecheck.json`, inklusive scripts): grön.
- ESLint för de fyra nya/berörda TypeScript-filerna: noll fel/varningar.
- Oberoende Python-omräkning: båda körningarna stämmer, varje allokering i ören
  kontrollerad. Negativkontroll efter commit `6cae79e`: ett extra öre i en
  **kopierad** allokering avvisas, ingen godkänd rapport skapas.
- Alla 14 arkiverade råfiler verifierade med SHA-256 efter uppackning.
- Vakter: OCR-proveniens (4 anrop), OCR-uppslagsfält (4 uppslag),
  delbetalningsidentitet (8 anrop/4 skrivningar), aktörsstämpling,
  AI-utfallskoppling (31 verktyg) och noll överhoppade prov: gröna.

Vakter som är gröna trots det uppmätta ordningsfelet bevisar inte att matchningen
är rätt. De mäter klassning/inkoppling, inte överensstämmelse mellan samtliga
betalningsidentifierare. Fulla API-sviten lämnas till CI enligt användarens
begränsning för den delade datorn. Ingen produktionsfil under reconciliation ändrad.
