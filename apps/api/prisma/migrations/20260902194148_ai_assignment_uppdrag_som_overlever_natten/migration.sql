-- CreateEnum
CREATE TYPE "AiAssignmentStatus" AS ENUM ('AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'AI_ASSIGNMENT_AWAITING';
ALTER TYPE "NotificationType" ADD VALUE 'AI_ASSIGNMENT_EXPIRED';

-- OBS: `prisma migrate dev` ville här lägga till
--   DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
-- Den raden är BORTTAGEN med flit. HNSW-indexet skapas av rå SQL i en tidigare
-- migration och finns därför inte i schema.prisma — Prisma läser det som drift
-- och föreslår en radering. Den hör inte till det här ärendet, och en migration
-- som river ett vektorindex på vägen förbi är precis den sortens svep som drar
-- med sig något som inte är ens eget. Bevakas dessutom av check-critical-indexes.
-- CreateTable
CREATE TABLE "AiAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolInput" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "consequence" TEXT NOT NULL,
    "undoHint" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "status" "AiAssignmentStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "statusReason" TEXT,
    "deadline" TIMESTAMP(3) NOT NULL,
    "assignedToUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "aiToolExecutionId" TEXT,
    "principalKind" TEXT,
    "principalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAssignment_organizationId_status_deadline_idx" ON "AiAssignment"("organizationId", "status", "deadline");

-- CreateIndex
CREATE INDEX "AiAssignment_status_deadline_idx" ON "AiAssignment"("status", "deadline");

-- CreateIndex
CREATE INDEX "AiAssignment_assignedToUserId_idx" ON "AiAssignment"("assignedToUserId");

-- AddForeignKey
ALTER TABLE "AiAssignment" ADD CONSTRAINT "AiAssignment_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAssignment" ADD CONSTRAINT "AiAssignment_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAssignment" ADD CONSTRAINT "AiAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
