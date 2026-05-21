-- Ny notistyp för den AI-genererade månadsrapporten (PDF). Eget värde så
-- frontend kan ge den egen ikon, i linje med MORNING_INSIGHT/WEEKLY_SUMMARY.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MONTHLY_REPORT';
