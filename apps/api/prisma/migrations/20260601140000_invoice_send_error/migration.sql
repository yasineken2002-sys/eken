-- Synligt fel vid misslyckat faktura-utskick (mirror av RentNotice.sendError).
-- Statusen förblir DRAFT; detta fält + SEND_FAILED-event gör felet synligt i UI.
ALTER TABLE "Invoice" ADD COLUMN "sendError" TEXT;
