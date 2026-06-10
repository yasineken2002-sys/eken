-- Etapp 3, PR 3.1 — pgvector-infrastruktur + embedding-tabell (BARA lagring).
-- Inget embeddas här: tabellen är TOM efter migrationen och fylls av
-- knowledge:embed-scriptet i PR 3.2. Ingen Voyage-anrop, ingen retrieval/grind.

-- CreateExtension
-- Tillhandahålls av pgvector/pgvector:pg16-imagen (lokalt) resp. Railways
-- pgvector-kapabla Postgres. IF NOT EXISTS = idempotent om den redan finns.
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
-- Global/publik lagtext-vektor — INTE org-scopad, ingen FK till org/tenant,
-- ingen personuppgift. embedding = vector(1024) (Voyage voyage-law-2/voyage-3).
CREATE TABLE "LegalChunkEmbedding" (
    "id" TEXT NOT NULL,
    "lawId" TEXT NOT NULL,
    "paragraph" TEXT NOT NULL,
    "sfs" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalChunkEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalChunkEmbedding_lawId_idx" ON "LegalChunkEmbedding"("lawId");

-- CreateIndex (rå SQL — Prisma kan inte generera @@index på en Unsupported-kolumn)
-- HNSW för approximativ närmaste-granne-sökning med cosine-avstånd (<=>), den
-- distans semantisk retrieval i PR 3.3 använder. Indexet kan byggas på en tom
-- tabell; HNSW fylls inkrementellt när vektorer skrivs in (PR 3.2).
CREATE INDEX "LegalChunkEmbedding_embedding_hnsw_idx"
    ON "LegalChunkEmbedding"
    USING hnsw ("embedding" vector_cosine_ops);
