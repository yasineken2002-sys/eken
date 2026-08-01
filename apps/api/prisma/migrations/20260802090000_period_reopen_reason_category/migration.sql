-- Orsakskategori för återöppning av bokföringsperiod (T5 PR1c).
--
-- Kategorin är den ENDA punkten i hela återöppningskedjan som skiljer "får" från
-- "får inte": EXISTING_ENTRY_INCORRECT avvisas innan någon händelse skrivs,
-- MISSING_ENTRY släpps igenom. Därför är den en riktig kolumn och inte en del av
-- fritextskälet — fritext går inte att grinda pålitligt mot, och gör det omöjligt
-- att i efterhand svara på hur många återöppningar som skedde av vilken orsak.
--
-- `reason` (PR1b, CHECK >= 10 tecken) bär den mänskliga förklaringen bredvid.
-- Se docblocken i prisma/schema.prisma och accounting-period.service.ts.

-- CreateEnum
CREATE TYPE "AccountingPeriodEventReasonCategory" AS ENUM ('MISSING_ENTRY', 'EXISTING_ENTRY_INCORRECT');

-- AlterTable
-- NULLABLE: PR1b:s befintliga CLOSED-händelser (inkl. de backfillade) har ingen
-- kategori och ska inte ha någon. Att lägga till kolumnen rör därför ingen rad.
ALTER TABLE "AccountingPeriodEvent" ADD COLUMN "reasonCategory" "AccountingPeriodEventReasonCategory";

-- ── Invarianter på DB-nivå ──────────────────────────────────────────────────
-- Samma resonemang som PR1b:s CHECK på `reason`: applikationslagret validerar
-- redan, men en CHECK gäller ÄVEN för ett framtida internt skript, en migrering
-- eller ett manuellt DB-ingrepp. Kategorin är grindens hela grund — den får inte
-- kunna utelämnas via en sidodörr, och den får inte kunna smyga in på en
-- stängning där den skulle vara meningslös och vilseledande.

-- En återöppning MÅSTE ha en kategori.
ALTER TABLE "AccountingPeriodEvent"
    ADD CONSTRAINT "AccountingPeriodEvent_reopened_requires_category"
    CHECK ("type" <> 'REOPENED' OR "reasonCategory" IS NOT NULL);

-- En stängning får ALDRIG ha en. (CLOSED-grenen har ingen orsak att kategorisera
-- — den är den normala gången, inte en avvikelse.)
ALTER TABLE "AccountingPeriodEvent"
    ADD CONSTRAINT "AccountingPeriodEvent_closed_has_no_category"
    CHECK ("type" <> 'CLOSED' OR "reasonCategory" IS NULL);
