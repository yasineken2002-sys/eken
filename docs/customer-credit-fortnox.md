# Kundtillgodo – Fortnox-export med bundna originalkonton

Etappen bygger på `5d9f2dac`, [utkast #960](https://github.com/yasineken2002-sys/eken/pull/960),
som i sin tur bygger på kundtillgodot och aviutskicket i #959. Den levereras
som ett separat, staplat utkast. Granskningen behöver omfatta hela kedjan;
denna gren ska inte behandlas som fristående från återbetalningsdomänen.

Ändringen exporterar redan bokförda mottagningar, aviavdrag och slutligt
bokförda återbetalningar genom den befintliga Fortnox-utkorgen. Den skapar
inga nya betalningar och aktiverar ingen kundorganisation. Verifieringen
använder isolerad Postgres, syntetisk bank och MockFortnox. Inga verkliga
banköverföringar eller Fortnox-skrivningar ingår i detta arbete.

## Egen kontoroll och uttryckliga val

`KUNDTILLGODOSKULD` är en egen roll i delat Zod-schema, Prisma, klassning och
kontomappningens webbvy. Den använder `EJ_TILLAMPLIG` som momsbehandling och
skuldkontoklassen 2300–2999. Den återanvänder inte depositionsrollen.

Det finns inget förvalt lokalt konto eller Fortnox-målkonto för rollen.
Tillgodots lokala skuldkonto kommer från den uttryckliga domänpolicyn.
Första mottagningens Fortnox-skuldkonto kräver en godkänd mappning i rätt
företag, anslutningsgeneration och räkenskapsår. Befintliga krav på
godkänd revision, faktureringsmetod, serie och dimensionsbeslut kvarstår.
Migrationen tillför rollen; den fyller inte i konton eller aktiveringspolicy.

## Vilka original styr varje händelse?

| Händelse                  | Bokföring som får exporteras            | Varifrån Fortnox-målet hämtas                                                                                                                      |
| ------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mottagning (`RECEIPT`)    | Debet bank, kredit tillgodoskuld        | Bankmålet från källbetalningens bekräftade export. Det nya skuldmålet från uttryckligt godkänd mappning.                                           |
| Aviavdrag (`APPLICATION`) | Debet tillgodoskuld, kredit kundfordran | Skuldmålet från mottagningens bekräftade export. Fordransmålet från målaviens bekräftade intäkts-/fordransverifikat.                               |
| Återbetalning (`REFUND`)  | Debet tillgodoskuld, kredit bank        | Båda målen från mottagningens bekräftade export. Återbetalningen måste vara `SETTLED` och ha exakt kopplat verifikat och giltigt sparat bankbevis. |

Originalen måste vara `CONFIRMED` i samma organisation och Fortnox-företag:
både databasnummer och organisationsnummer prövas. Ett annat företag,
saknat original, okänt utfall eller en obekräftad export ger stopp.
Ett senare byte av kontomappning flyttar inte en redan uppkommen skuld
eller dess bankbelopp till ett annat mål.

Varje tillgodorad bevarar också mappningsrevisionens identitet, nummer och
innehållshash. Ett avdrag kan därför ha en äldre revision för skulden och
en nyare för målaviens fordran. Återläsningen visar radens verkliga revision;
saknat eller motstridigt underlag ger okänd revision. Toppnivåns revision
anger det aktuella godkännandekravet, inte alla raders ursprung. Äldre vanliga
exporter behåller sin tidigare gemensamma revisionsproveniens.

Klassningen härleder radidentiteter från domänens faktiska relationer,
källhash, betalningsallokeringar och levande verifikat. Ett `sourceId`-prefix
räcker inte. En betalningsrad med `CUSTOMER_CREDIT` kan inte maskeras som
en vanlig bankbetalning genom den äldre betalningsexporten.

Originalets bankbelopp kan vara större än tillgodot, och ett senare avdrag
eller en återbetalning kan använda en del av tillgodot. Varje belopp
kontrolleras mot sin egen domänhändelse och journal. Kontobindningen kräver
inte felaktigt att exempelvis 100 kr mottaget, 60 kr avdrag och 40 kr
återbetalning har samma belopp.

## Sparat bevis och återkontroll före sändning

`fortnox-customer-credit-evidence.ts` förenar fyra underlag för varje
originalrad: den verkliga journalraden, Fortnox-payloaden, radproveniensen
och kontomappningen. Identitet, lokalt konto, målkonto, debet/kredit,
belopp, roll och kvittoidentitet måste stämma. Dimensioner eller en
rättad originaljournal accepteras inte i denna kedja.

`draft.kundtillgodo` sparar händelseidentitet, ursprungsrader, bekräftade
exportidentiteter, mål och stabila digestvärden. Det innehåller inga
mottagar- eller bankleverantörsreferenser. Bevisets digest ingår i
utkastets hash. Även den egna journalens datum, konton och råtexter binds.
JSON-objektens nyckelordning påverkar inte digesten.

Byggaren använder dessa ankare per rad. Mottagningens nya skuldrad går
fortfarande genom vanlig godkänd mappning. Momsjusteringens separata
`frystaMal`-regel ändras inte. Originalkonton hämtas ur den sparade,
redan bekräftade exporten; målkontots existens, aktivitet och momsteknik
kontrolleras färskt i den nya journalens Fortnox-år. Originalet får ligga
i ett tidigare år. Bokföringsdatum och händelsedatum behåller sina skilda
betydelser; exporten flyttar inte en ännu obokförd återbetalning till ett
öppet år eller skapar ett saknat verifikat.

För kundtillgodo sker en andra, enbart lokal återkontroll i samma
Read Committed-transaktion som anspråket `DRY_RUN_READY → SENDING`:

1. Samma avtalslås som tillgododomänen tas, sedan källbankrad, sorterade
   avier, tillgodo och eventuell återbetalning.
2. Berörda journaler, rader, konton och exporter låses. Händelsen klassas
   om och beviset läses om. Ändrat bankunderlag eller originalexport
   stoppar anspråket.
3. Anslutning, mappningsrevision, dimensionsbeslut och brytdatum prövas
   igen. Samma befintliga villkorade anspråk tas med organisation, status
   och utkastshash.

Inga token-, bank- eller Fortnox-anrop sker i transaktionen. Den externa
sändningen börjar först efter ett lyckat anspråk. Detta är en kontroll vid
anspråkstillfället, ingen garanti för atomiskt genomförande i två system.

## Okänt utfall och rättelser

Befintlig Fortnox-livscykel gäller även här. Timeout, okänt svar eller
utgången sändningslease medger ingen blind POST-retry. `UNKNOWN` kräver
avstämning. Ett kvitto ger inte `CONFIRMED` förrän både identitet och
återläst innehåll stämmer med det frysta underlaget. Endast ett bevisat
icke skickat försök får återgå direkt till förhandskontroll.

Domänens befintliga rättelsespärrar skyddar källbetalning och berörda
avier när tillgodorelationer finns. Tillgodots tre egna verifikat får
inte exporteras som generella omvända rättelser. En sammanhängande
rättelsekedja för tillgodo, avdrag och återbetalning återstår; den byggs
inte genom att kringgå dessa spärrar.

Bevisningen utgår från produktvägarnas bevarande av bekräftade exporter.
Den gamla exportens `draftHash` jämförs med `sentPayloadHash`, men räknas
inte om retroaktivt från en historisk anslutningskonfiguration som inte
finns fullständigt lagrad. Hela den sparade originaldraften binds i det
nya bevisets digest. Detta är inte ett skydd mot godtyckliga samordnade
ändringar av alla underlag genom privilegierad direkt-SQL.

## Granskningsytor och kvarstående gräns

- `fortnox-customer-credit-classification.ts`: domänkopplingar, verkliga
  verifikat och återbetalningens sparade bankbevis.
- `fortnox-customer-credit-evidence.ts`: originalexport, mål och låst
  återkontroll; `fortnox-export-builder.ts` binder dem i payload och hash.
- `fortnox-send.service.ts`: anspråket och oförändrad hantering av okänt
  utfall; `fortnox-customer-credit.db.spec.ts` prövar den sammansatta kedjan.
- Delat Fortnox-schema, kontomappning och webbvy: uttrycklig egen
  skuldkontoroll utan kontoförslag som tyst blir ett kundbeslut.

Verklig bankadapter, kundbehörigheter, kontoval, operativ avstämning och
kundaktivering behöver granskas före drift. Den här leveransen öppnar
ingen sådan aktivering och ger inga nya garantier om bankmatchning.

## Verifiering

- **181/181 API-prov i åtta riktade sviter och 9/9 webbprov i två filer.**
  [Sammanställning](./eval/customer-credit-fortnox/targeted-summary.txt).
  De två nya exportsviterna omfattar 42 prov: riktiga domäntjänster och
  Postgres, fryst exportbevis, ordningskrav, kontobyte, fel företag,
  samtidiga anspråk, okänt skrivutfall och rättelsespärrar.
- Hela den nya DB-sviten klarade dessutom **21/21 i en separat process
  med `TZ=America/Los_Angeles`**, inklusive decembermottagning följd av
  januariavdrag och senare återbetalning.
  [Zonkörning](./eval/customer-credit-fortnox/credit-fortnox-los-angeles.txt).
- Läsgranskningen fann fel revisionsspår efter kontobyte; det är rättat
  med revisionsproveniens per rad och ett prov genom faktisk återläsning.
  [42/42 efter rättelse](./eval/customer-credit-fortnox/credit-fortnox-tests-fixed.txt).
- Årsskiftestestet kunde först inte kompileras eftersom en valfri egenskap
  skickades som explicit `undefined`. Villkorlig spread rättade detta;
  produktionsvalideringen ändrades inte.
  [Första utfallet](./eval/customer-credit-fortnox/credit-fortnox-tests.txt).
- **13 relevanta vakter gröna**, bland annat transaktionsgränser, tenant-scope,
  kontrakt, nummerserier, DI, historik och append-only.
  [Vaktutdata](./eval/customer-credit-fortnox/guards.txt).
  Prisma validerat, klient genererad och enum-migrationen applicerad i
  isolerad lokal databas. ESLint och diffkontroll gröna.
- Äldre Fortnox-regressioner nådde den lokala minnesgränsen på 1,5 GB:
  först i samlad körning, därefter även separat sändningsspec. De räknas
  inte som passerade. [Samlad körning](./eval/customer-credit-fortnox/fortnox-regression-memory.txt),
  [separat körning](./eval/customer-credit-fortnox/fortnox-send-regression-memory.txt).
  Full typkontroll och hela testsviten ska verifieras av CI på PR:ens
  aktuella commit.
