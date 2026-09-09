# Återstående arbete i agentplanen

Ögonblicksbild 2026-09-09 mot #865 (`d2ca0c1a`), masterplanen och GitHubs PR-status.
#856–#865 är öppna utkast. Deras tidigare rapporterade CI är grön på respektive
angivet HEAD; de är inte mergade eller driftgodkända. Detta dokument sammanfattar
nuläget och ersätter inte masterplanens regler eller separata öppna beslut.

Masterplanen innehåller historiska statusblock som säger att agent 2–3 inte har
påbörjats. De raderna beskriver äldre commits. Utkasten och uppföljningarna nedan
måste tas med när nästa bygge väljs. Ingen ny kontroll av produktionsflaggor eller
produktionsdata har gjorts i denna genomgång.

## Vad som kan byggas vidare

| Område | Byggt eller förberett | Nästa arbete |
| --- | --- | --- |
| Agent 3: förbrukning | Läsanalys, beräkningsunderlag, API, beständiga bedömningar, kö, intern daglig uppföljning och assistentens läsverktyg (#858–#865) | Kodbundna statusfakta i chatten är nästa utkast. Falska slutsatser i modellens fria text återstår även med faktablock. Därefter oberoende granskningsmaterial och utvärdering av hela arbetssättet. |
| Agent 2: pengar in | Skuggförslag i main; mätrigg och experiment #856; direkt köning till torrläge #857 | Oberoende facit på avi, belopp och motpart; jämföra torrlägets domar med människans beslut. Experimentellt referensstöd är inte aktiverat i produkten. |
| Agent 4: bokföring | Manuella bokföringsfunktioner och befintliga AI-verktyg finns | Specificera och verifiera en egen agentloop för kontering och periodavslut, med underlag och mänsklig kontroll. Inventera nuvarande funktioner före implementation; bygg inte om det som redan fungerar. |
| Agent 5: affärsögat | Befintlig portföljanalys och insikter är underlag, inte bevis för den färdiga agenten | Specificera den sammanhängande agentloopen för avvikelser, kostnader och möjligheter sist, när underlagen från övriga delar är tillförlitliga. |

IMD och debitering finns redan som manuella produktfunktioner. Agent 3:s
läsgranskning innebär inte att agenten får skapa eller godkänna debiteringar.
Vidare sådana förmågor behöver egen avgränsning och behörighetsgranskning.

## Vad som behöver verklig användning eller ett beslut

- **Agent 1, etapp 6 och 9:** koden för skuggförslag och skarp utförare finns.
  Planens slutkriterier kräver verkliga ärenden, mänskliga beslut, en uttrycklig
  delegation och verifierat utförande. Syntetiska prov uppfyller inte detta.
- **Agent 2:** automatisk betalningsmatchning är inte delegerbar i nuvarande
  policy. Etapp D/E får inte införas genom att byta klassning för att passera
  en grind. Ett godkännande per handling är något annat än autonom matchning.
- **Agent 3:** verkliga avläsningar med oberoende granskning behövs för att mäta
  driftprecision. Modellens fritext har dokumenterade sakfel; grön CI är inget
  godkännande av den. Se [modellgranskningen](eval/agent3-status-granskning.md).
- **Gemensamma produktbeslut:** avsändare och AI-information, när agenten får
  svara direkt, beloppstak, eskalering när hyresvärden inte svarar, avbrotts- och
  frågebudget samt gränsen mellan klagomål och felanmälan (masterplanens Del 15).

## Granskning och leverans

Claude ska granska varje utkast och besluta om merge. #858 → #859 → #860 → #861
→ #862 → #863 → #864 → #865 är en kedja; rikta om nästa PR mot main efter basens
merge och kontrollera diff samt ny CI. Det nya faktablocket följer efter #865.
#856 och #857 har separata baser. Kontraktsutkastet #855 är en separat uppgift.

Efter granskning återstår kontrollerad driftsättning, driftkontroller och
uttryckligt val av organisation/aktivering där det behövs. Inget i denna
bygglista är tillstånd att slå på flaggor eller autonoma ekonomiska åtgärder.

## Andra lanseringspunkter i repots statusdokument

CLAUDE.md anger även driftsättning av backup, skarpa BankID-/PSD2-adaptrar med
leverantörsavtal och juridisk slutgenomgång. Delar av mekaniken finns redan.
De punkternas driftstatus måste mätas om innan de väljs som nästa uppgift;
den här genomgången läser dokumenten och har inte ändrat någon extern tjänst.

## Rekommenderad ordning

1. Gör skillnaden mellan statusfakta och modellens tolkning synlig och beständig.
2. Begränsa felaktig fritext utan att tappa blandade frågor eller manuella vägar.
3. Bygg oberoende utvärderingsmaterial och mät Agent 2 och 3 mot mänskligt facit.
4. Inventera och avgränsa Agent 4:s första läsande loop; bygg och granska den.
5. Bygg vidare på Agent 5 sist enligt planen.

Verkliga pilotfall och Claudes granskningar kan föras framåt parallellt med
byggordningen när nödvändiga beslut och underlag finns.
