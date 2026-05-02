-- Tenant password-baserad portalautentisering
-- Ersätter magic link-flödet med ett aktiveringsflöde där hyresgästen
-- signerar kontraktet och väljer eget lösenord. Aktiveringstoken används
-- både för första aktivering (72h TTL) och vid lösenordsåterställning.

ALTER TABLE "Tenant"
  ADD COLUMN "portalActivated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "portalActivatedAt" TIMESTAMP(3),
  ADD COLUMN "passwordHash" TEXT,
  ADD COLUMN "activationToken" TEXT,
  ADD COLUMN "activationTokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Tenant_activationToken_key" ON "Tenant"("activationToken");
