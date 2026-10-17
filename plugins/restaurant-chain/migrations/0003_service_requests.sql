PRAGMA foreign_keys = ON;

-- Guest service calls. A guest can request a waiter or the bill from the table;
-- at most one open request of each kind exists per visit until staff handle it.
CREATE TABLE IF NOT EXISTS rc_service_requests (
	id TEXT PRIMARY KEY,
	branch_id TEXT NOT NULL REFERENCES rc_branches(id),
	visit_id TEXT NOT NULL REFERENCES rc_visits(id),
	kind TEXT NOT NULL CHECK(kind IN ('waiter','bill')),
	status TEXT NOT NULL CHECK(status IN ('open','done')),
	note TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	done_at INTEGER,
	done_by TEXT,
	version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS rc_service_requests_branch ON rc_service_requests(branch_id,status,id);
CREATE INDEX IF NOT EXISTS rc_service_requests_visit ON rc_service_requests(visit_id,status);
CREATE UNIQUE INDEX IF NOT EXISTS rc_service_request_open ON rc_service_requests(visit_id,kind) WHERE status='open';
