-- Cleanup av historiska dubblett-CONTRACT-PDF:er som skapades innan
-- ContractTemplateService fick hash-baserad dedup (se Leyla 2026-05-09:
-- 2 osignerade kontrakts-PDF:er på samma lease).
--
-- Strategi: vi tar inte bort filerna — för varje lease med flera olåsta
-- CONTRACT-rader länkas raderna i en versionskedja (nyare → äldre via
-- previousVersionId) så ContractTab visar bara den senaste som "current"
-- och övriga hamnar under "Versionshistorik". Filerna i R2 lämnas så
-- audit-spåret är intakt; locked rader (signerade) rörs aldrig.
--
-- Idempotent: andra körningen ändrar inget eftersom vi bara skriver där
-- previousVersionId fortfarande är NULL.
WITH duplicate_leases AS (
  SELECT "leaseId"
  FROM "Document"
  WHERE category = 'CONTRACT'
    AND "leaseId" IS NOT NULL
    AND locked = false
  GROUP BY "leaseId"
  HAVING COUNT(*) > 1
),
chain AS (
  SELECT
    d.id,
    LAG(d.id) OVER (
      PARTITION BY d."leaseId"
      ORDER BY d."createdAt"
    ) AS older_id
  FROM "Document" d
  JOIN duplicate_leases dl ON dl."leaseId" = d."leaseId"
  WHERE d.category = 'CONTRACT'
    AND d.locked = false
)
UPDATE "Document" target
SET "previousVersionId" = chain.older_id
FROM chain
WHERE target.id = chain.id
  AND chain.older_id IS NOT NULL
  AND target."previousVersionId" IS NULL;
