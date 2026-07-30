-- CreateTable
CREATE TABLE "FreeAccessEmail" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "note" TEXT,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreeAccessEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreeAccessAudit" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreeAccessAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FreeAccessEmail_email_key" ON "FreeAccessEmail"("email");

-- CreateIndex
CREATE INDEX "FreeAccessAudit_email_idx" ON "FreeAccessAudit"("email");

-- CreateIndex
CREATE INDEX "FreeAccessAudit_createdAt_idx" ON "FreeAccessAudit"("createdAt");

