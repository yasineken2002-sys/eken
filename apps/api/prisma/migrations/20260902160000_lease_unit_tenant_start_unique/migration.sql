-- ETT AVTAL PER ENHET, HYRESGÄST OCH TILLTRÄDESDAG.
--
-- Samma part, samma lägenhet, samma startdatum två gånger är inte två
-- hyresförhållanden — det är ett registrerat två gånger. En hyresgäst som
-- flyttar ut och tillbaka in i samma lägenhet får ett annat startdatum och
-- blockeras alltså inte.
--
-- FYLLER LUCKAN EFTER lease_unit_active_unique. Det partiella indexet gäller
-- bara status = 'ACTIVE', och båda AI-verktygen skapar avtalet som DRAFT:
-- create_lease stannar där, create_tenant_and_lease övergår sedan till ACTIVE.
-- En omkörning gav därför två utkast på samma enhet utan att något villkor
-- kunde se det.
--
-- INGEN STÄDNING BEHÖVS. Mätt före migrationen: dev 11 avtal / 11 unika
-- (unitId, tenantId, startDate); prod 2 / 2.
CREATE UNIQUE INDEX "Lease_unitId_tenantId_startDate_key"
  ON "Lease"("unitId", "tenantId", "startDate");
