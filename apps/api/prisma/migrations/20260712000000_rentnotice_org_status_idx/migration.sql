-- T4/#47 PR2 — riktat kompositindex för dashboardens "Försenat belopp"
-- (WHERE organizationId AND status=OVERDUE) + kravtrappans status-per-org-filter.
-- CreateIndex
CREATE INDEX "RentNotice_organizationId_status_idx" ON "RentNotice"("organizationId", "status");
