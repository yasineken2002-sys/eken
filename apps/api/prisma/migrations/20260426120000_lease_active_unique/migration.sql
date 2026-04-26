-- Garanterar att en enhet bara kan ha ETT aktivt kontrakt åt gången.
-- Partial unique index på Postgres: gäller endast rader där status='ACTIVE'.
-- DRAFT/EXPIRED/TERMINATED får fortfarande finnas i hur många som helst.
CREATE UNIQUE INDEX "lease_unit_active_unique"
  ON "Lease" ("unitId")
  WHERE status = 'ACTIVE';
