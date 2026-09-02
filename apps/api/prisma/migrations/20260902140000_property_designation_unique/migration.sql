-- FASTIGHETSBETECKNINGEN ÄR UNIK PER ORGANISATION.
--
-- `Property` hade inga unika villkor alls, och `PropertiesService.create` skrev
-- rakt igenom utan en enda kontroll. En omkörning av AI-verktyget
-- `create_property` gav därför en andra fastighet med samma beteckning.
--
-- Beteckningen identifierar fastigheten i det offentliga registret: två olika
-- fastigheter kan aldrig legitimt dela den. Det är skillnaden mot `name`, som är
-- ett vardagsnamn och mycket väl kan återkomma — och skälet till att den här
-- nyckeln inte kan bli för grov.
--
-- INGEN STÄDNING BEHÖVS. Mätt före migrationen: dev 19 fastigheter / 19 unika
-- (org, beteckning) / 0 tomma; prod 2 / 2 / 0. Skulle en dubblett ändå finnas
-- FALLER migrationen, och det är rätt utfall — två rader som påstår sig vara
-- samma fastighet är ett faktum någon måste titta på.
CREATE UNIQUE INDEX "Property_organizationId_propertyDesignation_key"
  ON "Property"("organizationId", "propertyDesignation");
