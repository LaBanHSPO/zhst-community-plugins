PRAGMA foreign_keys = ON;

-- Manager-authorized discounts and refunds on manual bills. Kept separate from
-- SePay payment attempts; a settled bill is never edited in place.
ALTER TABLE rc_bills ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rc_bills ADD COLUMN discount_reason TEXT;
ALTER TABLE rc_bills ADD COLUMN amount INTEGER;
ALTER TABLE rc_bills ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rc_refunds (
	id TEXT PRIMARY KEY,
	branch_id TEXT NOT NULL REFERENCES rc_branches(id),
	bill_id TEXT NOT NULL REFERENCES rc_bills(id),
	shift_id TEXT REFERENCES rc_shifts(id),
	amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 9000000000000),
	method TEXT NOT NULL CHECK(method IN ('cash','bank_transfer')),
	reason TEXT NOT NULL,
	created_by TEXT,
	created_at INTEGER NOT NULL,
	version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS rc_refunds_bill ON rc_refunds(bill_id,id);
CREATE INDEX IF NOT EXISTS rc_refunds_branch ON rc_refunds(branch_id,id);
CREATE INDEX IF NOT EXISTS rc_refunds_shift ON rc_refunds(shift_id,method);
