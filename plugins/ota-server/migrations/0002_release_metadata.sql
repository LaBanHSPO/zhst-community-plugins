ALTER TABLE ota_releases ADD COLUMN signature TEXT NOT NULL DEFAULT '';
ALTER TABLE ota_releases ADD COLUMN mandatory INTEGER NOT NULL DEFAULT 0 CHECK (mandatory IN (0, 1));
