-- EN LEVANDE HYRESHÖJNING PER AVTAL OCH IKRAFTTRÄDANDE.
--
-- Hyran kan bara ändras en gång på ett givet datum, och en hyresgäst ska bara
-- få ett meddelande om höjningen per ikraftträdande. Två registrerade höjningar
-- för samma avtal och samma datum är alltså inte två affärshändelser utan ett
-- fel — nästan alltid en omkörning.
--
-- `RentIncreasesService.create` kunde inte se det: den validerar bara att
-- avtalet är aktivt/utkast, att fristen räcker och att ny hyra > nuvarande.
-- ALLA TRE passerar vid en omkörning, eftersom avtalets hyra inte skrivs om vid
-- schemaläggningen. Två schemalagda höjningar var alltså fullt möjliga.
--
-- ── PARTIELLT, OCH DET ÄR HELA POÄNGEN ──────────────────────────────────────
--
-- Ett rakt `UNIQUE (leaseId, effectiveDate)` hade varit FÖR GROVT: en höjning
-- som återkallats, nekats av hyresgästen eller annullerats vid avtalsförnyelse
-- har inte trätt i kraft, och en ny höjning för samma datum är då en legitim
-- andra handling. Villkoret gäller därför bara de statusar där höjningen
-- fortfarande gör anspråk på datumet.
--
-- Samma form som `lease_unit_active_unique`, och registrerat i
-- check-critical-indexes.mjs av samma skäl: ett partiellt index syns inte i
-- schema.prisma och kan annars försvinna i en senare migration utan att något
-- blir rött.
--
-- INGEN STÄDNING BEHÖVS. Mätt före migrationen: dev 0 rader, prod 0 rader.
CREATE UNIQUE INDEX "rent_increase_lease_effective_live_unique"
  ON "RentIncrease" ("leaseId", "effectiveDate")
  WHERE status IN ('DRAFT', 'NOTICE_SENT', 'ACCEPTED', 'APPLIED');
