-- Additiv grund för återupptagning. Befintliga läsningar har workVersion NULL.
CREATE TYPE "FortnoxReadPhase" AS ENUM ('CATALOG', 'MANIFEST', 'DETAILS', 'READY_TO_REDUCE');

ALTER TABLE "FortnoxReadRun"
  ADD COLUMN "workVersion" INTEGER,
  ADD COLUMN "phase" "FortnoxReadPhase",
  ADD COLUMN "connectionGeneration" INTEGER,
  ADD COLUMN "fortnoxOrgNumber" TEXT,
  ADD COLUMN "requestHash" TEXT,
  ADD COLUMN "frozenContext" JSONB,
  ADD COLUMN "catalog" JSONB,
  ADD COLUMN "nextManifestPage" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "claimVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "checkpointUpdatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "FortnoxReadRun_id_organizationId_key" ON "FortnoxReadRun"("id", "organizationId");
CREATE UNIQUE INDEX "fortnox_read_one_managed_running" ON "FortnoxReadRun"("organizationId")
  WHERE "workVersion" = 1 AND "status" = 'RUNNING';

ALTER TABLE "FortnoxReadRun" ADD CONSTRAINT "fortnox_read_checkpoint_shape" CHECK (
  "nextManifestPage" >= 1 AND "claimVersion" >= 0
  AND (("claimToken" IS NULL) = ("leaseUntil" IS NULL))
  AND ("workVersion" IS NULL OR (
    "workVersion" = 1 AND "phase" IS NOT NULL AND "connectionGeneration" >= 0
    AND "connectionGeneration" IS NOT NULL AND "requestHash" IS NOT NULL
    AND "frozenContext" IS NOT NULL AND "checkpointUpdatedAt" IS NOT NULL
    -- Denna foundation publicerar aldrig ekonomiska delresultat.
    AND "summary" IS NULL AND "rows" IS NULL
    AND "status" IN ('RUNNING', 'PARTIAL', 'FAILED', 'AUTH_LOST', 'WRONG_COMPANY')
    AND ("status" <> 'RUNNING' OR "completedAt" IS NULL)
  ))
);

CREATE TABLE "FortnoxReadManifestPage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "page" INTEGER NOT NULL,
  "totalPages" INTEGER NOT NULL,
  "totalResources" INTEGER NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "digest" TEXT NOT NULL,
  "entries" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FortnoxReadManifestPage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_read_manifest_counts" CHECK (
    "page" >= 1 AND "totalPages" >= 0 AND "totalResources" >= 0
    AND "itemCount" >= 0 AND "itemCount" <= 100
  )
);
CREATE UNIQUE INDEX "FortnoxReadManifestPage_runId_page_key" ON "FortnoxReadManifestPage"("runId", "page");
CREATE INDEX "FortnoxReadManifestPage_organizationId_idx" ON "FortnoxReadManifestPage"("organizationId");
ALTER TABLE "FortnoxReadManifestPage" ADD CONSTRAINT "FortnoxReadManifestPage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FortnoxReadManifestPage" ADD CONSTRAINT "FortnoxReadManifestPage_runId_organizationId_fkey"
  FOREIGN KEY ("runId", "organizationId") REFERENCES "FortnoxReadRun"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FortnoxReadVoucherCheckpoint" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "manifestDigest" TEXT NOT NULL,
  "detailDigest" TEXT,
  "validated" JSONB,
  "observedAt" TIMESTAMP(3),
  CONSTRAINT "FortnoxReadVoucherCheckpoint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fortnox_read_detail_shape" CHECK (
    ("detailDigest" IS NULL AND "validated" IS NULL AND "observedAt" IS NULL)
    OR ("detailDigest" IS NOT NULL AND "validated" IS NOT NULL AND "observedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "FortnoxReadVoucherCheckpoint_runId_key_key" ON "FortnoxReadVoucherCheckpoint"("runId", "key");
CREATE INDEX "FortnoxReadVoucherCheckpoint_organizationId_idx" ON "FortnoxReadVoucherCheckpoint"("organizationId");
ALTER TABLE "FortnoxReadVoucherCheckpoint" ADD CONSTRAINT "FortnoxReadVoucherCheckpoint_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FortnoxReadVoucherCheckpoint" ADD CONSTRAINT "FortnoxReadVoucherCheckpoint_runId_organizationId_fkey"
  FOREIGN KEY ("runId", "organizationId") REFERENCES "FortnoxReadRun"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
