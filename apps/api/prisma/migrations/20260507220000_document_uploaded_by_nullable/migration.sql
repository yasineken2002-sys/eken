-- Document.uploadedById nullable.
--
-- Bakgrund: kontrakts-PDF:er som genereras autonomt av Bull-jobben
-- (lease-activation worker) eller av framtida cron behöver inte ha en
-- mänsklig "uploader" knuten till sig — det är systemet som lagrar.
-- Tidigare tvingade NOT NULL oss att gata enqueueGenerateContract på
-- en närvarande actorUserId, vilket i sin tur orsakade att kontrakts-
-- PDF:er aldrig genererades när AI-toolet skapade ett ACTIVE-lease utan
-- att passera transitionStatus.
--
-- Befintliga rader bevaras (alla har uploadedById satt). Endast nya
-- system-genererade dokument kommer ha NULL.

ALTER TABLE "Document" ALTER COLUMN "uploadedById" DROP NOT NULL;
