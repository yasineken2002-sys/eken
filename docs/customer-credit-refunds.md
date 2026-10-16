# Kundtillgodo – reserverad och bankbekräftad återbetalning

Etappen bygger vidare på kundtillgodo och beständigt aviutskick i
`6e7c2215` ([utkast #959](https://github.com/yasineken2002-sys/eken/pull/959)).
Den inför en domänlivscykel för återbetalning och tester mot isolerad Postgres
med en syntetisk bank. **Ingen verklig bankutbetalning är ansluten.** Den enda
produktionsadaptern svarar alltid att tjänsten inte är tillgänglig. Ingen
controller, aktiveringsväg eller banknyckel läggs till. Ingen kundpolicy skapas
eller aktiveras.

## Saldo och reservation

Disponibelt tillgodo beräknas som ursprungsbelopp minus bokförda användningar
minus återbetalningar i alla tillstånd utom `CANCELLED` och `REJECTED`.
`SETTLED` fortsätter alltså förbruka beloppet exakt en gång. En återbetalning
kan omfatta en del av det återstående saldot, också efter tidigare användning.
Den här etappen samlar inte flera tillgodoposter till en enda utbetalning.

Exempel: 100 kr tillgodo, 30 kr redan använt och 50 kr reserverat för
återbetalning ger 20 kr kvar för nästa avi. En reservation skapar inget
verifikat. Aviavdrag och återbetalningsreservation tar samma tillgodolås,
läser om saldot under lås och skyddas även av databasen. Skrivningarna kräver
Read Committed; en äldre transaktionsbild får inte kringgå den gemensamma
saldokontrollen.

Anropsnyckeln är unik inom organisationen. Samma begäran återanvänder sin
reservation; ändrat belopp eller annan tillgodopost med samma nyckel avvisas.
Instruktionens identitet, belopp, konton och mottagarbindning fryses. Skuld-
och bankkonton måste vara uttryckligen valda, tillhöra organisationen och
stämma med tillgodots ursprungliga bankbokföring. Inga konton väljs automatiskt.
`refundEnabled` är `false` som standard och inget bokföringskonto förifylls.

## Bankbesked och bokföring

| Tillstånd        | Betydelse                                                        | Disponibelt igen? |
| ---------------- | ---------------------------------------------------------------- | ----------------- |
| `RESERVED`       | Beloppet är reserverat; inget bankförsök har startat             | Nej               |
| `SUBMITTING`     | Försöket är beständigt registrerat före bankanropet              | Nej               |
| `UNKNOWN`        | Bankutfallet är fortfarande oklart                               | Nej               |
| `BANK_CONFIRMED` | Verifierad bokad debitering har sparats                          | Nej               |
| `SETTLED`        | Debiteringen har också bokförts atomiskt med slutstatus          | Nej               |
| `CANCELLED`      | Lokal annullering innan något bankförsök startat                 | Ja                |
| `REJECTED`       | Banken intygar att instruktionen inte har och aldrig kan utföras | Ja                |

Bankporten anropas utanför databastransaktioner. Endast processen som ändrar
`RESERVED` till `SUBMITTING` får skicka instruktionen. Efter detta används
bara uppslag på samma instruktion. Timeout, `PENDING`, `UNKNOWN` och
`NOT_FOUND` frigör aldrig pengar och tillåter aldrig en ny betalning.

Bankbevis måste binda organisation, hyresgäst, bankkonto, mottagare, belopp,
valuta och fryst instruktion till bankens beständiga överföringsidentitet.
En bokad debitering behöver dessutom transaktionsidentitet och bankdag.
Bankidentiteter avgränsas med leverantör och leverantörens konto; samma
transaktions-id hos två olika banker får förekomma. Ny kontrolltid för samma
beständiga fakta skapar inget nytt ekonomiskt utfall.

Bankbeviset sparas **före och separat från bokföringstransaktionen**. Ett fel
i bokföringen kan därför inte sudda ut en verklig utbetalning. Bokföringen
verifierar det sparade beviset, debiterar tillgodoskulden och krediterar det
frysta bankkontot på bankens dag i Stockholm. Verifikat och `SETTLED` skrivs
atomiskt. Omförsök kontrollerar även innehåll, koppling och eventuell rättelse
av ett redan befintligt verifikat.

## Automatisk uppföljning och frigivet saldo

En schemalagd kontroll söker var femtonde minut efter påbörjade återbetalningar,
tidigast femton minuter efter start. Högst 100 rader tas per pass. Ett atomiskt
anspråk sparar nästa försök före bankuppslaget: efter 1 timme, 4 timmar och
därefter 24 timmar. Upprepade okända utfall och fel går till den befintliga
varaktiga cron-felhanteringen. Kontrollen börjar aldrig skicka en reserverad
utbetalning; den följer bara upp redan påbörjade instruktioner.

Ny reservation och första bankförsök kräver aktuell policy, tillåtna konton,
icke avidentifierad hyresgäst och färska betalningsdata. Sena bankbesked
bevaras och följs upp även om dessa förutsättningar senare upphör. En känd
aktör krävs; agentutförande avvisas eftersom återbetalningsdelegation ännu
inte är implementerad.

Mottagarunderlaget måste fortfarande vara giltigt vid första bankförsöket.
Har det gått ut ligger reservationen kvar; uppföljningen startar den inte
och byter inte dess frysta mottagare. Den kan annulleras före start och
ersättas av en ny begäran med nytt verifierat underlag.

Har mellanliggande avier hunnit skickas medan tillgodot var reserverat får
ett definitivt frigivet belopp användas på en senare avi först när varje
mellanliggande månad har en ordinarie, slutbetald avi. Saknade månader,
obetald skuld och kundförluster får inte hoppas över. Redan fastställda
betalningsunderlag skrivs aldrig om.

## Historik och bevarande

Order och append-only-händelser ger separata tidpunkter för reservation,
bankbekräftelse och bokföring. Hyresgästens historik och GDPR-export skiljer
på dessa utfall och använder en uttrycklig fältlista. Mottagarreferenser,
bankbevis, leverantörsreferenser och hashvärden exponeras inte där. Ekonomiskt
underlag bevaras vid avidentifiering; nya kundeffekter spärras.

Databasen förbjuder radering av återbetalningar och deras händelser. Även
dev-verktyget för organisationsradering avbryter innan någon radering när
sådant underlag finns. Spärren kringgås inte för tester eller dev-purge.

## Kvar före verkliga utbetalningar

- En granskad bankadapter måste verifiera organisationens betalkonto,
  mottagarens kontobindning och bankens faktiska debitering. Att kopiera
  instruktionens förväntade fält till ett svar är inget bankbevis.
- Bankens idempotens och slutliga avslag måste vara definierade. En krasch
  efter `SUBMITTING` men före bankanropet kan lämna en reservation utan faktisk
  utbetalning. Ett enkelt ”hittas inte” kan inte bevisa att ett fördröjt anrop
  aldrig kommer att genomföras. Adaptern behöver en definitiv bankgaranti för
  att säkert frigöra beloppet i det läget; annars ligger reservationen kvar.
- En behörighetskontrollerad produktväg för initiering och godkänd
  mottagarbindning återstår. Ingen kund kan starta denna tjänst via ett nytt API.
- Kontoval, periodhantering, Fortnox-export, driftlarm och produktionsaktivering
  behöver granskas tillsammans med resten av kundtillgodoflödet. Claude
  granskar och mergar; detta arbete aktiverar inga kundorganisationer.

Testerna mäter beteendet i konstruerade scenarier. De ger ingen ny uppskattning
av matchningsprecision, andel manuella granskningar eller kostnad per betalning.

## Verifiering i denna etapp

- **290/290 prov i 17 riktade sviter**, räknat på senaste körning per fil.
  Den sista frigivningssviten kunde först inte starta på grund av tre strikta
  TypeScript-kontroller i testfilen; efter rättelse klarade den 20/20.
  [Sammanställning](./eval/customer-credit-refunds/targeted-summary.txt),
  [samlad körning före typfixen](./eval/customer-credit-refunds/targeted-before-release-typefix.txt)
  och [omkörning av frigivningssviten](./eval/customer-credit-refunds/release-tests.txt).
  Huvudlivscykeln kördes sedan om med ytterligare ett samtidighetsprov:
  [32/32 prov](./eval/customer-credit-refunds/lifecycle-tests.txt).
- **78/78 bokföringsprov även i en separat process med
  `TZ=America/Los_Angeles`**, inklusive bankens Stockholmsdag.
  [Zonkörning](./eval/customer-credit-refunds/accounting-los-angeles.txt).
- **20 relevanta vakter gröna**, inklusive transaktionsgränser, aktörsstämpling,
  cronklassificering, felsänka, historikinventarium och append-only.
  [Vaktutdata](./eval/customer-credit-refunds/guards.txt).
- Prisma validerat, klient genererad och den enda nya migrationen applicerad
  i isolerad lokal testdatabas. Riktad ESLint och `git diff --check` gröna.
- Hela API-typkontrollen nådde den avtalade lokala minnesgränsen på 1,5 GB
  och avbröts. [Lokalt utfall](./eval/customer-credit-refunds/typecheck-local.txt).
  Full typkontroll och hela testsviten verifieras av CI på PR:ens aktuella commit.
