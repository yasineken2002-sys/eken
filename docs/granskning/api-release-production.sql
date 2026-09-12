-- SELECT-satser utförda 2026-09-12 15:01 UTC. Inga anslutningsuppgifter.
-- Transaktionsramen återger motsvarande psycopg2-/anslutningsinställningar.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

-- server
SELECT current_database(), current_setting('server_version'), pg_is_in_recovery(), current_setting('transaction_read_only'), txid_current_snapshot()::text, transaction_timestamp(), current_setting('statement_timeout'), current_setting('lock_timeout');

-- migrations
SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations" ORDER BY started_at, migration_name;

-- relation_sizes
SELECT c.relname,c.relkind,c.reltuples::bigint AS estimated_rows,pg_relation_size(c.oid),pg_indexes_size(c.oid),pg_total_relation_size(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['Organization','Meter','MeterReading','ConsumptionCharge','MeterReadingReview','ConsumptionChargeCheck','Invoice','RentNotice','RentNoticeLine','DeliveryDocument','DeliveryDecision','DeliveryMember','DeliveryEvent','DeliveryPrincipal','DeliveryDispatch','DeliveryObservation']) ORDER BY c.relname;

-- index_sizes
SELECT t.relname,i.relname,pg_relation_size(i.oid),x.indisvalid,x.indisready,x.indisunique FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=ANY(ARRAY['Organization','Meter','MeterReading','ConsumptionCharge','MeterReadingReview','ConsumptionChargeCheck','Invoice','RentNotice','RentNoticeLine','DeliveryDocument','DeliveryDecision','DeliveryMember','DeliveryEvent','DeliveryPrincipal','DeliveryDispatch','DeliveryObservation']) ORDER BY t.relname,i.relname;

-- count_Organization
SELECT count(*) FROM "Organization";

-- count_Meter
SELECT count(*) FROM "Meter";

-- count_MeterReading
SELECT count(*) FROM "MeterReading";

-- count_ConsumptionCharge
SELECT count(*) FROM "ConsumptionCharge";

-- count_Invoice
SELECT count(*) FROM "Invoice";

-- count_RentNotice
SELECT count(*) FROM "RentNotice";

-- count_RentNoticeLine
SELECT count(*) FROM "RentNoticeLine";

-- duplicate_org_id_MeterReading
SELECT count(*) FROM (SELECT "organizationId",id FROM "MeterReading" GROUP BY "organizationId",id HAVING count(*)>1) d;

-- duplicate_org_id_ConsumptionCharge
SELECT count(*) FROM (SELECT "organizationId",id FROM "ConsumptionCharge" GROUP BY "organizationId",id HAVING count(*)>1) d;

-- duplicate_org_id_Invoice
SELECT count(*) FROM (SELECT "organizationId",id FROM "Invoice" GROUP BY "organizationId",id HAVING count(*)>1) d;

-- duplicate_org_id_RentNotice
SELECT count(*) FROM (SELECT "organizationId",id FROM "RentNotice" GROUP BY "organizationId",id HAVING count(*)>1) d;

-- orphan_reading_org
SELECT count(*) FROM "MeterReading" r LEFT JOIN "Organization" o ON o.id=r."organizationId" WHERE o.id IS NULL;

-- orphan_charge_reading
SELECT count(*) FROM "ConsumptionCharge" c LEFT JOIN "MeterReading" r ON r.id=c."meterReadingId" WHERE r.id IS NULL;

-- cross_org_charge_reading
SELECT count(*) FROM "ConsumptionCharge" c JOIN "MeterReading" r ON r.id=c."meterReadingId" WHERE r."organizationId"<>c."organizationId";

-- constraints
SELECT c.conrelid::regclass::text,c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.connamespace='public'::regnamespace AND c.conrelid::regclass::text=ANY(ARRAY['"Organization"','"Meter"','"MeterReading"','"ConsumptionCharge"','"MeterReadingReview"','"ConsumptionChargeCheck"','"Invoice"','"RentNotice"','"RentNoticeLine"','"DeliveryDocument"','"DeliveryDecision"','"DeliveryMember"','"DeliveryEvent"','"DeliveryPrincipal"','"DeliveryDispatch"','"DeliveryObservation"']) ORDER BY 1,2;

-- append_only_function
SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='append_only_guard';

-- locks
SELECT l.locktype,l.mode,l.granted,count(*) FROM pg_locks l WHERE l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) GROUP BY 1,2,3 ORDER BY 1,2,3;

-- long_transactions
SELECT state,wait_event_type,count(*),max(extract(epoch from clock_timestamp()-xact_start))::numeric(14,3),max(cardinality(pg_blocking_pids(pid))) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start<clock_timestamp()-interval '30 seconds' GROUP BY state,wait_event_type ORDER BY 1,2;

-- activity_visibility
SELECT count(*),count(*) FILTER(WHERE state IS NULL),count(*) FILTER(WHERE cardinality(pg_blocking_pids(pid))>0) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();

ROLLBACK;
-- Saknade tabeller räknades inte. Tablå/katalog kontrollerades före COUNT.
