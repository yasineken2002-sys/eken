# PR 2a — registrering och fryst provfacit före implementation

Datum 2026-09-11. Utgångs-HEAD `5acfb3906c8d82df2940a86d0456da878fad1127`.
Ägarens nya tak är 650 tillagda PLUS borttagna produktionsrader inklusive
Prisma/SQL. Den tidigare stoppgränsen och förslaget 2a.1/2a.2 är ersatta.
Tillståndskontraktet gäller fortsatt. Denna plan sparas före schema och SQL.

## Registreringscirkeln

En intern primitiv äger en ny READ COMMITTED-transaktion och den faktiska
Invoice-/RentNotice-insättningen. Den tar skapandedata, organisation och
behörig aktör, men inget befintligt dokument-ID, ingen callback och ingen
övertagen transaktion. Den genererar ett nytt UUID och skriver både id och
organisation efter anroparens data; även runtime-indata kan inte skriva över
dem. Den använder alltid CREATE, aldrig connect, upsert eller återanvändning.

Ordningen i transaktionen är: reservera den nya beständiga dokumentroten,
skapa det verkliga dokumentet med samma ID, commit. Rotens organisationsbundna
FK till Invoice eller RentNotice är DEFERRABLE INITIALLY DEFERRED. SQL CHECK
kräver exakt en av dokumentreferenserna och att den är lika med rotens stabila
ID. Ingen frånvaro av SENT, DRAFT-status, tidsstämpel eller boolesk attest
används som skapandebevis. Grundens bevis är den kontrollerade insättningen.

Rotens BEFORE INSERT-trigger tar korta SHARE ROW EXCLUSIVE-lås på Invoice
och RentNotice i fast ordning, därefter kontrolleras i en separat fråga att
ID:t inte redan finns. READ COMMITTED krävs. Låset stänger även fönstret där
en annan transaktion redan har skapat ett ännu osynligt dokument: först måste
den transaktionen avslutas, sedan prövas frånvaron. FK:n vid commit kräver att
det nya dokumentet verkligen skapats i rätt organisation och av rätt typ.
Att direkt SQL försöker registrera ett gammalt dokument ska också avvisas.

Misslyckad registrering, dokumentinsättning eller commit rullar tillbaka båda
raderna. Ingen kö eller extern effekt finns. Deadlock med en äldre transaktion
kan ge ett synligt konfliktfel och hel rollback; inga partiella registreringar
eller automatiska utskick följer. Inga nya triggers sätts på gamla tabeller.
Registreringslåsen tas endast när den nya, ännu oanropade primitivens rot
skrivs. Global låsordning/kostnad behöver beaktas före inkoppling i 2c.

Fall A använder exakt denna primitiv i DB-specen. Efter skapandet får provet
bygga verkliga avläsningar, kontrollbeslut och dokumentrader via befintliga
domänmetoder och DB-insättningar; det skriver inget eget historiskt klartecken.
Dokument som saknar rot ger HISTORY_UNVERIFIED och kan inte tas över i 2a.

## Originalposition, historik och atomisk försegling

Fyra logiska mängder: dokumentrot, oföränderligt beslut, charge/check-medlemmar
och oföränderliga händelser. Beslutets UUID är också utskicks-ID (en till en),
medan försöks-ID skapas först vid SENDING. Nytt beslut efter återkallelse eller
slutligt misslyckande får nytt utskicks-ID men samma dokumentrot.

Tillståndet läses från sista händelsen per beslut. Ingen fristående muterbar
statuskolumn kan glida ifrån historiken. Den aktiva reservationen är existensen
av DECIDED/SENDING/UNKNOWN på roten. Originalet förbrukas permanent genom en
PROVIDER_ACCEPTED-händelse för ORIGINAL på samma rot, oberoende av version och
nyckel. Omsändningar får egna beslut och koppling till originalets acceptans.

Alla nya beslut/övergångar ordnas under organisationslåset som den befintliga
charge-grinden använder, med läsningar efter låset. Samma kommandonyckel inom
organisationen får bara ha en innebörd. Medlemmar får bara infogas under
beslutets skapandetransaktion och före dess första händelse. Den första
händelsen jämför hela medlemsmängden med dokumentkopplingarna och snapshoten;
en uppskjuten kontroll kräver att beslutet har förseglats före commit.
UPDATE, DELETE och TRUNCATE av nya bevisrader ska avvisas av deras egna regler.

Snapshoten är en serverhämtad domänsnapshot. Den binder exakta decimalvärden,
dokument/rader/krediter, parter, tryckta organisations-/betalningsuppgifter,
avtal/fastighet, mallkontrakt och samtliga aktuella charge/check-identiteter.
Den intygar inga ännu oframställda PDF-/mejlbyte eller logotypbyte; detta anges
uttryckligt i manifestet och måste bindas med separat bevis i 2b.

## Isolerad PostgreSQL och städning

Skapa en egen ny tom testdatabas och applicera hela migrationskedjan i public.
Varje DB-speckörning skapar därefter ett eget UUID-namngivet testschema i just
den databasen. Det får samma oförändrade migrations-SQL, i ordning, via psql
med ON_ERROR_STOP och search_path=<eget>,public. Prisma-klienterna, även de
separata raceanslutningarna, använder explicit det egna schemat.

