-- T1.3b — kontinuitetsmarkör: hyresförhållandets faktiska början.
--
-- Flera JB-regler räknar på HELA hyresförhållandets sammanlagda tid, inte det
-- enskilda avtalet: JB 12 kap 3 § 2 st (niomånadersregeln — bestämd tid måste
-- alltid sägas upp om hyresförhållandet varat >9 mån i följd), 8 § 1 st
-- (skriftlig uppsägning när förhållandet varat >3 mån i följd), 46 § p 9
-- (3-årsgränsen), 55 e § (1 år). [⚖️ lagrum att verifiera mot lagtext vid
-- juridisk slutgenomgång — förklarande, ingen SQL-logik beror på numren.]
-- Varje förnyelse skapar ett nytt Lease med nytt
-- startDate (oldEnd+1) → utan denna markör nollställs "klockan" tyst och
-- hyresgästen kan UNDERSKYDDAS. tenancyStartDate ärvs oförändrat genom
-- förnyelser (LEASE_SUCCESSION_CARRY_FIELDS). Invariant: tenancyStartDate <=
-- startDate alltid → osäkerhet ger MER varaktighet/skydd, aldrig mindre.

-- Steg 1: lägg till som nullable så backfillen kan köra på befintliga rader.
ALTER TABLE "Lease" ADD COLUMN "tenancyStartDate" DATE;

-- Steg 2: KEDJE-MEDVETEN backfill. T1.2/T1.3-förnyelseflödet har redan varit i
-- drift, så en del befintliga avtal ÄR successorer med en identifierbar
-- föregångare i samma databas (samma org+enhet+hyresgäst, startDate = föregående
-- avtals endDate + 1 dag). En naiv "tenancyStartDate = startDate"-backfill skulle
-- ge dessa successorer sitt EGET (nya) startDate = exakt den tysta nollställning
-- funktionen ska förhindra. Vi följer därför adjacenskedjan bakåt till roten och
-- sätter HELA kedjans tenancyStartDate = rotens startDate.
--
-- Adjacens = strukturellt samma signal som T1.3:s succession använder (renew
-- sätter newStart = oldEnd+1, oförändrat unitId/tenantId). endDate + 1 använder
-- heltalsaddition på DATE (ger DATE). Datum ökar strikt bakåt i kedjan → inga
-- cykler. Vid en (patologisk) förgrening väljs MIN(rot) = äldsta = säker riktning.
WITH RECURSIVE
  -- Rötter: avtal UTAN föregångare (ingen adjacent tidigare rad).
  roots AS (
    SELECT
      l.id,
      l."startDate" AS root_start,
      l."organizationId",
      l."unitId",
      l."tenantId",
      l."endDate"
    FROM "Lease" l
    WHERE NOT EXISTS (
      SELECT 1
      FROM "Lease" p
      WHERE p."organizationId" = l."organizationId"
        AND p."unitId" = l."unitId"
        AND p."tenantId" = l."tenantId"
        AND p."endDate" IS NOT NULL
        AND p."endDate" + 1 = l."startDate"
        AND p.id <> l.id
    )
  ),
  chain AS (
    SELECT id, root_start, "organizationId", "unitId", "tenantId", "endDate"
    FROM roots
    UNION ALL
    SELECT
      succ.id,
      c.root_start,
      succ."organizationId",
      succ."unitId",
      succ."tenantId",
      succ."endDate"
    FROM chain c
    JOIN "Lease" succ
      ON succ."organizationId" = c."organizationId"
     AND succ."unitId" = c."unitId"
     AND succ."tenantId" = c."tenantId"
     AND c."endDate" IS NOT NULL
     AND succ."startDate" = c."endDate" + 1
     AND succ.id <> c.id
  )
UPDATE "Lease" l
SET "tenancyStartDate" = sub.root_start
FROM (
  SELECT id, MIN(root_start) AS root_start
  FROM chain
  GROUP BY id
) sub
WHERE l.id = sub.id;

-- Fallback (defensiv): rader som ingen kedja täckte (ska inte hända — varje rad
-- är minst sin egen rot) sätts till eget startDate.
UPDATE "Lease" SET "tenancyStartDate" = "startDate" WHERE "tenancyStartDate" IS NULL;

-- Steg 3: hårdna till NOT NULL — en successor MÅSTE bära föregångarens värde,
-- ett original MÅSTE sätta = startDate. Ingen tyst NULL som skulle kunna falla
-- tillbaka på fel (nyare) datum = underskydd.
ALTER TABLE "Lease" ALTER COLUMN "tenancyStartDate" SET NOT NULL;
