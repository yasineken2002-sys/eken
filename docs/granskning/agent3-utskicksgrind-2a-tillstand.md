# PR 2a — tillstånd och övergångar före SQL

> Historiskt stoppunderlag. Ägaren höjde senare taket till 650 rader.
> Tillståndskontraktet gäller; registrering/städning preciseras i
> [bevisplanen](agent3-utskicksgrind-2a-bevisplan.md) och den genomförda 2a
> rapporteras i [leveransrapporten](agent3-utskicksgrind-2a-leverans.md).

Datum: 2026-09-11. Detta är ett designkontrakt, inte implementerade garantier.
Tabellen sparas före ändringar i schema, migrationer eller produktionskod.
Storleksprövningen görs efter denna första sparning. Inga utskick aktiveras.

## Verifierad arbetsyta och kodpremiss

- Worktree: `/workspaces/eken-fran-mac-20260909/arbete/agent3-utskicksgrind`.
- Gren: `codex/agent3-utskicksgrind`; ren arbetskopia före skrivning.
- HEAD före dokumentet: `c042493243e6922976a0f05baec8d0e4a80cdc86`.
- Lokal och fjärrspårad PR-bas: `codex/agent3-debiteringsgrind`, båda på
  `9f879291dd039e404ba80b7266fbd53842a0b42b` vid kontroll.
- `CLAUDE.md` och förinventeringen är lästa. Inga AGENTS.md hittades i
  worktreen eller de kontrollerade föräldrakatalogerna.

Följande har spårats på nytt i koden, med radnummer relativa till reporoten:

| Premiss | Kontrollerad kodkedja | Konsekvens för modellen |
| --- | --- | --- |
| Faktura får omsändas | `apps/api/src/invoices/invoices.service.ts:1617`, `:1666`, `:1705` | VOID/PAID avvisas; SENT hindrar inte ytterligare köläggning och SENT-event. Omsändning måste vara en egen operation. |
| Avi avstår efter SENT | `apps/api/src/avisering/avisering.service.ts:927`, `:945` | sentAt/SENT stoppar avijobbet. Ingen generell aviomsändning införs. |
| SENT föregår leverantören | `apps/api/src/mail/mail.service.ts:489`, `:694` → `mail.queue.ts:102`; faktura `:1703`, avi `:990`; leverantör först i `mail.worker.ts:89` | Köläggning och SENT är inga acceptansbevis. MailQueue kan även returnera tom sträng vid suppression (`:64`). |
| Fakturans nyckel är statisk | `apps/api/src/invoices/invoices.service.ts:1698` → `mail.queue.ts:96` | Bull-jobbets retention (`mail.queue.ts:92`) får inte definiera beslutets giltighet. |
| Huvudradens updatedAt täcker inte innehållet | `apps/api/src/invoices/pdf.service.ts:135`, `:151`, `:160`; `apps/api/src/avisering/avisering.service.ts:1012`, `:1047` | Rader, parter, organisation, mall, krediter och logotyp måste ingå i versionskontraktet. |
| Kontroll och dokument är olika identiteter | `apps/api/src/consumption/charge-gate.ts:242`, `:253`; `apps/api/prisma/schema.prisma:6293`, `:5071` | Befintlig kontroll binder avläsningsunderlaget; dokumentets hela charge-mängd måste hämtas separat från DB. |

Ytterligare kontroll: `apps/web/src/features/invoices/InvoicesPage.tsx:345`
sätter SENT via statusändring; e-postknappen är separat (`:915`). SENT kan alltså
även uppstå utan köläggning. Det får varken bli originalbevis eller ensamt
auktorisera omsändning i den nya modellen.

## Beständiga tillstånd och frånvaro

Ett beslut är ett oföränderligt godkännande av ett visst underlag vid en viss
tidpunkt. Utskickets tillstånd är en separat projektion av dess övergångar.
Godkännandet skrivs inte om när ett försök återkallas eller blir osäkert.

