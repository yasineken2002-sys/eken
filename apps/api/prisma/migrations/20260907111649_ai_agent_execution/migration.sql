-- CreateEnum
CREATE TYPE "AiAssignmentEventType" AS ENUM ('UNDO_REQUESTED');

-- OBS: `prisma migrate dev` genererade här ett
--   DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
-- och det är BORTTAGET med flit. Indexet är ett pgvector-HNSW-index som
-- Prisma inte kan uttrycka i schemat, så varje ny migration vill droppa det.
-- Det är känd drift, inte en ändring den här migrationen ska göra — och att
-- släppa igenom raden hade tagit bort produktionens vektorindex.

-- AlterTable
ALTER TABLE "AiAssignment" ADD COLUMN     "executionStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "agentExecutionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AiAssignmentEvent" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "type" "AiAssignmentEventType" NOT NULL,
    "handlingAv" "ActorKind" NOT NULL,
    "actorUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAssignmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAssignmentEvent_assignmentId_createdAt_idx" ON "AiAssignmentEvent"("assignmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiAssignmentEvent" ADD CONSTRAINT "AiAssignmentEvent_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "AiAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
