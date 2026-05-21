-- Nya notistyper för AI-genererade rapporter: daglig morgonrapport och
-- veckosammanfattning. Egna värden (i stället för SYSTEM) så frontend kan
-- ge dem egen ikon och så att sentinel-låsen inte blandas ihop med de
-- användarsynliga notiserna.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MORNING_INSIGHT';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WEEKLY_SUMMARY';
