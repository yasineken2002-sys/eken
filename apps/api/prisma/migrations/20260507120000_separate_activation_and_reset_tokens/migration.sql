-- Säkerhetshärdning – Tenant-tokens, omgång 2:
--   1. Hash-only lagring: activationToken döps om till activationTokenHash.
--      Råtoken skickas i mejl, SHA-256-hash sparas i DB. Vid läcka går
--      hashen inte att använda för att aktivera ett konto.
--
--   2. Separata kolumner för aktivering och lösenordsåterställning. Samma
--      kolumn för båda flödena gjorde att en pågående reset kunde
--      överskriva en aktiveringstoken (eller tvärtom) — race condition om
--      hyresgästen bad om reset under aktiveringsfönstret.
--
--   3. Påminnelsemejl-spårning: activationReminderSentAt sätts av cron
--      när påminnelsen skickats, så vi inte spammar samma hyresgäst varje
--      dygn medan token fortfarande är giltig.
--
-- Befintliga okrypterade tokens nollas — de är ändå värdelösa efter
-- döpningen (lookup sker via hash) och hyresgäster som var mitt i ett
-- aktiveringsflöde kan be om en ny länk via "glömt lösenord".

ALTER TABLE "Tenant" RENAME COLUMN "activationToken" TO "activationTokenHash";

-- Befintliga klartext-tokens är obrukbara eftersom lookup nu sker via
-- SHA-256-hash. Nollställ dem så att unique-constraint inte krockar och
-- frontend kan visa "länk utgången" istället för att hänga.
UPDATE "Tenant"
SET "activationTokenHash" = NULL,
    "activationTokenExpiresAt" = NULL;

-- Det gamla unique-indexet följde kolumnnamnet; döp om så Prisma och DB
-- är synkroniserade utan att vi tappar constraint:en.
ALTER INDEX "Tenant_activationToken_key" RENAME TO "Tenant_activationTokenHash_key";

ALTER TABLE "Tenant"
  ADD COLUMN "activationReminderSentAt"    TIMESTAMP(3),
  ADD COLUMN "passwordResetTokenHash"      TEXT,
  ADD COLUMN "passwordResetTokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Tenant_passwordResetTokenHash_key"
  ON "Tenant"("passwordResetTokenHash");