| Tillstånd | Representation | Vad det bevisar och blockerar |
| --- | --- | --- |
| Inget beslut | Frånvaro av beslutsrad | Bevisar endast att den nya modellen saknar beslut. Bevisar inte att äldre jobb eller utskick saknas. |
| Äldre historik ej klarlagd | Separat dokumentgrund `HISTORY_UNVERIFIED`, alternativt uttryckligt blockeringsutfall när sådan grund saknas | Inget fabricerat godkännande eller försök. Nya original och omsändningar blockeras tills övergången från äldre flöden har verifierats. |
| Beslut fattat, inte utlämnat | `DECIDED` | Godkänd snapshot finns, inget försök har fått starta enligt modellen. Ingen köläggning eller leverans påstås. |
| Återkallat före start | `REVOKED` | Det beslutet får aldrig användas för start. Återkallelsen och det äldre godkännandet finns båda kvar. |
| Försök pågår | `SENDING` med beständig försöksidentitet | Start har reserverats och committats före eventuell extern effekt. Ny start, nytt beslut och omsändning för samma dokument blockeras. |
| Försöksutfall okänt | `UNKNOWN` med samma försöksidentitet | Kräver mänsklig utredning. Blockerar både nytt original och fakturaomsändning över alla dokumentversioner. |
| Leverantörsacceptans bekräftad | `PROVIDER_ACCEPTED` | Leverantören har accepterat exakt detta försök. Säger inget om mottagarleverans eller läsning. Första originalet är förbrukat. |
| Bekräftat misslyckande utan acceptans | `FAILED_NO_ACCEPTANCE` | Verifierat att just detta försök inte accepterades och inte fortfarande kan accepteras. En timeout, köstatus, bounce eller uteblivet uppslag räcker inte. |

`SENDING`, `UNKNOWN`, `REVOKED` och terminala utfall behöver egna beständiga
värden: de tillåter olika efterföljande handlingar och måste överleva en
processkrasch. Enbart frånvaro av ett kvitto kan inte skilja dem åt.
`HISTORY_UNVERIFIED` är dokumentgrund, inte ett påhittat utskicksbeslut.
Ett nytt dokument kan få klarlagd grund först genom verifierbar registrering
under den kontrollerade vägen; enbart DRAFT eller avsaknad av SENT räcker inte
för att bevisa att inget äldre köjobb finns. Övertagandet av äldre jobb byggs
inte i 2a. En intern registrering av nya dokument behöver däremot ingå i
2a-kontraktet: grund för oskickat dokument ska kunna härledas till dokumentets
kontrollerade skapandetransaktion, inte vara en klientflagga. Exakt API för
den bindningen är en kvarstående designfråga vid budgetstoppet; A/C är inte
bevisade genom att testet handskriver ett påstått historiskt klartecken.

## Övergångstabell

Alla metoder är interna och har ingen inkoppling i appmodul, rutt, cron,
producent, worker eller leverantör. Aktör betyder verifierad organisationsbunden
behörig användare, eller en senare uttryckligt verifierad tjänsteprincipal.
2a får inte tolka saknad aktör som människa eller automatiskt godkänna SYSTEM.

Gemensam atomisk regel: transaktion, samordning per organisation/underlag och
stabil dokumentidentitet, läsning efter erhållet lås, validering, övergångshändelse
och tillståndsprojektion i samma commit. Varje kommando har en beständig unik
kommandoidentitet och jämför hela sin betydelse vid återanvändning.
Beslut, charge-bindningar och första händelsen sparas tillsammans eller inte alls.

