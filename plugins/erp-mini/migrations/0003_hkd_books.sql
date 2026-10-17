-- Additive household bookkeeping; enterprise history and prior migration bytes remain unchanged.
CREATE TABLE erp_ac_hkd_profiles (
  year INTEGER PRIMARY KEY CHECK(year BETWEEN 2026 AND 2100),
  installationId TEXT NOT NULL UNIQUE CHECK(length(installationId)=36),
  revision TEXT NOT NULL CHECK(length(revision)>0),
  profileJson TEXT NOT NULL CHECK(json_valid(profileJson) AND json_type(profileJson)='object'),
  createdAt TEXT NOT NULL CHECK(length(createdAt)>0),
  createdBy TEXT NOT NULL CHECK(length(createdBy)>0)
) STRICT;
CREATE TABLE erp_ac_hkd_events (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  year INTEGER NOT NULL REFERENCES erp_ac_hkd_profiles(year),
  sequence INTEGER NOT NULL UNIQUE CHECK(sequence BETWEEN 1 AND 9007199254740991),
  eventType TEXT NOT NULL CHECK(eventType IN ('entry','void')),
  targetId TEXT REFERENCES erp_ac_hkd_events(id),
  payloadJson TEXT NOT NULL CHECK(json_valid(payloadJson) AND json_type(payloadJson)='object'),
  createdAt TEXT NOT NULL CHECK(length(createdAt)>0),
  createdBy TEXT NOT NULL CHECK(length(createdBy)>0),
  CHECK((eventType='entry' AND targetId IS NULL) OR (eventType='void' AND targetId IS NOT NULL AND targetId<>id))
) STRICT;
CREATE INDEX erp_ac_hkd_events_year ON erp_ac_hkd_events(year,sequence);
CREATE UNIQUE INDEX erp_ac_hkd_events_void ON erp_ac_hkd_events(targetId) WHERE eventType='void';
CREATE TABLE erp_ac_hkd_commands (
  commandId TEXT PRIMARY KEY CHECK(length(commandId)=36),
  action TEXT NOT NULL CHECK(action IN ('hkd-configure','hkd-post-entry','hkd-void-entry')),
  actorId TEXT NOT NULL CHECK(length(actorId)>0),
  canonicalPayloadHash TEXT NOT NULL CHECK(length(canonicalPayloadHash)=64 AND canonicalPayloadHash NOT GLOB '*[^0-9a-f]*'),
  resultJson TEXT NOT NULL CHECK(json_valid(resultJson) AND json_type(resultJson)='object'),
  createdAt TEXT NOT NULL CHECK(length(createdAt)>0)
) STRICT;
CREATE TRIGGER erp_ac_hkd_profiles_update BEFORE UPDATE ON erp_ac_hkd_profiles BEGIN SELECT RAISE(ABORT,'HKD_PROFILE_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_hkd_profiles_delete BEFORE DELETE ON erp_ac_hkd_profiles BEGIN SELECT RAISE(ABORT,'HKD_PROFILE_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_hkd_profiles_insert BEFORE INSERT ON erp_ac_hkd_profiles WHEN EXISTS(SELECT 1 FROM erp_ac_hkd_profiles WHERE year=NEW.year OR installationId=NEW.installationId) BEGIN SELECT RAISE(ABORT,'HKD_PROFILE_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_hkd_events_update BEFORE UPDATE ON erp_ac_hkd_events BEGIN SELECT RAISE(ABORT,'HKD_ENTRY_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_hkd_events_delete BEFORE DELETE ON erp_ac_hkd_events BEGIN SELECT RAISE(ABORT,'HKD_ENTRY_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_hkd_events_insert BEFORE INSERT ON erp_ac_hkd_events BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_hkd_events WHERE id=NEW.id) THEN RAISE(ABORT,'HKD_ENTRY_IMMUTABLE') END;
  SELECT CASE WHEN NEW.sequence<>(SELECT coalesce(max(sequence),0)+1 FROM erp_ac_hkd_events) THEN RAISE(ABORT,'INVALID_SEQUENCE') END;
  SELECT CASE WHEN NEW.eventType='void' AND NOT EXISTS(SELECT 1 FROM erp_ac_hkd_events WHERE id=NEW.targetId AND eventType='entry' AND year=NEW.year AND sequence<NEW.sequence) THEN RAISE(ABORT,'INVALID_TRANSITION') END;
END;
CREATE TRIGGER erp_ac_hkd_commands_update BEFORE UPDATE ON erp_ac_hkd_commands BEGIN SELECT RAISE(ABORT,'HKD_COMMAND_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_hkd_commands_delete BEFORE DELETE ON erp_ac_hkd_commands BEGIN SELECT RAISE(ABORT,'HKD_COMMAND_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_hkd_commands_insert BEFORE INSERT ON erp_ac_hkd_commands BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_hkd_commands WHERE commandId=NEW.commandId) THEN RAISE(ABORT,'HKD_COMMAND_IMMUTABLE') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_commands WHERE commandId=NEW.commandId) OR EXISTS(SELECT 1 FROM erp_ac_coa_imports WHERE commandId=NEW.commandId) THEN RAISE(ABORT,'IDEMPOTENCY_CONFLICT') END;
END;
CREATE TRIGGER erp_ac_commands_hkd_fence BEFORE INSERT ON erp_ac_commands WHEN EXISTS(SELECT 1 FROM erp_ac_hkd_commands WHERE commandId=NEW.commandId) BEGIN SELECT RAISE(ABORT,'IDEMPOTENCY_CONFLICT'); END;
CREATE TRIGGER erp_ac_coa_imports_hkd_fence BEFORE INSERT ON erp_ac_coa_imports WHEN EXISTS(SELECT 1 FROM erp_ac_hkd_commands WHERE commandId=NEW.commandId) BEGIN SELECT RAISE(ABORT,'IDEMPOTENCY_CONFLICT'); END;
