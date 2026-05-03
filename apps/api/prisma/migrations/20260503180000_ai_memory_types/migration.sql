-- CreateEnum
CREATE TYPE "AiMemoryType" AS ENUM ('preference', 'fact', 'relationship', 'convention');

-- AlterTable
ALTER TABLE "AiMemory" ADD COLUMN "type" "AiMemoryType" NOT NULL DEFAULT 'fact';
