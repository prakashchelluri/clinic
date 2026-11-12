-- A patient's advance: money taken before there is a bill for it. Deposits are payment rows with advance = true (positive),
-- using it is a negative advance row with method 'advance' plus the same amount on the invoice with method 'advance'.
-- The day's money skips method 'advance': the cash was counted the day the advance came in.
ALTER TABLE "payment" ADD COLUMN "advance" boolean DEFAULT false NOT NULL;