| Från → till | Förutsättning | Aktör och bevis | Atomisk skrivning | Samma anrop igen |
| --- | --- | --- | --- | --- |
| Inget beslut → DECIDED, ORIGINAL | Klarlagd dokumentgrund; inget tidigare accepterat original; ingen DECIDED/SENDING/UNKNOWN på dokumentet; tillåten dokumentstatus, komplett aktuell snapshot och alla charge-kontroller godkända | Behörig beslutsaktör; DB-hämtade check-ID/revision/fingerprint/regelversioner, snapshot och grund för frånvaro av äldre utskick | Beslut, egen utskicksidentitet, samtliga charge-bindningar och första händelse; reservation av dokumentets originalposition | Identisk begäran läser samma beslut och aktuellt tillstånd. Skapar inget; ger aldrig på nytt rätt att utföra en extern effekt. |
| Efter klarlagd acceptans → DECIDED, INVOICE_RESEND | Faktura, tillåten dokumentstatus och alla aktuella kontroller; tidigare originalacceptans klarlagd; ingen DECIDED/SENDING/UNKNOWN för dokumentet | Behörig aktör med uttrycklig omsändningsavsikt och skäl; länk till tidigare accepterat original | Ny operation, nytt beslut och nytt utskicks-ID; originalets identitet och bevis lämnas orörda | Samma omsändningsnyckel återläser samma operation. Ny avsikt kräver ny nyckel och nytt beslut. |
| DECIDED → REVOKED | Start har ännu inte reserverats | Behörig aktör; skäl och referens till beslutet | Ny återkallelsehändelse + projektion; släpp bara den aktiva reservationen. Beständig originalposition, identiteter, nycklar och godkännande behålls | Identisk återkallelse återläses, annat innehåll med samma kommando-ID ger konflikt. |
| DECIDED → SENDING | Samma beslut/snapshot/charge-mängd fortfarande giltigt; ingen återkallelse eller osäkerhet; nytt beständigt försök | Intern exekveringsaktör enligt kontrakt; snapshotjämförelse och aktuella kontrollbevis | Försöks-ID och starthändelse + SENDING committas före extern effekt | Återläser samma försök med utfallet ALREADY_STARTED; får inte anropa leverantören igen. |
| SENDING → UNKNOWN | Utfallet kan inte bevisas, exempelvis avbruten process eller förlorat svar | Intern rapporterande aktör; försöks-ID och konkret observation om varför bevis saknas | Osäkerhetshändelse + UNKNOWN; försöks-/utskicks-ID behålls | Samma observation återläses. Ingen ny nyckel, automatisk retry eller upplåsning. |
| SENDING → PROVIDER_ACCEPTED | Tillförlitligt positivt svar korrelerat till exakt försök | Intern rapporterande aktör; leverantör, message-ID/kvitto, utskicks-/försöks-ID och bevarat bevis | Acceptanshändelse + projektion; originalpositionen förblir förbrukad oavsett senare snapshot | Samma bevis återläses; motstridigt bevis ger konflikt. |
| SENDING → FAILED_NO_ACCEPTANCE | Definitivt bevis att försöket inte accepterades och inte längre kan accepteras | Intern rapporterande aktör; korrelerat negativt slutbevis, inte ett generiskt transportfel | Felhändelse + projektion; bara aktiv reservation frigörs. Originalposition, gamla beslut och nycklar behålls | Samma bevis återläses; inget automatiskt nytt försök. |
| UNKNOWN → PROVIDER_ACCEPTED | Mänsklig utredning ger tillförlitligt positivt bevis | Behörig människa; ärendereferens, beviskälla, korrelation, utredning och verifierbart acceptansbevis | Ny utrednings-/acceptanshändelse + projektion på samma försök | Identiskt kommando återläses; oenigt slutbevis ger konflikt. |
| UNKNOWN → FAILED_NO_ACCEPTANCE | Mänsklig utredning bevisar både ingen acceptans och att ingen fördröjd acceptans fortfarande är möjlig | Behörig människa med samma spårkrav; avsaknad av ett sökresultat eller utgången dedupliceringstid räcker inte | Ny utrednings-/felhändelse + projektion på samma försök | Identiskt kommando återläses. Kan bevis inte erhållas stannar UNKNOWN. |
| REVOKED/FAILED_NO_ACCEPTANCE → senare nytt beslut | Uttrycklig ny begäran, nya aktuella kontroller, ingen annan DECIDED/SENDING/UNKNOWN på dokumentet | Behörig beslutsaktör; länk till föregående avslutade beslut och dess slutbevis | Ny beslutsrad och nytt utskicks-ID. Samma logiska originalposition för dokumentet om originalet aldrig accepterats; annars en ny INVOICE_RESEND | Det gamla kommandot återläser bara det gamla avslutade beslutet. Den nya begärans nyckel har egen idempotens. |
| Alla andra övergångar | Otillåtna | Exempel: REVOKED → SENDING, UNKNOWN → DECIDED, ACCEPTED → FAILED eller efterhandsåterkallelse | Ingen skrivning; uttryckligt konfliktutfall | Förblir konflikt. |

