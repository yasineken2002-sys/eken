-- BANKIMPORTENS MÅLKONTO (#F034c)
--
-- #F034b stängde filnivåns idempotens men lämnade EN gräns uttryckligen
-- oredovisad som löst: "organisationen" var det grövsta mål systemet kunde
-- uttrycka. Följden stod i leveransens kända gränser: två VERKLIGA betalningar
-- med identiska fält på OLIKA konton i samma organisation var oskiljbara, och
-- den andra räknades som dubblett. Samma tysta förlust som #F034b tar bort
-- INOM ett konto, kvarstående MELLAN konton.
--
-- Den här migrationen inför målkontot i datamodellen.

-- ── 1. MÅLKONTOT ────────────────────────────────────────────────────────────
--
-- MINSTA NÖDVÄNDIGA, inte en kontoentitet: inget saldo, ingen bankkoppling,
-- ingen synk. Se docblocket i schema.prisma för varför Organization.bankgiro,
-- BankConsent och Account alla förkastades som bärare.
--
-- `name` är unikt per organisation därför att det är DET operatören väljer på
-- när filen saknar säker kontoidentitet. Två konton med samma namn gör valet
-- till en gissning.
--
-- `accountNumber` är VALFRITT och används för KONTROLL, aldrig för VAL.
CREATE TABLE "BankAccount" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "accountNumber" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankAccount_organizationId_name_key"
  ON "BankAccount" ("organizationId", "name");
CREATE INDEX "BankAccount_organizationId_idx" ON "BankAccount" ("organizationId");

-- Restrict speglar BankTransaction: ett konto med räkenskapsinformation under
-- sig får inte försvinna med organisationen utan att någon tagit ställning.
ALTER TABLE "BankAccount"
  ADD CONSTRAINT "BankAccount_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 2. MÅLKONTOT PÅ BANKRADEN ───────────────────────────────────────────────
--
-- NULLBART, OCH UTAN DEFAULT. Det är hela poängen.
--
-- INGEN BACKFILL, OCH INGEN PÅHITTAD KONTOTILLHÖRIGHET. En historisk rad säger
-- inte vilket konto pengarna kom in på, och det går inte att räkna fram i
-- efterhand: filen som skapade raden finns inte kvar, och organisationen kan ha
-- haft flera konton hela tiden. Att stämpla dem med ett "standardkonto" hade
-- varit att skriva in ett påstående ingen kan belägga — och värre, att göra
-- gränsen osynlig för den som läser raden sen.
--
-- NULL betyder därför KONTOT ÄR OKÄNT. Vad importen gör när en ny rad krockar
-- med en sådan står i punkt 3.
ALTER TABLE "BankTransaction" ADD COLUMN "bankAccountId" TEXT;

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "BankTransaction_bankAccountId_idx" ON "BankTransaction" ("bankAccountId");

-- ── 3. NÄR IDENTITETEN INTE GÅR ATT AVGÖRA ──────────────────────────────────
--
-- En ny rad kan matcha en KONTOLÖS historisk rad i allt filen bär. Frågan "är
-- det samma betalning?" saknar då svar, eftersom den historiska raden inte
-- säger vilket konto den kom in på.
--
-- Båda de enkla utvägarna är fel:
--
--   räkna som dubblett     → en verklig betalning kastas TYST bort
--   skapa och auto-matcha  → dubbel allokering och dubbel bokföring, med en
--                            säkerhet systemet inte har
--
-- Raden LAGRAS (betalningen får inte försvinna) men auto-matchas ALDRIG: den
-- förblir UNMATCHED och en människa avgör. Importsvaret räknar dem separat så
-- utfallet syns i stället för att gömma sig bland dubbletterna.
ALTER TABLE "BankTransaction" ADD COLUMN "identityReviewAt" TIMESTAMP(3);
ALTER TABLE "BankTransaction" ADD COLUMN "identityReviewReason" TEXT;

CREATE INDEX "BankTransaction_organizationId_identityReviewAt_idx"
  ON "BankTransaction" ("organizationId", "identityReviewAt");

-- ── 4. MÅLKONTOT PÅ IMPORTFÖRSÖKET ──────────────────────────────────────────
--
-- Kontot ingår i `fingerprint`, så samma fil mot TVÅ konton är två skilda
-- importer och blockerar inte varandra. Kolumnen lagras därutöver för att en
-- granskare ska kunna se vilket konto ett försök gällde utan att räkna om en
-- hash.
--
-- Nullbart bara för historikens skull: försöksrader skrivna av #F034b saknar
-- konto. Varje NY rad sätter det.
ALTER TABLE "BankImportAttempt" ADD COLUMN "bankAccountId" TEXT;

-- CASCADE, till skillnad från BankTransaction.bankAccountId ovan. Raden är en
-- DRIFTKVITTENS: är kontot borta är frågan "har filen redan importerats mot det
-- kontot?" meningslös. Bankraderna ÄR räkenskapsinformation och har Restrict.
ALTER TABLE "BankImportAttempt"
  ADD CONSTRAINT "BankImportAttempt_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "BankImportAttempt_bankAccountId_idx" ON "BankImportAttempt" ("bankAccountId");

-- ── VAD MIGRATIONEN INTE GÖR ────────────────────────────────────────────────
--
-- Den skapar INGA konton. En organisation som ska importera måste först lägga
-- upp ett namngivet konto. Att skapa ett "standardkonto" per organisation och
-- välja det automatiskt hade återinfört exakt det uppdraget förbjuder:
-- organisationen använd som om den vore ett bankkonto, fast med ett nytt namn.
--
-- Den rör INGEN befintlig rad. Ingen backfill, ingen historikläkning.
