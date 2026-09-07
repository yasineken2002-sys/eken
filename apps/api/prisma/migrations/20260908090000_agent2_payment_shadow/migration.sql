-- AGENT 2, "PENGAR IN" — ETAPP A (skuggläge på omatchade betalningar).
--
-- TVÅ ÄNDRINGAR, BÅDA ADDITIVA. Ingen backfill: en ny flagga är av för alla, och
-- en ny enum-medlem har noll rader.

-- ── 1. EGEN FLAGGA, INTE ETT ANDRA VÄRDE I shadowAgentEnabled ───────────────
--
-- De två svarar på olika frågor och rör olika risk: ett misstag i agent 1
-- betyder fel hantverkare, ett misstag i agent 2 pekar ut fel fordran. Skälet i
-- sin helhet står vid fältet i schema.prisma.
ALTER TABLE "Organization"
  ADD COLUMN "shadowPaymentAgentEnabled" BOOLEAN NOT NULL DEFAULT false;

-- ── 2. EGEN SORT PÅ UPPDRAGET ───────────────────────────────────────────────
--
-- Ett godkänt PAYMENT_MATCH_PROPOSAL UTFÖR matchningen genom avstämningens egen
-- tjänstemetod; ett godkänt TOOL_PROPOSAL i skuggläge utför ingenting. Två
-- rader som betyder olika saker vid samma knapptryck måste gå att skilja åt i
-- databasen och inte bara i texten.
ALTER TYPE "AiAssignmentKind" ADD VALUE 'PAYMENT_MATCH_PROPOSAL';

-- IDEMPOTENSEN BEHÖVER INGEN NY INDEX. Det partiella unika villkoret
-- AiAssignment_shadow_source_unique (organizationId, sourceKind, sourceId)
-- WHERE "shadow" gäller redan för sourceKind = 'BANK_TRANSACTION' — det är just
-- därför sourceKind är en fri sträng och inte en enum.
