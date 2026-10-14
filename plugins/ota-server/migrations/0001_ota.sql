PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ota_apps (
	slug TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	version INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO ota_apps (slug, name, enabled, version, created_at, updated_at) VALUES ('unitel-man', 'Unitel Man', 1, 1, (strftime('%s', 'now') * 1000), (strftime('%s', 'now') * 1000));
INSERT OR IGNORE INTO ota_apps (slug, name, enabled, version, created_at, updated_at) VALUES ('unitel-logistics', 'Unitel Logistics', 1, 1, (strftime('%s', 'now') * 1000), (strftime('%s', 'now') * 1000));

CREATE TABLE IF NOT EXISTS ota_releases (
	id TEXT PRIMARY KEY,
	app TEXT NOT NULL REFERENCES ota_apps (slug),
	platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
	channel TEXT NOT NULL,
	binary TEXT NOT NULL,
	release_id TEXT NOT NULL,
	file TEXT NOT NULL,
	sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
	size INTEGER NOT NULL CHECK (size > 0),
	note TEXT NOT NULL DEFAULT '',
	commit_sha TEXT NOT NULL DEFAULT '',
	branch TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ota_releases_file ON ota_releases (app, platform, file);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ota_releases_release_id ON ota_releases (app, platform, channel, binary, release_id);
CREATE INDEX IF NOT EXISTS idx_ota_releases_pair ON ota_releases (app, platform, channel, binary, created_at);
CREATE INDEX IF NOT EXISTS idx_ota_releases_created ON ota_releases (created_at);

CREATE TABLE IF NOT EXISTS ota_current (
	app TEXT NOT NULL,
	platform TEXT NOT NULL,
	channel TEXT NOT NULL,
	binary TEXT NOT NULL,
	release_id TEXT NOT NULL REFERENCES ota_releases (id),
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (app, platform, channel, binary)
);

CREATE TABLE IF NOT EXISTS ota_tokens (
	id TEXT PRIMARY KEY,
	app TEXT NOT NULL REFERENCES ota_apps (slug),
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	token_prefix TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ota_tokens_app ON ota_tokens (app, created_at);

CREATE TABLE IF NOT EXISTS ota_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL CHECK (json_valid(value)),
	version INTEGER NOT NULL DEFAULT 1,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ota_audit (
	id TEXT PRIMARY KEY,
	actor_id TEXT,
	actor_kind TEXT NOT NULL,
	action TEXT NOT NULL,
	app TEXT,
	platform TEXT,
	channel TEXT,
	binary TEXT,
	detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ota_audit_created ON ota_audit (created_at);