Krasch efter SENDING-commit lämnar SENDING kvar. En återstartsprocess får senare
registrera att försöket måste utredas som UNKNOWN; en timeout får endast utlösa
utredning, aldrig slutsatsen accepterat/inte accepterat. 2a implementerar ingen
återstartsprocess. Ett omstartat tjänsteobjekt ska ändå läsa och blockera på
båda tillstånden direkt ur PostgreSQL.

Tillåten dokumentstatus kontrolleras både vid beslut och start: faktura
VOID/PAID och avi CANCELLED får inte få ett nytt godkännande. Dessa kontroller
gäller enbart de nya interna metoderna; befintliga avijobb ändras inte i 2a.

## Fyra riktningar och idempotens

| Fall | Avsett metodutfall | Oberoende beteendefacit för framtida DB-spec |
| --- | --- | --- |
| A: oskickat original, övriga krav uppfyllda | CREATED, ORIGINAL | Exakt ett beslut, ett utskicks-ID, alla charge-bindningar; efter omstart samma ID. |
| B: nytt första original efter klarlagd acceptans | ORIGINAL_ALREADY_ACCEPTED | Inga nya rader, även vid nytt nyckelvärde, ny mottagare eller ändrad snapshotversion. |
| C: avsiktlig fakturaomsändning | CREATED, INVOICE_RESEND | Egen identitet och beslut; referens till tidigare accepterat original. Samma nyckel igen ger inte en tredje operation. |
| D: något försök på dokumentet är UNKNOWN | OUTCOME_UNKNOWN_REQUIRES_HUMAN | Både ORIGINAL och INVOICE_RESEND avvisas, även med nya nycklar och versioner. |

En exakt återläsning av ett äldre beslut är tillåten också när utfallet är
UNKNOWN, men svaret ska uttryckligen ange blockeringen och får inte vara ett
nytt verkställighetsgodkännande. Ändrat dokument, mottagare, operation, aktör,
snapshot eller kontrollunderlag för en redan använd nyckel ger KEY_CONFLICT.
En kontroll av konflikt måste ske även när den alternativa begäran riktas mot
ett annat dokument; unikhet enbart under dokument-ID är därför för svag.

Begärans oföränderliga innehåll ska jämföras vid återläsning, inklusive dess
förväntade snapshot-/kontrollidentiteter. Ett identiskt kommando kan återläsa
sitt historiska beslut även om aktuella DB-rader har ändrats; det är inte en
auktorisering av dessa nya rader. Endast ett nytt beslut eller start prövar
aktuell DB mot det bundna underlaget. Försök att använda samma nyckel med nya
förväntade identiteter är däremot KEY_CONFLICT.

## Identiteter och minsta integritetsansvar

- Stabil dokumentidentitet: organisation + dokumenttyp + källans dokument-ID.
  Den överlever innehålls-/mottagarändring. Originalpositionen binds hit, aldrig
  bara till en dokumentversion eller ett innehållsfingeravtryck.
- Besluts-/utskicksidentitet: separat från dokumentet och separat för varje
  uttryckligt nytt godkännande. Nyckeln är NOT NULL och unik inom organisationen.
  En gammal eller borttagen Redis-kö kan inte frigöra den.
- Försöksidentitet: skapas en gång vid SENDING, kopplas till utskicket och alla
  utfallshändelser. Ingen ny försöksidentitet medan ett utfall är osäkert.
