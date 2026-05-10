-- DropForeignKey
ALTER TABLE "Document" DROP CONSTRAINT "Document_uploadedById_fkey";

-- DropForeignKey
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_createdById_fkey";

-- CreateTable
CREATE TABLE "PlatformRefreshToken" (
    "id" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformRefreshToken_token_key" ON "PlatformRefreshToken"("token");

-- CreateIndex
CREATE INDEX "PlatformRefreshToken_platformUserId_idx" ON "PlatformRefreshToken"("platformUserId");

-- CreateIndex
CREATE INDEX "PlatformRefreshToken_token_idx" ON "PlatformRefreshToken"("token");

-- CreateIndex
CREATE INDEX "PlatformRefreshToken_expiresAt_idx" ON "PlatformRefreshToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformRefreshToken" ADD CONSTRAINT "PlatformRefreshToken_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "PlatformUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

