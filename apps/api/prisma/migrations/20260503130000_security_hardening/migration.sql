-- Säkerhetshärdning:
--   1. Lägg till loginAttempts/lockedUntil på User för brute-force-skydd
--      enligt OWASP ASVS V2.2.1 (account lockout efter ≥10 felaktiga försök).
--   2. Töm befintliga RefreshToken och TenantSession — efter denna deploy
--      lagras de SHA-256-hashade istället för plaintext, så gamla rader
--      skulle ändå inte kunna valideras. Användare måste logga in på nytt.

ALTER TABLE "User"
  ADD COLUMN "loginAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lockedUntil" TIMESTAMP(3);

DELETE FROM "RefreshToken";
DELETE FROM "TenantSession";
