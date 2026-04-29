-- AlterEnum
ALTER TYPE "RentNoticeStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "RentNotice" ADD COLUMN "sendError" TEXT;
