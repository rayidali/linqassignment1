-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "chatId" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'video';

-- CreateIndex
CREATE INDEX "Job_chatId_createdAt_idx" ON "Job"("chatId", "createdAt");
