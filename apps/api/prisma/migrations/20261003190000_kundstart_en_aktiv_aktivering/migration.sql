-- KUNDSTART-001 S-6 (C2 KONTRAKTSBESKED-003): högst EN aktiv Fortnox-kundaktivering per
-- organisation, i databasen och inte bara i koden. Partiellt unikt index (samma mönster som
-- bank_identity_review_pause_open_unique); Prisma-schemat kan inte uttrycka predikatet.
-- Bara tillägg. Ingen backfill: tabellen är ny i föregående migration.
CREATE UNIQUE INDEX "fortnox_customer_activation_one_active"
  ON "FortnoxCustomerActivation" ("organizationId")
  WHERE "status" = 'ACTIVE';
