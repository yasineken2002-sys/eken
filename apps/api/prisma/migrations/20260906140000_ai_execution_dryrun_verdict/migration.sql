-- UTFÖRAREN I TORRLÄGE (etapp 8) — domen, inte effekten.
--
-- Den här migrationen lägger till FYRA kolumner och INGEN kodväg som skriver en
-- effekt. Kolumnerna bär svaret på en kontrafaktisk fråga: *hade agenten fått
-- göra det här själv, och enligt vilken delegation?*
--
-- ── VARFÖR EGNA KOLUMNER OCH INTE `authorityKind`/`delegationId` ────────────
--
-- De två uppsättningarna ser identiska ut och svarar på olika frågor:
--
--     delegationId         med vilken rätt UTFÖRDES det här?
--     verdictDelegationId  vilken delegation HADE burit det, om det utförts?
--
-- Den första är ett faktum, den andra ett påstående om något som inte hände.
-- Att låna det befintliga fältet hade gjort varje torrlägesdom oskiljbar från en
-- verklig delegerad körning i varje fråga som räknar dem — och det är precis de
-- frågorna en revision ställer. Se CLAUDE.md, "Återanvänd inte ett fält som
-- svarar på en ANNAN fråga".
--
-- ── VARFÖR TRE UTFALL OCH INTE TVÅ ─────────────────────────────────────────
--
--     NO_DELEGATION  du har inte gett den här rätten
--     BLOCKED        du HAR gett den, men den gällde inte här (pausad,
--                    utgången, återkallad, frekvensen förbrukad)
--
-- Slås de ihop blir en återkallad delegation oskiljbar från en som aldrig
-- funnits, och det är den enda skillnad hyresvärden kan göra något åt.
--
-- ── NULLBARA, OCH DET ÄR INTE SLARV ────────────────────────────────────────
--
-- NULL i `executionVerdict` betyder "ingen dom ännu" — sveparcronen har inte
-- hunnit, eller kön tappade jobbet. Det är ett eget tillstånd och ska inte
-- kunna förväxlas med `NO_DELEGATION`. En default hade gjort tystnad till ett
-- svar. Jämför `outcome` på samma tabell: NULL = "facit finns inte än".
--
-- `verdictDelegationId` är `ON DELETE SET NULL` och inte `CASCADE`: en
-- återkallad delegation raderas aldrig (den får en händelse), men skulle raden
-- ändå försvinna ska domen finnas kvar. Ett spår som tas bort med sin grund kan
-- inte besvara den fråga det finns för.
--
-- OBS: `prisma migrate diff` ville här lägga till
--   CREATE EXTENSION IF NOT EXISTS "vector";
--   DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
-- Båda raderna är BORTTAGNA med flit, samma sak som i 20260903160936,
-- 20260902194148, 20260901090000, 20260831212302 och 20260820120000.
-- HNSW-indexet skapas av rå SQL i 20260610000000 och finns därför inte i
-- schema.prisma — Prisma läser det som drift och föreslår en radering. Den hör
-- inte till det här ärendet, och en körd radering hade gjort juridik-RAG:ens
-- vektorsökning till en full scan utan att något blev rött.

-- CreateEnum
CREATE TYPE "AiExecutionVerdict" AS ENUM ('WOULD_EXECUTE', 'NO_DELEGATION', 'BLOCKED');

-- AlterTable
ALTER TABLE "AiAssignment" ADD COLUMN     "executionVerdict" "AiExecutionVerdict",
ADD COLUMN     "verdictAt" TIMESTAMP(3),
ADD COLUMN     "verdictDelegationId" TEXT,
ADD COLUMN     "verdictReason" TEXT;

-- CreateIndex
CREATE INDEX "AiAssignment_organizationId_shadow_executionVerdict_idx" ON "AiAssignment"("organizationId", "shadow", "executionVerdict");

-- CreateIndex
CREATE INDEX "AiAssignment_verdictDelegationId_verdictAt_idx" ON "AiAssignment"("verdictDelegationId", "verdictAt");

-- AddForeignKey
ALTER TABLE "AiAssignment" ADD CONSTRAINT "AiAssignment_verdictDelegationId_fkey" FOREIGN KEY ("verdictDelegationId") REFERENCES "AiDelegation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

