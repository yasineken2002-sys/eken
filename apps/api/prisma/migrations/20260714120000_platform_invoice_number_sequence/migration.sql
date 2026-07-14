-- Atomär, race-säker nummerserie för PLATTFORMS-fakturor.
--
-- Tidigare allokerades numret med count()+1 (nextInvoiceNumber) UTANFÖR
-- fakturans transaktion → två samtidiga faktureringar (manuell "kör nu" som
-- krockar med månads-cronen, eller flera API-instanser) kunde räkna fram SAMMA
-- nummer → P2002 på invoiceNumber-unikheten, och P2002-hanteringen kunde
-- feltolka det som en benign period-idempotens-race och tyst hoppa över = tyst
-- utebliven fakturering. Denna tabell (en rad per serie/"scope") allokerar
-- numret via UPSERT med atomär increment inuti fakturans transaktion → Postgres
-- row-lock serialiserar samtidiga allokeringar och två fakturor kan aldrig få
-- samma nummer. Speglar InvoiceNumberSequence (org-fakturor) men plattformsglobal
-- (ingen organizationId — Eveno är avsändaren).

CREATE TABLE "PlatformInvoiceNumberSequence" (
    "scope" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformInvoiceNumberSequence_pkey" PRIMARY KEY ("scope")
);

-- Seed: initiera varje befintlig serie till det HÖGSTA redan använda numret så
-- att nästa allokering blir max+1 (aldrig 1 → skulle kollidera med en befintlig
-- faktura). "scope" = allt före sista bindestrecket (PLT-2026 / CR-202607),
-- numret = heltalet efter sista bindestrecket. Alla plattforms-fakturanummer har
-- formen {scope}-{nollutfyllt heltal} (PLT-{år}-{nnnnn}, CR-{åååmm}-{nnnn}).
INSERT INTO "PlatformInvoiceNumberSequence" ("scope", "lastNumber", "updatedAt")
SELECT
    regexp_replace("invoiceNumber", '-[^-]*$', '')                       AS "scope",
    MAX(CAST(regexp_replace("invoiceNumber", '^.*-', '') AS INTEGER))    AS "lastNumber",
    NOW()
FROM "PlatformInvoice"
WHERE "invoiceNumber" ~ '^.+-[0-9]+$'
GROUP BY regexp_replace("invoiceNumber", '-[^-]*$', '');
