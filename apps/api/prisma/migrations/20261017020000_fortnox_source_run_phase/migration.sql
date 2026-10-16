-- Egen migration: det nya enumvärdet måste committas innan nästa migration
-- använder det i CHECK/trigger. Ingen befintlig rad får ett nytt fasvärde här.
ALTER TYPE "FortnoxReadPhase" ADD VALUE 'SOURCE_CAPTURED';
