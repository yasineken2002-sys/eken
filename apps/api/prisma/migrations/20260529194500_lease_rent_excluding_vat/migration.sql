-- FIX 9 · PR 3 — Netto-gate för moms på lokalhyra (JB 12 kap 19 § 3 st)
--
-- Lägger till Lease.monthlyRentExcludingVat. Moms läggs på en hyresavi endast
-- när hyran uttryckligen är markerad som netto (exkl moms) OCH enheten är
-- momspliktig. Default false skyddar befintliga/otydliga kontrakt mot att moms
-- läggs ovanpå en hyra som kan ha avtalats inkl. moms — vilket annars vore en
-- oavtalad hyreshöjning enligt hyreslagen (JB 12 kap 19 § 3 st).
ALTER TABLE "Lease" ADD COLUMN "monthlyRentExcludingVat" BOOLEAN NOT NULL DEFAULT false;
