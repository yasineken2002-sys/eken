-- Additiv återhämtningsstatus. Äldre utskick och påminnelser behåller 0/null;
-- ingen policy eller kund aktiveras och inga befintliga utskick köas här.
ALTER TABLE "RentNoticeSend"
  ADD COLUMN "recoveryAfter" TIMESTAMP(3),
  ADD COLUMN "recoveryAttempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "RentNoticeSend"
  ADD CONSTRAINT "customer_credit_notice_dispatch_recovery_shape" CHECK (
    "recoveryAttempts" >= 0
    AND (
      "dispatchKey" IS NOT NULL
      OR ("recoveryAttempts" = 0 AND "recoveryAfter" IS NULL)
    )
  );

CREATE INDEX "RentNoticeSend_acceptedAt_recoveryAfter_preparedAt_idx"
  ON "RentNoticeSend"("acceptedAt", "recoveryAfter", "preparedAt");

-- Den befintliga immutable-triggern räknar upp dokument- och kvittensfält.
-- Den lämnas oförändrad: återhämtningsprogress får flyttas, men aldrig det
-- sparade dokumentet, ekonomin, mottagaren eller en redan satt kvittens.
