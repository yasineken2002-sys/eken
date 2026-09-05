-- UnitEquipmentEvent: kostnad, bilaga, aktör och rättelsekedja (etapp 1b, skrivvägen).
--
-- SKRIVEN FÖR HAND, inte genererad. `prisma migrate diff` mot en shadow-databas
-- tog med två poster som INTE hör till den här ändringen — `CREATE EXTENSION
-- vector` och ett `DROP INDEX LegalChunkEmbedding_embedding_hnsw_idx`. HNSW-
-- indexet skapas av rå SQL i en tidigare migration och finns inte i datamodellen,
-- så differensen "saknar" det varje gång. Att låta det följa med hade tappat
-- vektorindexet i produktion.
--
-- ALLA KOLUMNER ÄR NULLBARA UTAN DEFAULT. Ingen backfill, och det är ett beslut:
-- NULL betyder OKÄNT. En default på `cost = 0` hade gjort "gratis" och "vi vet
-- inte" omöjliga att skilja åt, och en `actorKind = HUMAN` på gamla rader hade
-- varit precis det obelagda påstående G1 finns för att ta bort.

ALTER TABLE "UnitEquipmentEvent"
  ADD COLUMN "cost"          DECIMAL(12,2),
  ADD COLUMN "attachmentUrl" TEXT,
  ADD COLUMN "actorKind"     "ActorKind",
  ADD COLUMN "performedById" TEXT,
  ADD COLUMN "correctsId"    TEXT;

-- En rättelse pekar på EXAKT ett original. Utan unikheten är en förgrenad
-- rättelsekedja tillåten, och då är "vad hände egentligen" inte längre en fråga
-- med ett svar. Samma konstruktion som UnitEquipment.replacedById.
CREATE UNIQUE INDEX "UnitEquipmentEvent_correctsId_key"
  ON "UnitEquipmentEvent"("correctsId");

CREATE INDEX "UnitEquipmentEvent_performedById_idx"
  ON "UnitEquipmentEvent"("performedById");

-- RESTRICT, INTE SET NULL — på båda. `ON DELETE SET NULL` är en kaskad-UPDATE
-- som tabellens append-only-trigger (#585) avvisar. Priset är en raderingsordning
-- som redan finns i delete-organization.ts.
ALTER TABLE "UnitEquipmentEvent"
  ADD CONSTRAINT "UnitEquipmentEvent_performedById_fkey"
  FOREIGN KEY ("performedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UnitEquipmentEvent"
  ADD CONSTRAINT "UnitEquipmentEvent_correctsId_fkey"
  FOREIGN KEY ("correctsId") REFERENCES "UnitEquipmentEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
