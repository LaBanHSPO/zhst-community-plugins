PRAGMA foreign_keys = ON;

-- Cashier shifts (ca). Exactly one open shift per branch carries the drawer.
CREATE TABLE IF NOT EXISTS rc_shifts (
	id TEXT PRIMARY KEY,
	branch_id TEXT NOT NULL REFERENCES rc_branches(id),
	status TEXT NOT NULL CHECK(status IN ('open','closed')),
	opened_by TEXT,
	opened_at INTEGER NOT NULL,
	closed_by TEXT,
	closed_at INTEGER,
	opening_float INTEGER NOT NULL DEFAULT 0 CHECK(opening_float BETWEEN 0 AND 9000000000000),
	expected_cash INTEGER,
	counted_cash INTEGER,
	variance INTEGER,
	note TEXT NOT NULL DEFAULT '',
	version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS rc_shift_active ON rc_shifts(branch_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS rc_shifts_branch ON rc_shifts(branch_id,id);

-- A bill freezes the confirmed, unbilled orders of one visit into a single
-- payable amount using one method. Additional orders produce a new bill.
CREATE TABLE IF NOT EXISTS rc_bills (
	id TEXT PRIMARY KEY,
	branch_id TEXT NOT NULL REFERENCES rc_branches(id),
	visit_id TEXT NOT NULL REFERENCES rc_visits(id),
	shift_id TEXT REFERENCES rc_shifts(id),
	status TEXT NOT NULL CHECK(status IN ('open','settled','void')),
	method TEXT CHECK(method IN ('cash','bank_transfer')),
	reference TEXT,
	total INTEGER NOT NULL CHECK(total BETWEEN 0 AND 9000000000000),
	created_by TEXT,
	created_at INTEGER NOT NULL,
	settled_by TEXT,
	settled_at INTEGER,
	version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS rc_bill_open ON rc_bills(visit_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS rc_bills_branch ON rc_bills(branch_id,id);
CREATE INDEX IF NOT EXISTS rc_bills_shift ON rc_bills(shift_id,status);

CREATE TABLE IF NOT EXISTS rc_bill_lines (
	id TEXT PRIMARY KEY,
	bill_id TEXT NOT NULL REFERENCES rc_bills(id),
	order_id TEXT NOT NULL REFERENCES rc_orders(id),
	name TEXT NOT NULL,
	quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 100),
	unit_price INTEGER NOT NULL CHECK(unit_price BETWEEN 0 AND 9000000000000),
	tax_rate INTEGER NOT NULL CHECK(tax_rate BETWEEN 0 AND 10000),
	total INTEGER NOT NULL CHECK(total BETWEEN 0 AND 9000000000000)
);
CREATE INDEX IF NOT EXISTS rc_bill_lines_bill ON rc_bill_lines(bill_id,id);

-- Once an order is frozen into a bill it is locked and a settled bill is immutable.
ALTER TABLE rc_orders ADD COLUMN bill_id TEXT REFERENCES rc_bills(id);
CREATE INDEX IF NOT EXISTS rc_orders_bill ON rc_orders(bill_id);
