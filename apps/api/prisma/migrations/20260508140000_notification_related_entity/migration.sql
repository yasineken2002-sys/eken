-- Notifications: lägg till strukturerad referens till relaterad entitet (typ + id),
-- så att frontend kan navigera till rätt detaljvy när användaren klickar.
-- Befintliga rader får NULL och förblir klickbara via det äldre `link`-fältet
-- om backend hinner backfilla dem.
ALTER TABLE "Notification"
  ADD COLUMN "relatedEntityType" TEXT,
  ADD COLUMN "relatedEntityId" TEXT;
