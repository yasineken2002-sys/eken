# Oberoende läsande AI-granskningar för Claude

Fyra faktiska Codex-underagenter, **GPT-6 Astra / xhigh**, läste samma frysta
commit `61e6df3768e1f7f338fd10af3c3fcd021312bc1d`, bas #872
`e4a72d3002c195e78c01baac4704a7326973547e`. De läste med `git show` och gav
självständiga slutsatser utan att se varandras svar. Högst två granskare var
aktiva samtidigt. Ingen av dem ändrade filer, skrev databaser, körde tester,
skickade externa meddelanden eller anropade modell-/bank-API:er.

| Separat granskare | Rolltexter som ämnesbakgrund | Självständig slutsats på fryst commit |
| --- | --- | --- |
| `granskning_sakerhet` | `security-auditor.md` | Ett ändrat serverintyg kunde lämna den gamla personens länk giltig; ingen direkt publik intygsändringsväg hittades |
| `granskning_pengar` | `bokforings-expert.md` | Inget identifierat blockerande fel i betalningsaritmetik/transaktion; omräkningen kontrollerade inte hela behörighets-/organisationskedjan eller den historiska slutkrediten |
| `granskning_kod_matt` | `code-reviewer.md`, `ai-architect.md` | Samma auditlucka, en timeouttråd som kunde dö permanent och avböjande som kunde stoppas av ett övergivet felaktigt belopp |
| `granskning_kundbekraftelse` | `hyresjurist.md` | Fritextinvändning kunde ignoreras vid bekräftelse; språk om egen betalning/överskott kunde överdriva beskedet; återbetalningsrätt och framtida tillgodoanvändning återstår |

Alla är AI-granskare utan påstådda personliga anställningar, yrkesmeriter
eller certifieringar. Rolltexternas Claude-model/tools gav inga nya
verktygsbehörigheter. Hårdkodade kunskapsreferenser löstes relativt aktuell
worktree. Saknad `mervardesskattelagen.md` användes inte som underlag.
Påstådd rollhierarki respektive exakt rollmatchning och äldre
OCR-/tenant-/FIFO-resonemang fick inte övertrumfa koden eller experimentets
uttryckliga policy. Ingen rolldefinition behövde skapas eller ändras.

## Fynd, bevis och ansvarig agents bedömning

Raderna nedan avser **den frysta granskningscommitten**, inte slutversionens
förskjutna radnummer. Granskarnas kodfynd var statiskt belagda; de körde
inte angreppen. Ansvarig byggagent gjorde korrigeringarna och körde proven.
Extra negativa förväntningar frystes i `0aef9898` före motsvarande nya prov.

| Fynd och exakt fryst plats | Konkret scenario | Tillämpning/efterkontroll |
| --- | --- | --- |
| S1: `kundklarlaggning.sql:47,122`, `kundklarlaggning.py:213` | Byt Alice-intygets person/hyresgäst till Bob efter skapad länk; Alice kunde fortsatt se bankdatum/belopp och avböja | **Accepterat.** Hela intyget fryses i inbjudan. Fångst, kundvy, mailbox och svar jämför snapshot/person. Verkliga PG-negativprov byter person, tenant och avtalslista; inga pengar påverkas |
| P1/K1: `audit_kundklarlaggning.py:45,75` | Ta bort intygets tillåtna avtal, byt kundregister eller verifikationens organisation i rapporten | **Accepterat.** Omräkningen binder person, tenant, avtal, giltighet, inbjudan, audit, verifikation och operation. Nya negativa mutationer avvisas. Detta stärker beviset; det var inte ett påvisat felaktigt originalbeslut |
| P2: `eval_kundklarlaggning.py:40` och auditfunktionen | Sätt historiskt utestående tillgodo till noll utan utslag | **Accepterat.** Hela historikobjektet jämförs med fryst policy; särskild mutation döljer slutkrediten och måste avvisas |
| K2: `demo_kundklarlaggning.py:153` | Tillfälligt databasfel avslutar timeouttråden; återhämtad DB lämnar ärenden väntande | **Accepterat.** Generisk lokal hälsostatus och återförsök nästa intervall. Fel i transportanropet injiceras; nästa tick gör riktig PG-timeout. Det är inte ett prov av faktisk anslutningsutmattning |
| K3: `kundklarlaggning_demo/app.js:31` | Skriv `1.5` öre, välj sedan ”Betalningen är inte min”; inget avböjande skickades | **Accepterat.** Avböjande skapar tom fördelning. Den faktiska app.js-funktionen körs med en liten simulerad DOM; HTTP/PG kontrollerar avböjandet. Ingen webbläsarrendering påstås |
| J1: `kundklarlaggning_demo/app.js:32`, `kundklarlaggning.sql:131` | Bekräfta egen avi men skriv att mamman avsåg broderns hyra | **Accepterat.** Varje icke tom kommentar ger `STAFF_CUSTOMER_NOTE` och ingen allokering. Ingen AI tolkar kommentaren som behörighetsbevis; en möjlig invändning får inte försvinna |
| J2: `kundklarlaggning_demo/app.js:22` | ”Din betalning”/”styrkt överskott” kan läsas som avgjord äganderätt | **Accepterat som språkförbättring.** Frågan gäller kundens instruktion och överskottet benämns enligt testantagandet. Simulering visas fortsatt tydligt |