Vector-extension måste redan ligga i public och förbli där; annars avbryts
riggen. Baslinje över public-tabeller, radantal, scheman och extension mäts
före privata migrationer. Efter alla prov räknas de egna committade fixturerna,
samtliga klienter kopplas ned, och endast exakt det egna schemat tas bort.
Baslinjen kontrolleras igen. Inga triggers stängs av, inga historikundantag
införs och inget annat schema raderas. Två körningar använder samma databas
och ska lämna samma baslinje. DDL-städningen är isolering av en hel provmiljö,
inte en tillåten radering genom modellens produktions-API.

## Fryst, oberoende facit — fjorton identifierade rader

Facit är fastställt före implementation. Testerna får inte importera en
produktionsmappning för att räkna fram sina förväntningar. Fler assertioner och
motprov får läggas till utan att försvaga dessa förväntningar.

| ID | Förutsättning | Handling | Förväntat observerbart resultat |
| --- | --- | --- | --- |
| 2a-01 | Riktig registrering, komplett godkänt underlag, inget beslut | Fatta ORIGINAL-beslut | A: exakt ett beslut/utskicks-ID, första händelse och alla charge/check-medlemmar; rätt organisation, mottagare och domänsnapshot. |
| 2a-02 | ORIGINAL med korrelerad bekräftad leverantörsacceptans | Nytt ORIGINAL, även ny version/mottagare/nyckel | B: ORIGINAL_ALREADY_ACCEPTED, noll nya beslut/händelser/medlemmar. |
| 2a-03 | Accepterat fakturaoriginal, giltigt aktuellt underlag | Två successiva avsiktliga omsändningar, bekräfta mellan dem | C: två nya INVOICE_RESEND-beslut med egna utskicks-ID:n och originalkoppling; exakt replay skapar inget tredje. Ingen aviomsändning. |
| 2a-04 | ORIGINAL eller omsändning har UNKNOWN | Nytt original och omsändning, även efter versions-/nyckelbyte och omstart | D: OUTCOME_UNKNOWN_REQUIRES_HUMAN för båda; inga nya operationer, tidens gång ändrar inget. |
| 2a-05 | Befintligt beslut/kommando | Exakt replay, därefter ändra innebörd under samma nyckel | Replay ger samma identiteter utan verkställighetsrätt/radtillväxt även efter aktuell DB-ändring; ändrat dokument/mottagare/underlag/operation/aktör/försök ger KEY_CONFLICT. |
| 2a-06 | DECIDED respektive committad SENDING | Koppla ned klient och skapa ny tjänsteinstans; upprepa start | Tillstånd och identiteter kvar i PostgreSQL; exakt en vunnen start, replay får ALREADY_STARTED och samma försöks-ID. |
| 2a-07 | Två klienter och styrt faktisk överlappande transaktioner | Samtidiga ORIGINAL med olika respektive samma nyckel | Olika nycklar: exakt en vinnare och en definierad blockering. Samma nyckel: ett beslut, samma identitet. Väntan gäller testets egna anslutningar. |
| 2a-08 | DECIDED och två separata klienter | Återkalla mot start, prova båda låsordningarna | Endast en vinner; REVOKED startar inte och SENDING återkallas inte. Historiskt godkännande kvar. |
| 2a-09 | REVOKED eller FAILED_NO_ACCEPTANCE med slutbevis | Uttryckligt nytt beslut, därefter replay av gammal nyckel | Nytt beslut tillåts inom samma oförbrukade originalposition, nytt utskicks-ID; gamla nyckeln ger gamla avslutade beslutet. |
| 2a-10 | Två verkliga organisationer med existerande dokument, användare, charges och checks | Korskoppla identiteter via metod och direkt SQL, även fel dokument/check inom samma org | Avslag och ingen partiell effekt; ett saknat UUID räknas inte som detta bevis. |
| 2a-11 | Dokument med flera riktiga charges | Godkänn alla, pröva blockerad/utelämnad medlem samt extra INSERT efter försegling | Alla och endast rätt medlemmar binds; blockerad charge ger helt avslag; senare INSERT, UPDATE, DELETE och TRUNCATE nekas. |
| 2a-12 | Oföränderligt beslut och korrelerat försök | Ogiltiga övergångar, fel försöks-ID och otillräckligt slut-/utredningsbevis | Ingen status/historikskrivning; UNKNOWN kan bara få slututfall med mänsklig utredning och korrelerat bevis, aldrig via timeout. |
| 2a-13 | Verkliga delskrivningar i transaktion | Framkalla fel vid registrering, efter besluts-/medlemsskrivning och efter övergång | Hel rollback, inga halvskapade dokumentgrunder/beslut/medlemmar/händelser eller förbrukade nycklar. |
| 2a-14 | Äldre existerande dokument, även ocommittad äldre INSERT i annan anslutning | Försök registrera gammalt ID; skapa sedan nytt med riktiga primitivens data | Gammalt dokument får ingen grund; väntande registrering ser den äldre commiten och avvisas. Primitiven skapar eget nytt ID och riktiga dokument/grunder atomiskt utan aktiverade producenter. |

Preliminär produktionsbudget efter denna precisering: cirka 600–640 rader,
inklusive schema, SQL, interna metoder och CI-kontroll (den senare redovisas
också separat). Utfallet mäts under implementation; 650 är stoppgränsen.
Granskning ska ske mot både detta facit, tillståndskontraktet och faktisk diff.
