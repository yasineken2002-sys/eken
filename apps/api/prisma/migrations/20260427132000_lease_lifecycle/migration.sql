-- CreateEnum
CREATE TYPE "LeaseType" AS ENUM ('FIXED_TERM', 'INDEFINITE');

-- AlterTable
ALTER TABLE "Lease" ADD COLUMN     "leaseType" "LeaseType" NOT NULL DEFAULT 'INDEFINITE',
ADD COLUMN     "renewalPeriodMonths" INTEGER;
