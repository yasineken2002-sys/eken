-- FIX 9 · PR 5 — Soft-delete av plattformsfakturor (LAGBROTT 1, BFL 1999:1078)
--
-- Plattformsfakturor (SaaS-fakturering till hyresvärdar) är räkenskapsinformation
-- och får inte raderas hårt. De makuleras nu (status VOID) i stället. voidedAt/
-- voidedReason ger behandlingshistorik (BFL 5 kap 11 §) — när och varför en
-- faktura makulerades. Nullable, ingen backfill (befintliga rader = ej makulerade).
ALTER TABLE "PlatformInvoice" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "PlatformInvoice" ADD COLUMN "voidedReason" TEXT;
