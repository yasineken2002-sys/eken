-- FS1 (FORTNOX-100, BYGGLEDARE-OVERGANG-016): proveniensmarkör för BgMax-radens datum.
-- Nullable utan default och utan backfill: befintliga rader och äldre skrivare blir NULL
-- (okänd/äldre proveniens). Bara den nya tolken skriver 'TK15'.

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN "bgmaxDateSource" TEXT;
