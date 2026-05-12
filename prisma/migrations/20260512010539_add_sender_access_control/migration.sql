-- CreateTable
CREATE TABLE "Sender" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "service" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_opt_in',
    "optedInAt" TIMESTAMP(3),
    "lastVideoAt" TIMESTAMP(3),
    "videosToday" INTEGER NOT NULL DEFAULT 0,
    "videosTodayDate" TEXT,
    "totalVideos" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sender_handle_key" ON "Sender"("handle");

-- CreateIndex
CREATE INDEX "Job_type_createdAt_idx" ON "Job"("type", "createdAt");
