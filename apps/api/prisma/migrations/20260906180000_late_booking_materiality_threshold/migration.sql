-- Väsentlighetsgränsen för sen bokföring blir en ORGANISATIONSINSTÄLLNING.
--
-- Den stod som `const VASENTLIGHETSGRANS = new Prisma.Decimal(10000)` i
-- accounting.service.ts — ett tal som gällde varje kund lika. Väsentlighet är
-- per definition relativ bolagets storlek: 10 000 kr är mycket för en privat
-- hyresvärd med tre lägenheter och brus för ett kommersiellt bestånd.
--
-- DEFAULTEN ÄR EXAKT DET GAMLA TALET (1 000 000 ören = 10 000 kr), så varje
-- befintlig organisation får oförändrat beteende. Ingen backfill behövs och
-- ingen är meningsfull: kolumnen har inget historiskt värde att återskapa —
-- den beskriver en policy framåt, inte något som hände.
ALTER TABLE "Organization"
  ADD COLUMN "lateBookingMaterialityThreshold" INTEGER NOT NULL DEFAULT 1000000;

-- Gränsen är ett belopp och kan inte vara negativ. En negativ gräns hade gjort
-- VARJE sen post väsentlig, alltså tyst förvandlat en markering till brus —
-- och det är den sortens fel som inte syns förrän en revisor undrar varför
-- allt är flaggat.
ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_lateBookingMaterialityThreshold_positiv"
  CHECK ("lateBookingMaterialityThreshold" >= 0);