- Charge-bindning: DB-unikhet per organisation, charge, dokument och utskick;
  check-ID/revision, reading-ID, fingerprint och regelversion binds till rätt
  organisation och charge. Flera charges ska tillåtas på samma dokument.
- Organisation, dokument, charge och check kräver verifierade relationer och
  nödvändiga sammansatta FK/constraints. Polymorf dokumentreferens får inte
  bli en fri textsträng som kan peka på fel organisation eller på ingenting.
- Befintlig unikhet utökas inte med nullable nycklar. Om ett befintligt unikt
  villkor måste utökas gäller sentinelregeln i `CLAUDE.md:1996`; nya beslut får
  inga defaultvärden som påstår att historiska attester finns.
- Ursprungligt beslut, snapshot och händelser är oföränderliga. Projektionen
  får bara ändras atomiskt med en giltig ny händelse. Historik får inte kunna
  raderas för att återöppna originalet eller frigöra en idempotensnyckel.
- Även bindningsmängden måste förseglas vid commit. UPDATE/DELETE-skydd räcker
  inte om en extra charge-bindning kan INSERT:as efter beslutet. DB ska neka
  både utelämnade medlemmar och efterhandsutökning samt en projektion utan
  motsvarande giltig händelse. Detta behöver egna direkta SQL-motprov.
- Databasregler på de nya tabellerna får samordna deras egna skrivningar.
  Nya spärrtriggers på befintliga producent-/dokument-/underlagstabeller ingår
  inte: de skulle ändra gamla flöden redan vid migration och bryta inaktiviteten.

## Snapshotens omfattning och gräns mot 2b

Snapshoten är ett kanoniskt, versionsmärkt innehållskontrakt med deterministisk
ordning, exakt decimalrepresentation och definierade datumformat. Den omfattar
dokumenthuvud, samtliga rader och relevanta krediter, mottagarens identitet och
adress/e-post, avsändarens tryckta uppgifter och betalningsinstruktioner, relevanta
avtals-/fastighetsuppgifter, mall-/renderingsversion, samt fullständig charge-
och kontrollmängd hämtad av servern. En anropares delmängd får inte bli facit.

Logotypens lagringsnyckel är inte en innehållsversion. Renderingsresurser måste
vara innehållsadresserade eller inkluderas som frysta byte. Detsamma gäller
slutlig PDF och mejlets faktiska innehåll: ett DB-snapshot bevisar inte på egen
hand vilka byte en senare worker skickar. 2a kan bära ett versionsmärkt manifest
och innehållsdigester, men får inte intyga byte som ännu inte framställts eller
verifierats. Exakt bindning från detta kontrakt till färdig artefakt är 2b:s
ansvar före start, inklusive verifiering av att inga rader eller resurser bytts.

2b behöver kunna spara outboxavsikt i samma transaktion som beslutet och senare
använda exakt beslut/utskicks-ID. Dess worker måste skilja en vunnen start från
idempotent återläsning och samordna innehållsskrivare över leverantörsgränsen.
2a:s interna transaktionskontrakt ska tillåta detta utan att skapa en outbox
eller utföra nätverksanrop. En SENDING-rad här spärrar bara modellens egna nya
operationer; befintliga utskicks- och ändringsflöden skyddas ännu inte.

## Vad modellen avsiktligt inte uttrycker — och varför

- PROVIDER_ACCEPTED betyder inte mottagarleverans, läsning, juridisk delgivning
  eller att dokumentets sakuppgifter är sanna. Sådana bevis saknas här.
- Äldre SENT, sentAt, Bull-jobbstatus och statisk invoice-send-nyckel blir inte
  retroaktivt ett beslut, en mänsklig attest eller ett leverantörskvitto.
- Frånvaro av beslutsrad betyder inte godkänt eller säkert oskickat. Övertagande
  av gamla jobb, tillförlitlig korrelation och dokumentgrund måste lösas före
  samordnad inkoppling i 2c; kvitto-/utredningsförmågan hör till 2b.