Inget konkret reproducerbart prototypfynd avvisades. Förslag om verklig
autentisering, bevisleverantör, produktionsroller och full ekonomisk/juridisk
hantering är kvarvarande produktionskrav och implementerades inte här.
Prioritetsskillnaden P1/P2 mellan två granskare för samma auditlucka ändrade
inte åtgärden: den rättades innan publicering av provresultatet.

## Kundbekräftelsens rättsliga gräns — smal källkontroll

Officiella primärkällor lästes 2026-09-09 av juridikgranskaren och
kontrollerades också av ansvarig agent. Ingen juridisk slutcertifiering eller
bedömning av verkliga kundavtal görs.

Kundsvaret dokumenterar en instruktion; i denna demo är även personen
simulerad. Vid företrädarskap spelar fullmaktens omfattning och kända
befogenhetsbegränsningar roll. Därför måste en uppgift om att anhörigbetalaren
avsett någon annans skuld utredas, även om kunden klickat på bekräfta.
[Avtalslagen 10–11 §§](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-1915218-om-avtal-och-andra-rattshandlingar_sfs-1915-218/).
Det är en försiktig produktbedömning, inte ett påstående om att varje
anhörigbetalning rättsligt kräver samma tekniska bevispaket.

Domstolens bevisvärdering sker utifrån omständigheterna. Vår slutsats är att
ett demoklick inte kan ges generell bevisverkan om rätten till pengarna.
[Rättegångsbalken 35 kap. 1 §](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/rattegangsbalk-1942740_sfs-1942-740framtagen/).
Den verkliga oberoende källan för betalning–behörig person–avi återstår att
fastställa; ingen källa är verifierad för originalens 20 fall.

Återkravsfrågor beror bland annat på betalningens rättsgrund och
omständigheterna; se HD:s resonemang i
[T 409-22, 2023-04-12, punkterna 18–19](https://www.domstol.se/globalassets/filer/domstol/hogstadomstolen/avgoranden/2023/t-409-22.pdf).
Avgörandet gäller ett annat sakförhållande och är inte en färdig policy för
denna prototyp. Att registrera ”tillgodo” avgör inte berättigad
återbetalningsmottagare, en anhörigs eventuella anspråk eller tillåtelse till
framtida användning. Dessa frågor lämnas uttryckligen öppna.

Slutversionens dynamiska verifiering och källhashar finns i
[huvudrapporten](agent2-kundklarlaggning.md) och dess körunderlag. De fyra
självständiga utlåtandena gäller den frysta granskningscommitten; ansvarig
agent har verifierat rättelserna med nya prov. Claude ska fortfarande granska
slutlig diff och besluta om eventuell merge. Inget har mergats.
