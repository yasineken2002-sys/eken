-- Egen roll för kundens uttryckligt valda tillgodoskuldkonto.
-- Ingen kontomappning skapas och ingen befintlig revision ändras.
ALTER TYPE "FortnoxAccountRole" ADD VALUE 'KUNDTILLGODOSKULD';
