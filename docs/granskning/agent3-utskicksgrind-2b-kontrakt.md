# PR 2b — exekveringskontrakt före implementation

Datum: 2026-09-11. Bas: `0973272d5eb8f6f8285ec8c98f039a47f6ec568b` (#878).
**Designunderlag vid budgetstopp. Ingenting nedan är implementerat i 2b.**
Se [omfattningsbedömningen](agent3-utskicksgrind-2b-omfattning.md) och
[det oberoende facit](agent3-utskicksgrind-2b-facit.md).

## Gemensam auktoritet och identitet

2a:s DeliveryDocument, DeliveryDecision, DeliveryMember och DeliveryEvent
behålls. Senaste eventrevision är enda affärstillståndet. Outboxens
transportobservationer, artefaktbindningar och konfliktobservationer får inte
bli en andra tillståndsmaskin. Ingen ny originalposition införs.

Dokumentroten är organisation + kontrollerat skapat dokument. Beslutets UUID
är utskicks-ID och används även vid återpublicering. SENDING-eventets UUID
är försöks-ID. En avsiktlig fakturaomsändning har eget beslut, utskicks-ID och
försök samt referens till accepterat original. En ny kommandonyckel ger inte
rätt att kringgå SENDING/UNKNOWN eller att skicka ett andra original.

## Transaktionsgränser och återstart

| Steg | Beständigt före steget | Arbete och commitgräns | Återstart och identitet |
| --- | --- | --- | --- |
| Beslut och outbox | Kontrollerad dokumentrot och aktuellt behörigt underlag | Ägd READ COMMITTED-transaktion tar 2a:s organisationslås; kör `decide(command, tx)` och skriver unik organisations-/dokumentbunden outboxavsikt för samma beslut. `checkConstraints(tx)` körs efter ALLA skrivningar. | Fel ger hel rollback. Samma kommando återläser samma beslut och outbox; ändrad innebörd ger konflikt. Ocommittat resultat är preliminärt. |
| Transportpublicering | Committat beslut och outboxavsikt | Publicerare läser DB och publicerar endast beständig utskicksidentitet. Köeffekt sker efter commit. Publiceringsobservation sparas efter transporten. | Krasch före publicering lämnar avsikten kvar. Krasch efter publicering före lokal observation får ge dubbel köleverans med samma identitet. Redis-retention får inte definiera slutstatus; återstart måste kunna återpublicera obesvarad avsikt även om äldre publicering noterats. |
| Artefaktframställning | Committat beslut med fryst snapshot | Betrodd framställare använder endast beslutets frysta data och frysta renderingsresurser. Faktiska PDF-/mejlbyte och manifest binds oföränderligt till beslutet i en egen kort transaktion med slutkontroll. | Ofärdig framställning får återförsökas före start med samma utskicks-ID. En befintlig förseglad artefakt återanvänds; den skrivs inte över med ny rendering. |
| Leveransstart | Beslut, outbox och verifierbar förseglad artefakt | En ägd starttransaktion låser, återläser aktuellt beslut och underlag, verifierar artefakt och registrerar SENDING/försöks-ID. Exekveraren får sin engångsrätt först efter lyckad commit. | Konkurrent eller replay får aldrig engångsrätt. Om commitutfallet är okänt görs inget anrop; DB återläses utan att återskapa startbehörighet. |
| Leverantörsanrop | Committad SENDING för exakt försök och artefakt | Endast exekveringsprocessen som vann starten får anropa den kontrollerade leverantörsgränsen en gång. Ingen DB-transaktion hålls över nätanropet. | Alla automatiska nätverksretries måste vara avstängda även i adaptern. Processförlust efter SENDING ger inte rätt till ersättningssändning. |
| Utfall | SENDING eller UNKNOWN för samma försök | Korrelerad acceptans eller definitivt avslag sparas i ny transaktion enligt 2a:s evidenskontrakt. Observation, leverantör och referens bevaras. | Förlorat svar eller misslyckad lokal kvittolagring lämnar SENDING/UNKNOWN. Lokal lagring av samma bevis kan återförsökas; själva anropet får inte upprepas. Efter UNKNOWN krävs mänsklig utredning för slutövergång. |

En starttransaktion måste äga både artefaktverifiering och övergång. Den får
inte behandla `transition(command, tx)` som ett verkställighetstillstånd:
2a ger uttryckligen `startGranted: false` för övertagen transaktion. Den nya
ägda exekveringsmetoden måste utöka samma kontrakt utan en parallell maskin.

## Artefaktens beviskedja

Renderingsresursernas verkliga byte/digester måste bindas beständigt före
eller i beslut/outbox-commiten och ingå i beslutskommandots jämförda
innebörd. Att först efter beslutet läsa logoStorageKey och frysa de då
aktuella byten är otillräckligt: resursen kan ha bytts i mellanrummet.
2a:s nuvarande kommando saknar denna resursbindning. Dess konkreta utökning
och hur infrysningen verifieras är OLÖST vid stoppet; inget färdigt
beslutsbevis över resursbyte påstås här.

Manifestet behöver en entydig versionsmärkt representation som binder:
organisation, dokument, beslut/utskicks-ID, beslutets fingerprint,
mottagaridentitet och exakt adress, avsändare, ämne, text-/HTML-innehåll,
bilagornas namn/mediatyper och exakta byte samt renderer-/resursidentitet.
Digest beräknas över de verkliga byten och manifestet. Data som lämnas till
leverantörsgränsen ska läsas tillbaka och jämföras mot den förseglade
bindningen. Samma lagringsnyckel med nya byte ska ge avslag.

Två olika bevis behövs: att en betrodd framställare använde den beslutade
snapshoten, och att samma framställda byte används vid leveransen. En hash
över godtyckliga uppladdade byte styrker bara det senare. `updatedAt`,
`pdfKey`, logotypnyckel eller ett digestsvar från samma obetrodda indata räcker
inte för hela kedjan. Ändrat underlag får aldrig utlösa tyst omrendering.

Fakturarenderaren läser i dag aktuell DB och logotyp
(`apps/api/src/invoices/pdf.service.ts:135`, `:155`); avirenderaren hämtar också
logotyp via nyckel (`apps/api/src/avisering/avisering.service.ts:1048`). De är
inte färdiga adaptrar för frysta resurser. Verklig framställning från fryst
underlag återstår och får inte döljas som bevisad av syntetiska PDF-byte.

## Ändringsordning och beständig spärr

Inom den nya inaktiva mekanismen behöver varje relevant skrivning äga en
transaktion, ta samma organisationslås och läsa senaste beständiga tillstånd
EFTER låset. Skrivsamordnaren måste neka ändringar under SENDING/UNKNOWN.
En konservativ spärr för relevant underlag i hela organisationen är möjlig,
men dess bredare påverkan ska beskrivas och provas.

Om ändringen committar först ska starten se ändringen och spara en beständig
konfliktobservation med beslut, gammal/aktuell fingerprint och konkret skäl.
Ingen starthändelse eller leverantörseffekt får uppstå. Konfliktspåret måste
committas utan att följa med i den misslyckade starttransaktionens rollback.
Beslutet ersätts inte och originalpositionen flyttas inte.

Om starten committar först ska en ny skrivare se SENDING och nekas även om
startarens DB-anslutning sedan försvinner medan leverantörsanropet fortgår.
Efter återstart gäller samma spärr på SENDING/UNKNOWN. Därmed är inte det
tillfälliga DB-låset det enda skyddet.

Detta gäller deltagande nya skrivare. Äldre produktionsskrivare använder inte
primitiven och skyddas inte av ett sådant prov. Ingen gammal väg eller trigger
på gamla underlagstabeller kopplas om i denna order. Samordnad inkoppling
måste senare verifiera hela skrivmängden innan skydd kan hävdas i drift.

## Workers, behörighet och det sista anropsfönstret

Beslut, återkallelse och slutlig utredning av UNKNOWN ska fortsatt kräva en
behörig människa. Exekvering behöver en separat organisationsbunden
tjänsteprincipal med snäva rättigheter: verifiera befintligt beslut, starta
det en gång och rapportera tillåtna utfall. Jobbets payload får inte välja
principal eller skapa ett nytt godkännande. Beslutsfattarens User-ID får inte
användas som om människan själv körde workern.

2a kräver User i både `DeliveryDecisions.authorize` och SQL:s eventtrigger.
En ny migration och motsvarande typ-/auktoriseringsändring måste därför
bevara övergångsreglerna och skilja tjänst från människa. Den betrodda
processidentitetens konkreta autentisering och DB-bindning är ännu inte
implementerad eller verifierad. Ett fritt `actorKind: SYSTEM` är inte en
lösning. Detta är inkluderat i budgeten som arbete, inte ett befintligt skydd.

Gamla omlevererade jobb och workers som ännu inte vunnit start kan stoppas
av den beständiga engångsreservationen. En gammal VINNARE som pausats efter
sista DB-kontrollen men före nätanrop är ett annat fall: ingen senare
DB-flagga återkallar i sig kodens redan erhållna sändförmåga.

Kontraktet får därför inte lova att UNKNOWN, ett generationsnummer eller
utgången lease stoppar ett redan auktoriserat externt anrop. Ingen annan
worker får ta över sändningen, och skrivspärren måste kvarstå. Innan negativ
slutlighet frigör reservationen krävs även positivt belägg att gammal
sändförmåga har upphört, alternativt verklig leverantörsfencing som avvisar
det gamla försöket. Hur detta garanteras i drift är en öppen beroendefråga.

## Fel, slutbevis och gränser

Förberedelse-/lagrings-/transportfel före SENDING kan återförsökas med samma
beständiga identitet. Återkallelse, underlagskonflikt och byte-/identitetsfel
ska stoppa jobbet och vara spårbara; de får inte maskeras som tillfälliga
fel eller repareras med nytt godkännande i workern.

Efter SENDING är krasch före anrop, förlorat svar och förlorad lokal
kvittens alla konservativt osäkra från återstartarens perspektiv. UNKNOWN
behåller försöks-ID och reservation. Ett sent positivt svar efter UNKNOWN
kan bevaras som utredningsunderlag men inte ge tjänsten mänsklig
utredningsbehörighet. Timeout, tidspassage, Redis-tömning och avsaknad av
kvitto är inga slutbevis.

PROVIDER_ACCEPTED betyder endast leverantörsacceptans. Mottagarleverans och
läsning följer inte av detta. Verklig providers korrelation, retrybeteende,
fencing och slutliga negativa besked måste verifieras före drift. Inga
sådana aktuella garantier har kontrollerats i denna läsuppgift, och inga
riktiga utskick eller betalda externa API-anrop har gjorts.
