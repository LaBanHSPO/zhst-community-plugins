PRAGMA foreign_keys = ON;

-- A table is "dirty" after its visit closes and must be cleaned before a new
-- visit can open. Settling a bill never frees the table on its own.
ALTER TABLE rc_tables ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
