/*
  Warnings:

  - You are about to drop the column `fileUrl` on the `Document` table. All the data in the column will be lost.
  - You are about to drop the column `path` on the `InspectionImage` table. All the data in the column will be lost.
  - You are about to drop the column `path` on the `MaintenanceImage` table. All the data in the column will be lost.
  - You are about to drop the column `logoUrl` on the `Organization` table. All the data in the column will be lost.
  - Added the required column `storageKey` to the `Document` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storageUrl` to the `Document` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storageKey` to the `InspectionImage` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storageUrl` to the `InspectionImage` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storageKey` to the `MaintenanceImage` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storageUrl` to the `MaintenanceImage` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Document" DROP COLUMN "fileUrl",
ADD COLUMN     "storageKey" TEXT NOT NULL,
ADD COLUMN     "storageUrl" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "InspectionImage" DROP COLUMN "path",
ADD COLUMN     "storageKey" TEXT NOT NULL,
ADD COLUMN     "storageUrl" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "MaintenanceImage" DROP COLUMN "path",
ADD COLUMN     "storageKey" TEXT NOT NULL,
ADD COLUMN     "storageUrl" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Organization" DROP COLUMN "logoUrl",
ADD COLUMN     "logoStorageKey" TEXT,
ADD COLUMN     "logoStorageUrl" TEXT;