- Ingen timeout avgör UNKNOWN. Om leverantören inte kan ge ett avgörande
  positivt eller negativt bevis måste osäkerheten och blockeringen stå kvar.
- Inga garantier ges ännu för portal, nedladdning, påminnelser, export eller
  andra publiceringsvägar. Deras omfattning och samordning skjuts till 2c.
- Rättelser, betalning, bokföringsändringar och reconciliation ingår inte.
- Historisk förklaring till saknad outbox och fakturakorrelation:
  **INGEN DOKUMENTERAD ORSAK**. Ingen ny historisk förklaring har antagits.

Detta kontrakt stänger inte utskicksluckan. Hela skyddet kräver senare delar
och samordnad leverans. #877 förblir fryst; ingen merge eller driftsättning.

## Uppdaterad budget efter sparad tillståndstabell — STOPP

Tabellen ovan sparades först, granskades av tre separata läsgranskare och
preciserades därefter. Ingen schema-, SQL- eller produktionsändring gjordes
under denna prövning. **Den minsta läsbara implementation jag nu kan planera
för passerar cirka 400 produktionsrader. Därför stoppas implementationen.**

Detta ersätter förinventeringens preliminära 250–350-radersuppskattning för 2a.
Den sparade förinventeringen lämnade SENDING/UNKNOWN-exekvering till 2b. Den
aktuella ordern kräver att redan 2a kan pröva beständiga övergångar, bevis,
omsändning och osäkert utfall i PostgreSQL. Ingen av dessa delar kan tas bort
för att hålla det tidigare estimatet.

| Nödvändigt ansvar, efter återbruk av befintlig charge-grind | Tillagda | Borttagna |
| --- | ---: | ---: |
| Prisma: dokumentgrund/originalposition, beslut, charge-bindningar, övergångar, enums och relationer | 90–110 | 0 |
| SQL: motsvarande tabeller, icke-null identiteter, organisationsbindningar, index och FK | 100–135 | 0 |
| SQL: oföränderlig historik, förseglad bindningsmängd, exklusiv reservation och giltig projektion/övergång | 70–95 | 0 |
| Serverhämtad kanonisk domänsnapshot, hela charge-mängden och konkreta aktuella check-identiteter | 75–100 | 0 |
| Intern registrering/beslut, aktörs- och beviskontrakt, kommandokonflikter, återläsning och övergångsmetoder | 125–170 | 0 |
| **Summa, tillagda PLUS borttagna** | **460–610** | **0** |

Det är en funktionsbaserad planeringsuppskattning, inte uppmätt kod och inte
ett matematiskt bevis att varje tänkbar implementation kräver samma antal
rader. Den räknar inga befintliga charge-grindrader som nya, ingen outbox,
renderer, leverantörsadapter, inkoppling, bred skrivspärr eller rättelseväg.
SQL-reglerna gäller enbart de nya tabellernas egen integritet.
Typer, tabeller och metoder ska hållas läsbara; flera operationer på samma rad
eller dold produktionslogik i testfiler är inte en budgetåtgärd.

Separata granskare gav **405–555** (tillstånd/omsändning, trolig nivå cirka
470) respektive **555–725** (säkerhet/samtidighet). Skillnaden gäller främst
hur dokumentgrund och DB-skydd för projektion/medlemskap kan delas och återbrukas.
De är inte överens om antalet, men båda avråder från ett löfte om högst 400
för hela kontraktet. Säkerhetsgranskarens tidigare lägre estimat räknade en
förenkling utan tillåten omsändning; den har uttryckligen förkastats.

Tester uppskattas separat till 450–700 rader för DB-fixturer, nedanstående
beteenden och städning. Dokumentationen räknas som faktisk diff vid leverans.
Inga test-/dokumentationsrader ingår i produktionsbudgeten ovan.

## Föreslagen uppdelning inom 2a — inte påbörjad

