# Agent 2: direkt köning till torrläge

Utgångspunkt: main `27a720d`, fortsättning på etapp C i `eveno-agentplan.md`.
Betalningsförslag är redan skuggförslag och omfattas av torrlägets generella
svep var femtonde minut. Producenten saknade däremot den direkta köning som
felanmälans producent använder. Denna ändring fyller just den luckan.

Efter lyckad `AiAssignment.create` köas det sparade förslagets id och dess
organisation till `AiExecutionDryRunQueue`, via den befintliga
`enqueueSafely`. Vid köfel finns förslaget kvar utan dom och kan fångas av
svepet. Inget jobb köas efter misslyckad skrivning, avstängd agent eller en
redan funnen dubblett. Databasprovets manuella konstruktion får samma nya
köberoende som produktionens tjänst.

Torrläget frågar den ordinarie delegationsgrinden. `match_bank_transaction`
är fortfarande inte delegerbart och får `BLOCKED`. Domen handlar om rätt
att agera själv, inte om huruvida den föreslagna avin är rätt. Inga nya
befogenheter eller matchningsregler införs.

Lokalt verifierat: sex riktade prov, API-typecheck med 1800 MB heaptak,
ESLint och diffkontroll. Proven använder mockad Prisma och kö, men riktig
`enqueueSafely`, torrlägestjänst och delegationsgrind. De bevisar ordningen,
felhanteringen och den blockerande domen; de är inte DB-integrationsprov.
Full svit, befintliga DB-prov och uppstart med Nest lämnas till CI.

Etapp C:s driftkriterium – att domarna har jämförts med människans beslut –
är fortfarande omätt. Denna anslutning aktiverar ingen organisation, kör
ingen betalning och ändrar inga filer i avstämningsmodulen. Utkastet är
fristående från #856:s mätrigg och experiment och kräver inte dess merge.
