-- Inkasso · PR 3 — dröjsmålsränta (referensränta + 8 pp, bokförd 1510/8131).
--
-- Lägger fälten som bär ackumulerad dröjsmålsränta på en hyresavi:
--   • interestAccruedAmount  — kumulativt bokfört räntebelopp (1510 D / 8131 K).
--   • interestAccruedThrough — datumet räntan är beräknad t.o.m.
--
-- Räntan beräknas dynamiskt ur ReferenceInterestRate (det halvår avin avser) +
-- 8 procentenheter (räntelagen 1975:635 6 §) och kristalliseras inkrementellt vid
-- bestämda punkter (påminnelse, inkasso-ready). Default 0 → noll påverkan på
-- befintliga avier. Räntan ingår INTE i betalbar total (rentNoticePayableTotal) —
-- den är en separat, kontinuerligt löpande fordran som regleras vid slutuppgörelse.

ALTER TABLE "RentNotice" ADD COLUMN     "interestAccruedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "interestAccruedThrough" TIMESTAMP(3);