1. **2a.1: beständig struktur och integritet.** Dokumentgrund/originalposition,
   oföränderliga beslut, charge/check-bindningar och historik; SQL-spärrar och
   direkta DB-integritetsprov. Ingen anropbar godkännandeväg. Egen budgetprövning
   kring 260–340 produktionsrader före bygge.
2. **2a.2: snapshot, interna beslut och övergångar.** Serverhämtat underlag,
   registrerings-/aktörskontrakt, A–D, idempotens, återkallelse och beständiga
   försöksutfall, med hela den riktiga DB-specen. Egen budgetprövning kring
   220–300 produktionsrader före bygge, inklusive eventuella strukturjusteringar.

Uppdelningen flyttar inga av de beställda garantierna till 2b. Hela 2a är
färdig först när båda delarna prövats tillsammans. Båda förblir inaktiva.
De två intervallen är nya planeringsförslag med överlappande integrationsarbete,
inte godkända tak. Ingen av delarna påbörjas utan ägarens nästa besked.

## Oberoende provfacit för fortsatt 2a

Alla rader nedan är **ej körda**. En spec ska anropa verkliga interna metoder
mot en egen tom PostgreSQL-databas och hävda konkreta utfall/radantal, utan att
importera produktionsmappningen som förväntat svar.

| Prov | Oberoende förväntan |
| --- | --- |
| A och återläsning efter ny tjänsteinstans | Ett ORIGINAL-beslut och utskick; exakt återläsning ger samma ID:n och oförändrade radantal. |
| B efter originalacceptans | Nytt ORIGINAL avvisas; ny version, mottagare eller nyckel ändrar inte detta. |
| C, två efterföljande legitima omsändningar | Efter klarlagda föregående acceptanser ger två nya avsikter två egna INVOICE_RESEND-beslut/identiteter; återläsning ger inga fler. |
| D och kraschbeständighet | SENDING kvar efter bortkoppling/ny klient; UNKNOWN kvar efter omstart och blockerar både ORIGINAL och INVOICE_RESEND med nya nycklar/versioner. |
| Samtidiga original med olika nycklar | Två anslutningar möts vid samma barriär; exakt en vinner, den andra får ett definierat blockeringsutfall. |
| Samtidig återkallelse och start | Endast en vinner; ingen REVOKED kan startas och ingen SENDING kan återkallas. |
| Samma nyckel, ändrat kommando | Ändrat dokument, mottagare, snapshot, kontroll eller operation ger KEY_CONFLICT och noll nya rader. |
| Samma kommando, ändrade aktuella DB-rader | Historisk återläsning av samma beslut; ingen ny auktorisering. Start med inaktuellt underlag nekas. |
| Fel organisation och koppling | Två verkliga org-fixturer med existerande dokument/charges/checks; även en felkoppling inom samma org nekas. Slumpmässigt saknat UUID räcker inte som organisationsprov. |
| Flera charges | Alla dokumentets charges måste ingå och peka på rätt aktuella checks; två legitima charges tillåts, utelämnad/extra/felkopplad medlem nekas. |
| Förseglad historik | Direkt SQL får inte byta beslut, lägga till senare charge-medlem, radera nyckel/historik eller skriva status utan giltig händelse. |
| Återkallelse/bekräftat fel följt av nytt beslut | Uttryckligt nytt beslut tillåts inom oförbrukad originalposition, historiken finns kvar; gamla nyckeln återläser det gamla avslutade beslutet. |
| Otillåtna övergångar och osäkert bevis | UNKNOWN → DECIDED, REVOKED → SENDING, ACCEPTED → FAILED och timeout som negativt slutbevis nekas utan skrivning. |
| Rollback | Framkallat fel efter första skrivningen rullar tillbaka beslut, medlemskap, reservation och händelse tillsammans. |
| Verklig inaktivitet | Migreringen ändrar inga gamla triggers/flöden och inga nya metoder nås från appmoduler/producenter. Ingen kö-/leverantörsadapter startas. |

