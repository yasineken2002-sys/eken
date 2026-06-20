-- Beräkningsgrund (JB 12:19): fri dokumentationstext per tariff om hur
-- vidaredebiteringen beräknas. Rent additiv, nullable kolumn — befintliga
-- tariff-rader och -anrop är oförändrade. Ingår aldrig i charge-/bokföringskalkyl.
ALTER TABLE "ConsumptionTariff" ADD COLUMN "calculationBasis" TEXT;
