-- OBS: `prisma migrate dev` ville här lägga till
--   DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
-- Den raden är BORTTAGEN med flit, samma sak som i
-- 20260902194148, 20260901090000, 20260831212302 och 20260820120000. HNSW-indexet
-- skapas av rå SQL i 20260610000000 och finns därför inte i schema.prisma —
-- Prisma läser det som drift och föreslår en radering. Den hör inte till det här
-- ärendet, och en migration som river ett vektorindex på vägen förbi är precis
-- den sortens svep som drar med sig något som inte är ens eget. Bevakas dessutom
-- av check-critical-indexes.

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "autoMatchExcludedAt" TIMESTAMP(3);
