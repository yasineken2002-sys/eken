-- AlterEnum: transient lås-status som hindrar dubbel-create vid samtidiga godkännanden
ALTER TYPE "ContractImportRowStatus" ADD VALUE 'COMMITTING';
