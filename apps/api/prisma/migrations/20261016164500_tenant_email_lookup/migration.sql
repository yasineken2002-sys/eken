-- En enda sats: CONCURRENTLY får inte omslutas av en transaktion eller
-- kombineras med SET/annan DDL i samma Prisma-migrationsfil.
-- Behåll organisationens unika e-postvillkor; detta index är INTE unikt.
-- Vid avbrott: inspektera pg_index och följ docs/runbooks/tenant-email-index.md.
CREATE INDEX CONCURRENTLY "Tenant_email_idx" ON "Tenant"("email");
