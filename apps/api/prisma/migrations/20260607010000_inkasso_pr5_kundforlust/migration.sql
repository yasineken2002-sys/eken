-- Inkasso PR 5 — kundförlust (befarad → konstaterad). Sluter skuld-sidans
-- bokföringscykel: en obetald, inkasso-redo MOMSFRI hyresfordran klassas först
-- som osäker (befarad, 1515 D / 1510 K) och skrivs sedan av som konstaterad
-- förlust (6352 D / 1515 K).
--
-- probableLossAt: markör för att befarad omklassning är gjord. Sätts ATOMISKT med
--   omklassningsverifikatet. Nullbar, ingen backfill (befintliga avier är ej
--   befarade). Driver cron + grind: konstaterad bortskrivning kräver att avin
--   först befarats (fordran ligger på 1515).
ALTER TABLE "RentNotice" ADD COLUMN "probableLossAt" TIMESTAMP(3);
