-- AccountingPeriodEvent — append-only behandlingshistorik för periodstängning (T5 PR1b).
--
-- Ersätter ClosedAccountingPeriod som SANNINGSKÄLLA för frågan "är perioden
-- stängd?". Den gamla tabellen finns kvar och skrivs fortfarande, men enbart som
-- icke-auktoritativ spegling/rollback-fallskärm — den läses av ingen kodväg och
-- DROPas i PR1d.
--
-- Se docblocken i prisma/schema.prisma och apps/api/src/accounting/closed-period.ts
-- för varför `seq` (och inte createdAt) avgör vilken händelse som är den senaste.

-- CreateEnum
CREATE TYPE "AccountingPeriodEventType" AS ENUM ('CLOSED', 'REOPENED');

-- CreateTable
CREATE TABLE "AccountingPeriodEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "AccountingPeriodEventType" NOT NULL,
    "actorType" "EventActorType" NOT NULL,
    "actorUserId" TEXT,
    "actorLabel" TEXT,
    "reason" TEXT,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingPeriodEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Ett enda index gör två jobb:
--
--  (1) SERIALISERINGEN: två samtidiga stängningar av samma period beräknar båda
--      seq = N+1 → den ena får P2002 och förlorar. Exakt samma skydd som det
--      unika indexet (organizationId, year, month) gav på ClosedAccountingPeriod.
--
--  (2) DEN HETA FRÅGAN: "senaste händelsen för perioden", som allocate ställer i
--      varje verifikationstransaktion. Verifierat med EXPLAIN att Postgres löser
--      `WHERE org/year/month ORDER BY seq DESC LIMIT 1` med en BAKÅTSCAN av det
--      här indexet — och att den väljer det även när ett dedikerat DESC-index
--      ligger bredvid. Ett separat DESC-index vore alltså ren skrivkostnad.
CREATE UNIQUE INDEX "AccountingPeriodEvent_organizationId_year_month_seq_key" ON "AccountingPeriodEvent"("organizationId", "year", "month", "seq");

-- AddForeignKey
-- RESTRICT, aldrig CASCADE: raderna är räkenskapsinformation och får inte
-- försvinna med sin organisation.
ALTER TABLE "AccountingPeriodEvent" ADD CONSTRAINT "AccountingPeriodEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingPeriodEvent" ADD CONSTRAINT "AccountingPeriodEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Invarianter på DB-nivå ──────────────────────────────────────────────────
-- Applikationslagret validerar redan detta, men en CHECK gäller ÄVEN för ett
-- framtida internt skript, en migrering eller ett manuellt DB-ingrepp. Skälet
-- till en återöppning är den del av historiken som gör loggen läsbar i
-- efterhand — den får inte kunna utelämnas via en sidodörr.
ALTER TABLE "AccountingPeriodEvent"
    ADD CONSTRAINT "AccountingPeriodEvent_reopened_requires_reason"
    CHECK ("type" <> 'REOPENED' OR ("reason" IS NOT NULL AND length(btrim("reason")) >= 10));

-- summary är stängningens ögonblicksbild — en återöppning har ingen att ta.
ALTER TABLE "AccountingPeriodEvent"
    ADD CONSTRAINT "AccountingPeriodEvent_reopened_has_no_summary"
    CHECK ("type" <> 'REOPENED' OR "summary" IS NULL);

-- seq är 1-baserad och monoton; 0/negativa värden vore en trasig allokering.
ALTER TABLE "AccountingPeriodEvent"
    ADD CONSTRAINT "AccountingPeriodEvent_seq_positive"
    CHECK ("seq" >= 1);

-- ── Backfill: befintligt stängt tillstånd → CLOSED-händelser ────────────────
-- Varje rad i ClosedAccountingPeriod blir periodens FÖRSTA händelse (seq = 1).
--
-- createdAt = radens URSPRUNGLIGA closedAt, aldrig migreringstidpunkten: NÄR en
-- period stängdes är en del av historiken, och att stämpla om den vore att
-- påstå något annat än det som hände.
--
-- Aktör: closedById saknas (äldre rader / AI-vägen innan fältet fanns) →
-- SYSTEM med en uttrycklig etikett. Vi fabricerar ALDRIG en användare som inte
-- stod i den ursprungliga raden.
INSERT INTO "AccountingPeriodEvent" (
    "id", "organizationId", "year", "month", "seq", "type",
    "actorType", "actorUserId", "actorLabel", "reason", "summary", "createdAt"
)
SELECT
    gen_random_uuid()::text,
    c."organizationId",
    c."year",
    c."month",
    1,
    'CLOSED'::"AccountingPeriodEventType",
    CASE WHEN c."closedById" IS NULL THEN 'SYSTEM'::"EventActorType" ELSE 'USER'::"EventActorType" END,
    c."closedById",
    CASE WHEN c."closedById" IS NULL THEN 'Migrerad — ursprunglig aktör okänd' ELSE NULL END,
    NULL,
    c."summary",
    c."closedAt"
FROM "ClosedAccountingPeriod" c;

-- ── Verifiering: falla högljutt, aldrig gissa ───────────────────────────────
-- Efter den här migrationen härleds "är perioden stängd?" ENBART ur händelserna.
-- En backfill som tappar en rad öppnar därför en stängd bokföringsperiod TYST —
-- den värsta enskilda utgången i hela ändringen. Hellre en migration som stannar
-- deployen än en som gissar.
DO $$
DECLARE
    legacy_count BIGINT;
    event_count  BIGINT;
BEGIN
    SELECT COUNT(*) INTO legacy_count FROM "ClosedAccountingPeriod";
    SELECT COUNT(*) INTO event_count  FROM "AccountingPeriodEvent" WHERE "type" = 'CLOSED';

    IF legacy_count <> event_count THEN
        RAISE EXCEPTION
            'Backfill av AccountingPeriodEvent ofullstandig: % rader i ClosedAccountingPeriod men % CLOSED-handelser skapade. Migrationen avbryts — en tappad rad hade oppnat en stangd bokforingsperiod tyst.',
            legacy_count, event_count;
    END IF;
END $$;
