-- BANKID: IDENTITET OCH PÅGÅENDE ORDER (S1 PR 2).
--
-- Motiveringen till varför identiteten är en EGEN tabell och inte ett fältpar på
-- "User" står vid modellen i schema.prisma. Kort: subjectHash svarar på "vilken
-- PERSON?" och userId på "vilket KONTO?", och en person kan ha konton i flera
-- organisationer — så ett unikt index på User hade blivit fel åt båda hållen.
--
-- ── TVÅ RADER BORTTAGNA UR DEN GENERERADE SQL:EN, MED FLIT ──────────────────
--
-- `prisma migrate diff` la in:
--
--     CREATE EXTENSION IF NOT EXISTS "vector";
--     DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
--
-- HNSW-indexet går inte att uttrycka i schema.prisma, så diffen vill ta bort det
-- VARJE gång en migration genereras. Hade raden följt med hade juridik-RAG:ens
-- vektorindex försvunnit i prod — en tyst prestandakollaps utan samband med
-- BankID. Samma sak dokumenterad i 20260820120000, 20260822113144,
-- 20260831212302 och 20260904103000; det här är femte gången fällan gillrats.


-- CreateTable
CREATE TABLE "UserBankIdIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "subjectEnc" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBankIdIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankIdOrder" (
    "id" TEXT NOT NULL,
    "orderRef" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankIdOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserBankIdIdentity_provider_subjectHash_idx" ON "UserBankIdIdentity"("provider", "subjectHash");

-- CreateIndex
CREATE INDEX "UserBankIdIdentity_userId_idx" ON "UserBankIdIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBankIdIdentity_provider_subjectHash_userId_key" ON "UserBankIdIdentity"("provider", "subjectHash", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "BankIdOrder_orderRef_key" ON "BankIdOrder"("orderRef");

-- CreateIndex
CREATE INDEX "BankIdOrder_expiresAt_idx" ON "BankIdOrder"("expiresAt");

-- AddForeignKey
ALTER TABLE "UserBankIdIdentity" ADD CONSTRAINT "UserBankIdIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

