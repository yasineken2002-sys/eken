-- #648: två markörer för en avi som fastnat i kravtrappan.
--
-- blockedSince      periodens BÖRJAN (första blockeringen), nollställs när avin
--                   lämnar blockerat läge. Behövs därför att den befintliga
--                   blockeringsanteckningen skrivs varje dygn — "senaste
--                   blockering" är alltid ~i dag och mäter inte hur länge
--                   ärendet stått still.
-- blockedAlertedAt  larmets idempotensmarkör, ETT larm per period. Samma form
--                   som Organization.paymentDataStaleAlertedAt.
--
-- Båda nullbara med flit: NULL betyder "inte blockerad / inte larmad", och det
-- är rätt värde för varje befintlig rad. Ingen backfill.
ALTER TABLE "RentNotice" ADD COLUMN     "blockedAlertedAt" TIMESTAMP(3),
ADD COLUMN     "blockedSince" TIMESTAMP(3);
