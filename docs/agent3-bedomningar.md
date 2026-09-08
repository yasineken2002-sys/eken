# Agent 3: beständiga mänskliga bedömningar

Fortsättning på #860. En behörig människa kan nu välja Behöver utredas,
Avvikelsen bekräftad eller Förklarad avvikelse och ange en motivering.
Bedömningen ändrar inga avläsningar, förbrukningsposter, fakturor eller verifikat.
Den är inte en instruktion till en agent att utföra något.

## Beständighet och samtidighet

`MeterReadingReview` sparar en ny revision per avläsning/varningskod. Tidigare
revisioner skrivs aldrig om; en BEFORE UPDATE-trigger spärrar även direkt SQL.
Varje rad bär serverns regelversion, fingerprint, underlag, tidpunkt samt aktörens
id och namn från organisationens aktiva användare. Kommentarer loggas inte av
den nya koden. Historiken kan läsas även när den aktuella varningen försvunnit.

POST `/consumption/reading-review/decisions` kräver MANAGER, ADMIN eller OWNER.
Tjänsten kontrollerar rollen på nytt i databasen. VIEWER och ACCOUNTANT får läsa.
Servern räknar fram aktuell varning i organisationen och jämför fingerprint och
senaste revisionen med det formuläret utgick från. Klienten får inte skicka aktör,
tidpunkt eller eget underlag. Kroppen binds till ett delat Zod-schema/DTO.

Kontroll och INSERT sker i en serialiserbar transaktion. En unik nyckel över
organisation, avläsning, varningskod och revision skyddar även två samtidiga
första beslut. P2002/P2034 och ändrat underlag/revision ger 409; användaren behöver
läsa om. Ingen automatisk omskrivning eller omförsök med ny revision sker.

Org-bindningen finns även i en sammansatt FK till MeterReading. DELETE tillåts
för befintlig organisationsstädning och kaskaderar från organisation/avläsning.
Aktörens id/namn är en historisk kopia, ingen SET NULL-relation som skulle kräva
att en tidigare rad skrivs om. Ingen ny raderingsendpoint införs.

## Webb

Varje varning visar senaste bedömningen endast om dess fingerprint gäller
aktuellt underlag. Annars visas att underlaget behöver bedömas på nytt.
Formuläret behåller motiveringen vid sparfel och blockerar sparande när en
bakgrundsuppdatering gör formuläret gammalt. Läs om-knappen stänger formuläret;
texten finns kvar fram till det uttryckliga valet. Framgång invaliderar rapporten.
Historik med namn, tid, motivering och dåvarande underlag finns även utan aktuell
varning. Att öppna eller avbryta formuläret sparar ingenting.

## Validering

Lokalt: 741 Jest-prov i sju relevanta sviter och 48 webbprov. Shared-bygge,
API-/webbtypkontroll och schemavalidering gröna. SQL jämförd med Prismschema-diffen.
Request-contract: 96 bundna typer, 6 kända överträdelser, inga nya/stale;
DTO-placering 0, strikt koercion 0 oskyddade, append-only 14/14, aktörsvakt grön.
Behörighetsytan ökar 218 → 219 med exakt den nya sparrutten.

Chrome: formulär → exakt en POST → omläsning → historik, med konstruerade
API-svar. Rätt fingerprint/revision, inga klientstyrda aktörsfält, inga
JavaScript-fel eller horisontell överströmning vid 390 px. Formulär och historik
visuellt kontrollerade på mobil och dator.

`reading-review-decisions.db.spec.ts` provar mot riktig Postgres: sparande efter
ny tjänsteinstans, samtidighet, organisationsisolering, sammansatt FK,
UPDATE-spärr, ändrat underlag, historik samt raderingskaskad. Den kräver DB och
körs i CI, inte mot någon lokal eller produktionsdatabas i detta bygge.

HTTP-proven ersätter JWT-identiteten och Prisma; POST-kopplingsproven ersätter
själva sparmetoden. Tjänsteproven kontrollerar sparlogiken, DB-proven transaktionen
på riktigt. Webbens webbläsarprov använder konstruerade API-svar.

## Granskning och kvarvarande arbete

Migreringen är additiv och ska följa API-driftsättningen. Granska #860 före denna
PR, rikta om mot main och kräv ny grön CI. Ingen merge eller driftsättning görs
av Codex. Ingen agentflagga aktiveras.

Detta ger facitunderlag men mäter inte sann träffsäkerhet: bedömningen kan påverkas
av den visade varningen. Verkligt, oberoende granskat jämförelsematerial och
agentens vidare uppföljning återstår. Listan hämtar fortfarande hela historiken;
större volymer kräver en separat genomtänkt sidindelning utan att klippa underlag.
