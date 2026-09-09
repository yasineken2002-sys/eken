# Agent 3: byggt, prövat och återstående

Status 2026-09-09. Masterplanen beskriver Agent 3 som mätaravläsning, IMD och
debitering. Utkasten bygger en sammanhängande **läsande granskning och mänsklig
bedömning** kring de befintliga manuella förbrukningsfunktionerna. De är inte
en delegerad agent som själv ändrar avläsningar eller debiterar hyresgäster.

| Del                                               | Underlag                                        | Status                                                 |
| ------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Regelbaserad granskning av avläsningar            | #858                                            | Byggd och testad med konstruerade data                 |
| Beräkningar, källrader och kontrollsteg           | #859                                            | Byggt, samma beräkning som varningen                   |
| Gemensamt API, regelversion och fingeravtryck     | #860                                            | Byggt; förändrat underlag kan identifieras             |
| Mänskliga bedömningar och revisionshistorik       | #861                                            | Byggt; roller och konfliktkontroll finns               |
| Assistentens läsning av granskningen              | #862                                            | Byggt; ingen rätt att spara bedömningar eller debitera |
| Gemensam granskningskö                            | #863                                            | Byggd; ändrat underlag återkommer till bedömning       |
| Daglig uppföljning och intern notis               | #864                                            | Byggt; ägarens reglage är av som standard              |
| Assistentens uppföljningsstatus                   | #865                                            | Byggt; gemensamma tider, regler och begränsningar      |
| Kodbundna statusfakta                             | #866                                            | Byggt; visas och sparas även vid återspelning          |
| Kontroll av fritext före visning                  | Efter #866, detta utkast                        | Byggd; uppmätta semantiska begränsningar kvarstår      |
| Manuella avläsningar, IMD och debitering          | Befintlig Consumption-modul                     | Befintliga funktioner; inga ändringar i detta bygge    |
| Verklig precision och arbetsflöde i drift         | Oberoende avläsningar och mänskligt facit       | Ej mätt; användaren har ännu inget sådant underlag     |
| Autonoma förbrukningsrättelser eller debiteringar | Kräver egen avgränsning och behörighetsprövning | Inte byggt eller aktiverat genom dessa utkast          |

## Innan Agent 3 kan kallas driftklar

1. Claude granskar kedjan #858 → #866 och detta utkast. Alla är fortfarande
   öppna utkast vid kontrollen 2026-09-09. Ingen merge har gjorts av Codex.
2. Avgör eller åtgärda den kvarvarande överfiltreringen av korrekta stycken.
   Svarsgrinden stoppade alla tio utpekade sakfel i de gamla svaren men behöll
   bara 43 av 44 utpekade korrekta stycken. Se [mätningen](agent3-svarsgrind.md).
3. Samla verkliga fall som får användas och låt en människa bedöma dem innan
   modellens resultat visas för bedömaren. Behåll osäkra och saknade resultat
   i nämnaren. Skilj upptäckta varningar, rätt beräkningsunderlag, rätt tolkning
   och fungerande mänsklig hantering; summera dem inte till en enda procentsiffra.
4. Prova hela flödet i en kontrollerad miljö: avläsning → varning → källor →
   bedömning → ändrat underlag → ny bedömning, samt på/av, lyckad uppföljning,
   utebliven notis och misslyckad uppföljning. Kontrollera roller och återladdad
   chatt. Avläsningar, fakturor och bokföring ska inte ändras av läsgranskningen.
5. Bestäm eventuell pilotorganisation och aktivering separat efter granskning.
   Grön CI, syntetiska prov eller denna bygglista är inte en aktiveringsorder.

Låt de manuella funktionerna finnas kvar som människans väg. En sparad
bedömning betyder varken att en avvikelse är åtgärdad eller att debiteringen
är godkänd. Uteblivna varningar är inte ett bevis för felfria avläsningar.
