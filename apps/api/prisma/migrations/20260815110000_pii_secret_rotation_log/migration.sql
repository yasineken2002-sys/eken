-- Operationsspår för rotation av SIGNING_PII_KEY / SIGNING_PII_PEPPER (#459).
--
-- Rotationen skriver i SignatureEvidence, som är append-only. Att det är
-- försvarbart bygger på att en omkryptering byter LAGRINGSFORM och inte
-- innehåll — men argumentet håller bara om transformationen går att se i
-- efterhand. Den här tabellen är den synligheten.
--
-- INNEHÅLLER ALDRIG ETT VÄRDE: inga nycklar, ingen pepper, ingen hash, ingen
-- chiffertext, inga person-id:n. Bara läge, utfall, antal och tidsstämplar.
--
-- Handskriven med flit — `prisma migrate diff` drar in orelaterad dev-drift
-- (senast en DROP INDEX på ett skarpt HNSW-vektorindex).

CREATE TABLE "PiiSecretRotation" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "rowsScanned" INTEGER NOT NULL,
    "rowsRotated" INTEGER NOT NULL,
    "rowsAlreadyRotated" INTEGER NOT NULL,
    "rowsSkipped" INTEGER NOT NULL,
    "perTable" JSONB,
    "abortReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PiiSecretRotation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PiiSecretRotation_startedAt_idx" ON "PiiSecretRotation"("startedAt");
