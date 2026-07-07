-- CreateEnum
CREATE TYPE "SigningRequestStatus" AS ENUM ('PENDING', 'SIGNING_IN_PROGRESS', 'PARTIALLY_SIGNED', 'FULLY_SIGNED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'ERROR');

-- CreateEnum
CREATE TYPE "SignerRole" AS ENUM ('LANDLORD', 'TENANT');


-- CreateTable
CREATE TABLE "SigningRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "leaseId" TEXT,
    "contentHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "SigningRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requiredRoles" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "sealedDocumentId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SigningRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignatureEvidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "signingRequestId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "signerRole" "SignerRole" NOT NULL,
    "signerName" TEXT NOT NULL,
    "personalNumberEnc" TEXT NOT NULL,
    "personalNumberHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "orderRef" TEXT NOT NULL,
    "signedContentHash" TEXT NOT NULL,
    "signaturePayload" TEXT,
    "certificate" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SigningRequest_organizationId_idx" ON "SigningRequest"("organizationId");

-- CreateIndex
CREATE INDEX "SigningRequest_documentId_idx" ON "SigningRequest"("documentId");

-- CreateIndex
CREATE INDEX "SigningRequest_status_idx" ON "SigningRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SigningRequest_organizationId_idempotencyKey_key" ON "SigningRequest"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SignatureEvidence_organizationId_idx" ON "SignatureEvidence"("organizationId");

-- CreateIndex
CREATE INDEX "SignatureEvidence_signingRequestId_idx" ON "SignatureEvidence"("signingRequestId");

-- CreateIndex
CREATE INDEX "SignatureEvidence_documentId_idx" ON "SignatureEvidence"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "SignatureEvidence_organizationId_provider_orderRef_key" ON "SignatureEvidence"("organizationId", "provider", "orderRef");

-- CreateIndex

-- AddForeignKey
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureEvidence" ADD CONSTRAINT "SignatureEvidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureEvidence" ADD CONSTRAINT "SignatureEvidence_signingRequestId_fkey" FOREIGN KEY ("signingRequestId") REFERENCES "SigningRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

