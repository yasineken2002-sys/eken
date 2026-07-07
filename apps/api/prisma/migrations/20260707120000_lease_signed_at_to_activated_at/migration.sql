-- S2: döp om Lease.signedAt → Lease.activatedAt.
-- RENAME COLUMN (inte DROP+ADD) → befintlig data bevaras: activatedAt får varje
-- rads gamla signedAt-värde. Ändrar ingen semantik i statusmaskinen — bara namnet
-- på fältet som redan sattes vid aktivering (status → ACTIVE).
ALTER TABLE "Lease" RENAME COLUMN "signedAt" TO "activatedAt";
