-- CreateTable
CREATE TABLE "ProcessedOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orderId" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedOrder_orderId_key" ON "ProcessedOrder"("orderId");
