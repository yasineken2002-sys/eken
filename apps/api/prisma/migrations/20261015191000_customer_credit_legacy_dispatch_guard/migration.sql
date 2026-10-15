-- Även den äldre utskicksvägens beständiga NOTICE-claim fryser underlaget.
-- Den saknar dispatchKey, men kan redan ha överlämnats till mejlleverantören.
CREATE OR REPLACE FUNCTION customer_credit_application_dispatch_guard() RETURNS trigger AS $$
BEGIN
  PERFORM id FROM "RentNotice" WHERE id = NEW."rentNoticeId" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "RentNoticeSend"
    WHERE "rentNoticeId" = NEW."rentNoticeId" AND "kind" = 'NOTICE'
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_NOTICE_ALREADY_PREPARED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
