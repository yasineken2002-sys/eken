# Steg 2.2 — bindning och identitetsgräns

Det kompletterade beteendefacitet frystes i `b2de5c13` före implementation.
Denna text beskriver mekanismen; uppmätta resultat redovisas separat.

## Återanvänt skydd

`DeliveryDecisionCommand.resources/team`, fullständig JSONB-jämförelse av
`DeliveryEvent.request` samt SQL:s `delivery_dispatch_insert` fanns på basen.
Den senare kräver samma transaktion för beslut och dispatch, samma organisation,
dokument och mottagare samt samma manifest/team som i första beslutseventet.
Befintliga append-only-spärrar skyddar beslut, manifest, body och digest.
Ingen ny tabell eller migration behövs för att återskapa detta skydd.

Det nya valfria `rendering`-fältet ingår i samma fullständiga request. Det bär
version, asOf, avsändaradress, logotypens nyckel/MIME/base64 och PDF-miljöns
identitet. `resources` binder hash av logotypbyte och miljöidentitet.
Den verkliga adaptern kräver rendering-kontext. Äldre 2a/2b-kommandon får inga
nya standardfält, och deras JSONB-innebörd ändras inte.

`enqueue` kopierar kommandot innan första await. Förhandsläsningen auktoriserar
och jämför replay innan den läser aktuell snapshot. Ett identiskt redan
committat kommando återger befintlig dispatch utan resurshämtning/rendering.
För nya kommandon körs Chromium utanför skrivtransaktionen. `decide` kontrollerar
snapshot igen, och resurserna kontrolleras vid bindningen. Constraints slås på
omedelbart före commit som tidigare. Ett fel rullar tillbaka beslut/medlemmar/
event/dispatch tillsammans. Konkurrerande identiska förberedelser kan rendera
flera gånger, men bara ett resultat binds; den andra får det sparade resultatet.

## Verklig framställning

`DeliveryRenderer` har inga domän-DB-, lagrings- eller konfigurationsanrop. Den
använder sparat underlag, `PdfService.renderInvoice`,
`AviseringService.buildNoticePdfHtml`, `PdfService.generateFromHtml`,
`MailService.buildInvoice/buildRentNotice` och `MailRenderer`.
Fakturamejlets befintliga byggning har lyfts till en gemensam statisk metod;
produktionsanroparen delegerar till den med samma argument och beteende.

SQL-delivery-snapshotens talsträngar avkodas mot Prismas deklarerade skalärtyper.
Datum och tider kontrolleras för kalendergiltighet innan Date konstrueras.
Ogiltiga tal, icke-finit konvertering, förlust av decimalvärde och osäkra heltal
avvisas. Arrayordningen bevaras. Den verkliga renderaren räknar och formaterar
med samma nyttolastbyggare som tidigare.

Identiteten omfattar 2.1:s explicita fil-/paketgräns, adapter/mappningsfilen,
genererad Prisma-runtime, Node, Chromium, bibliotek, typsnitt, fontconfig,
lokalisering och deklarerade miljövariabler. Det är ingen påstådd fullständig
applikationsimportgraf. Logotypens frysta byte och MIME följer kommandot;
nytt innehåll bakom samma nyckel kan inte ersätta dem vid reproduktion.
Den aktiva kod-/motormiljön läses färskt vid identitetskontroll.

`reproduce` jämför verkligt återframställd fullständig providerbody med den
sparade bodyn och digesten. Den skriver ingenting och ger ingen anropsrätt.
Transportvägen `run` skickar alltid den oföränderligt sparade bodyn och samma
attemptId. Retry efter en redan beviljad start kräver inte ny rendering eller
att dagens domändata/miljö är oförändrade. De befintliga tids- och anropsgränserna
avgör separat om ett omanrop får göras.

## Kvarstående gränser

- Installationen måste vara oföränderlig under framställningen. Hashkontroller
  bevisar inte säkerhet mot en godtyckligt växlande installation mellan kontroller.
- Betrodda renderaren och dess bindningskod är tillitsgränsen. En body/digest i
  SQL är inte i sig ett bevis för korrekt sakligt fakturainnehåll.
- PROVIDER_ACCEPTED är API-acceptans, inte mottagarleverans eller läsning.
- Den dokumenterade patologiska pausen efter sista transportauktorisationen
  (2b-26) kvarstår; reproduktionsbeviset täpper inte till den.
- Ingen produktionsanropare eller flagga har kopplats till denna adapter.
  Äldre dokument, övergång och aktivering hör till senare beställningar.
- Historiskt skäl till att den frysta kontexten inte bands tidigare:
  **INGEN DOKUMENTERAD ORSAK**.