Fixturer ska skapas av riggen och raderas i FK-ordning utan att stänga av
integritetsregler. Om strikt historikbevarande kräver rollback-fixturer ska
det väljas uttryckligt; det får inte bli ett undantag i produktionsspärren.
Två kompletta körningar ska redovisa samma radantal före/efter över alla
berörda tabeller, inklusive nya historik-/medlemstabeller. Races behöver
committade delade fixturer och därför en prövad städstrategi som respekterar
historikspärren; den frågan kvarstår före implementation.

Negativkontrollen ska efter fungerande commit tillfälligt koppla förbi en
namngiven relevant spärr och ge rött på förväntat beteende, inte kompilering.
Endast egna namngivna filer återställs från noterad commit, sedan grönt igen.
Förbikopplingen får aldrig pushas. Ingen negativkontroll har nu utförts.

CI-förebilden är kontrollerad i `apps/api/jest.config.ts:7` och
`.github/workflows/ci.yml:129`, `:141`, `:147`: migrationer, hela API-sviten och
Jest-rapport finns, men den explicita kontrollen söker endast
`consumption/charge-gate.db.spec.ts`. En framtida utskicks-spec behöver verifierad
upptäckt och en kontroll av faktiskt genomförda gröna assertions i samma HEAD:s
CI-rapport. Befintlig CI-konfiguration är inget bevis för nya utskicksprov.

## Granskarfynd och kvarstående frågor

Tre separata läsgranskare användes: tillstånd/omsändning, säkerhet/samtidighet
och oberoende testfacit/CI. Ingen av dem ändrade filer eller körde tester.

- Tillstånd: DECIDED ingår nu uttryckligen i konkurrensspärren. Reservationens
  frigörande har skilts från permanent originalposition och gamla nycklar.
- Säkerhet: full medlemsmängd måste förseglas även mot senare INSERT. Aktuell
  kontrollmetod returnerar charge, inte hela check-identiteten; det är räknat
  som eget arbete. Oföränderliga beslut får inte få ett senare artefaktbevis
  genom omskrivning; det behöver separat spårbar bindning i 2b.
- Tester: två efterföljande omsändningar, verkliga korsorganisationsfixturer,
  identisk historisk återläsning och faktisk CI-körning har gjorts uttryckliga.
- Kvar: exakt intern registreringsprimitiv för kontrollerat oskickat dokument,
  fysisk form för originalposition/projektion och fixturestädning som går ihop
  med strikt historikbevarande. Dessa är inte lösta genom tabellens prosa.
- Kvar i 2b: verifierad bindning till verkliga artefaktbyte, betrodda
  leverantörsbevis, mänsklig upplösning av UNKNOWN och exekveringssamordning.
  2a ska fortfarande bära interna bevis-/övergångskontrakt och DB-prov.
- Kvar i 2c: faktisk övergång från gamla jobb, samordnad inkoppling och övriga
  överenskomna utlämningsvägar. Tystnad ger inget godkännande.

## Vad som faktiskt gjorts vid stoppet

**Produktion: 0 tillagda + 0 borttagna rader. Tester: 0 + 0. Migrationer: 0 nya
eller ändrade; totalt fortsatt 187 migrationsfiler.** Endast detta dokument
har lagts till i denna omgång. Förinventeringen från c0424932 är oförändrad.

Ingen ny testdatabas skapad och ingen befintlig databas läst eller ändrad.
De två DB-körningarna, radantalen, omstartsproven, negativkontrollen och ny
DB-spec i CI är **inte utförda**, eftersom budgetstoppet kom före implementation.
Ingen lokal Jest/typecheck har startats; hela sviten hör till CI enligt ordern.
En grön CI för dokumentationsutkastet kan endast verifiera befintlig kod.

Ett eventuellt utkast för denna gren ska heta och beskrivas som tillståndskontrakt
och budgetstopp, aldrig som färdig 2a. Exakt leverans-HEAD, PR-länk och uppmätt
CI för den HEAD:n anges i slutrapporten och PR-beskrivningen; ingen äldre grön
körning används som bevis. Ingen merge, driftsättning, 2b, 2c eller rättelseväg.
