-- The migration owner disables foreign keys before BEGIN and checks them before COMMIT.
-- Drop only known triggers that reference the rebuilt tables; restore their original SQL.
DROP TRIGGER erp_ac_lines_insert;
DROP TRIGGER erp_ac_lines_update;
DROP TRIGGER erp_ac_lines_delete;
DROP TRIGGER erp_ac_accounts_parent_insert;
DROP TRIGGER erp_ac_accounts_parent_update;
DROP TRIGGER erp_ac_parties_history;
DROP TRIGGER erp_ac_post;
DROP TRIGGER erp_ac_accounts_replace;
DROP TRIGGER erp_ac_parties_replace;
DROP TRIGGER erp_ac_accounts_active_parent_insert;
DROP TRIGGER erp_ac_accounts_active_parent_update;
DROP TRIGGER erp_ac_post_ancestors;
DROP INDEX erp_ac_accounts_search;
DROP INDEX erp_ac_lines_account;
DROP INDEX erp_ac_lines_party;
CREATE TABLE erp_ac_accounts_new (
  id TEXT PRIMARY KEY CHECK(length(id) = 36), schemaVersion INTEGER NOT NULL CHECK(schemaVersion = 1),
  revision TEXT NOT NULL CHECK(length(revision) > 0), code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64),
  codeKey TEXT NOT NULL UNIQUE CHECK(length(codeKey) > 0), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200), nameKey TEXT NOT NULL,
  rootType TEXT NOT NULL CHECK(rootType IN ('asset','liability','equity','income','expense','result')),
  purpose TEXT NOT NULL CHECK(purpose IN ('general','cash','bank','receivable','payable')),
  isGroup INTEGER NOT NULL CHECK(isGroup IN (0,1)), parentId TEXT REFERENCES erp_ac_accounts(id), active INTEGER NOT NULL CHECK(active IN (0,1)),
  createdAt TEXT NOT NULL, createdBy TEXT NOT NULL CHECK(length(createdBy)>0), updatedAt TEXT NOT NULL, updatedBy TEXT NOT NULL CHECK(length(updatedBy)>0),
  CHECK(parentId IS NULL OR parentId <> id), CHECK(isGroup = 0 OR purpose = 'general'),
  CHECK(purpose = 'general' OR (purpose IN ('cash','bank','receivable') AND rootType = 'asset') OR (purpose = 'payable' AND rootType = 'liability'))
) STRICT;
CREATE TABLE erp_ac_lines_new (
  journalId TEXT NOT NULL REFERENCES erp_ac_journals(id), lineIndex INTEGER NOT NULL CHECK(lineIndex BETWEEN 0 AND 49),
  accountId TEXT NOT NULL REFERENCES erp_ac_accounts(id), partyId TEXT REFERENCES erp_ac_parties(id),
  role TEXT NOT NULL CHECK(role IN ('general','open-item','settlement','reversal')),
  accountCode TEXT, accountName TEXT, accountRootType TEXT CHECK(accountRootType IN ('asset','liability','equity','income','expense','result')),
  accountPurpose TEXT CHECK(accountPurpose IN ('general','cash','bank','receivable','payable')),
  partyCode TEXT, partyName TEXT, partyKind TEXT CHECK(partyKind IN ('customer','supplier')),
  debitMinor INTEGER NOT NULL CHECK(debitMinor BETWEEN 0 AND 1000000000000), creditMinor INTEGER NOT NULL CHECK(creditMinor BETWEEN 0 AND 1000000000000),
  PRIMARY KEY(journalId,lineIndex), CHECK((debitMinor>0 AND creditMinor=0) OR (creditMinor>0 AND debitMinor=0)),
  CHECK((partyId IS NULL AND partyCode IS NULL AND partyName IS NULL AND partyKind IS NULL) OR partyId IS NOT NULL)
) STRICT;
INSERT INTO erp_ac_accounts_new(id,schemaVersion,revision,code,codeKey,name,nameKey,rootType,purpose,isGroup,parentId,active,createdAt,createdBy,updatedAt,updatedBy) SELECT id,schemaVersion,revision,code,codeKey,name,nameKey,rootType,purpose,isGroup,parentId,active,createdAt,createdBy,updatedAt,updatedBy FROM erp_ac_accounts;
INSERT INTO erp_ac_lines_new(journalId,lineIndex,accountId,partyId,role,accountCode,accountName,accountRootType,accountPurpose,partyCode,partyName,partyKind,debitMinor,creditMinor) SELECT journalId,lineIndex,accountId,partyId,role,accountCode,accountName,accountRootType,accountPurpose,partyCode,partyName,partyKind,debitMinor,creditMinor FROM erp_ac_lines;
DROP TABLE erp_ac_lines;
DROP TABLE erp_ac_accounts;
ALTER TABLE erp_ac_accounts_new RENAME TO erp_ac_accounts;
ALTER TABLE erp_ac_lines_new RENAME TO erp_ac_lines;
CREATE INDEX erp_ac_accounts_search ON erp_ac_accounts(active,nameKey,id);
CREATE INDEX erp_ac_lines_account ON erp_ac_lines(accountId,journalId,lineIndex);
CREATE INDEX erp_ac_lines_party ON erp_ac_lines(partyId,accountId,journalId,lineIndex);
CREATE TRIGGER erp_ac_lines_insert BEFORE INSERT ON erp_ac_lines WHEN (SELECT status FROM erp_ac_journals WHERE id=NEW.journalId)<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_lines_update BEFORE UPDATE ON erp_ac_lines WHEN (SELECT status FROM erp_ac_journals WHERE id=OLD.journalId)<>'draft' OR (SELECT status FROM erp_ac_journals WHERE id=NEW.journalId)<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_lines_delete BEFORE DELETE ON erp_ac_lines WHEN (SELECT status FROM erp_ac_journals WHERE id=OLD.journalId)<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_accounts_parent_insert BEFORE INSERT ON erp_ac_accounts WHEN NEW.parentId IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM erp_ac_accounts WHERE id=NEW.parentId AND isGroup=1 AND rootType=NEW.rootType) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
END;
CREATE TRIGGER erp_ac_accounts_parent_update BEFORE UPDATE ON erp_ac_accounts BEGIN
  SELECT CASE WHEN NEW.parentId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erp_ac_accounts WHERE id=NEW.parentId AND isGroup=1 AND rootType=NEW.rootType) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id) AS (SELECT NEW.parentId UNION SELECT a.parentId FROM erp_ac_accounts a JOIN ancestors p ON a.id=p.id WHERE a.parentId IS NOT NULL) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'ACCOUNT_CYCLE') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_accounts WHERE parentId=OLD.id AND (NEW.isGroup<>1 OR rootType<>NEW.rootType)) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
  SELECT CASE WHEN (NEW.rootType<>OLD.rootType OR NEW.purpose<>OLD.purpose OR NEW.isGroup<>OLD.isGroup OR NEW.parentId IS NOT OLD.parentId) AND EXISTS(SELECT 1 FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE l.accountId=OLD.id AND j.status='posted') THEN RAISE(ABORT,'ACCOUNT_HISTORY') END;
END;
CREATE TRIGGER erp_ac_parties_history BEFORE UPDATE ON erp_ac_parties WHEN NEW.kind<>OLD.kind AND EXISTS(SELECT 1 FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE l.partyId=OLD.id AND j.status='posted') BEGIN SELECT RAISE(ABORT,'PARTY_HISTORY'); END;
CREATE TRIGGER erp_ac_post BEFORE UPDATE OF status ON erp_ac_journals WHEN NEW.status='posted' BEGIN
  SELECT CASE WHEN OLD.status<>'draft' OR NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.reversalOf IS NOT OLD.reversalOf THEN RAISE(ABORT,'INVALID_TRANSITION') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM erp_ac_settings WHERE NEW.postingDate>=startDate AND (NEW.kind<>'opening' OR NEW.postingDate=startDate)) THEN RAISE(ABORT,'BOOK_REQUIRED') END;
  SELECT CASE WHEN NEW.postedSequence<>(SELECT coalesce(max(postedSequence),0)+1 FROM erp_ac_journals) THEN RAISE(ABORT,'INVALID_SEQUENCE') END;
  SELECT CASE WHEN (SELECT count(*) FROM erp_ac_lines WHERE journalId=NEW.id) NOT BETWEEN 2 AND 50 OR (SELECT coalesce(sum(debitMinor),0) FROM erp_ac_lines WHERE journalId=NEW.id)<>(SELECT coalesce(sum(creditMinor),0) FROM erp_ac_lines WHERE journalId=NEW.id) THEN RAISE(ABORT,'UNBALANCED') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_lines WHERE journalId=NEW.id AND (accountCode IS NULL OR accountName IS NULL OR accountRootType IS NULL OR accountPurpose IS NULL OR (partyId IS NOT NULL AND (partyCode IS NULL OR partyName IS NULL OR partyKind IS NULL)))) THEN RAISE(ABORT,'INVALID_SNAPSHOT') END;
  SELECT CASE WHEN NEW.kind<>'reversal' AND EXISTS(SELECT 1 FROM erp_ac_lines l JOIN erp_ac_accounts a ON a.id=l.accountId LEFT JOIN erp_ac_parties p ON p.id=l.partyId WHERE l.journalId=NEW.id AND (a.isGroup<>0 OR a.active<>1 OR l.accountCode<>a.code OR l.accountName<>a.name OR l.accountRootType<>a.rootType OR l.accountPurpose<>a.purpose OR (l.partyId IS NOT NULL AND (p.active<>1 OR l.partyCode<>p.code OR l.partyName<>p.name OR l.partyKind<>p.kind)) OR (a.purpose='receivable' AND (l.partyId IS NULL OR p.kind<>'customer')) OR (a.purpose='payable' AND (l.partyId IS NULL OR p.kind<>'supplier')) OR (a.purpose NOT IN ('receivable','payable') AND l.partyId IS NOT NULL) OR l.role<>CASE WHEN a.purpose='receivable' THEN CASE WHEN l.debitMinor>0 THEN 'open-item' ELSE 'settlement' END WHEN a.purpose='payable' THEN CASE WHEN l.creditMinor>0 THEN 'open-item' ELSE 'settlement' END ELSE 'general' END)) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_lines l WHERE l.journalId=NEW.id AND ((l.role='settlement' AND (SELECT coalesce(sum(amountMinor),0) FROM erp_ac_allocations WHERE settlementJournalId=l.journalId AND settlementLineIndex=l.lineIndex)<>l.debitMinor+l.creditMinor) OR (l.role<>'settlement' AND EXISTS(SELECT 1 FROM erp_ac_allocations WHERE settlementJournalId=l.journalId AND settlementLineIndex=l.lineIndex)))) THEN RAISE(ABORT,'OVER_ALLOCATION') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_allocations x JOIN erp_ac_lines s ON s.journalId=x.sourceJournalId AND s.lineIndex=x.sourceLineIndex JOIN erp_ac_lines l ON l.journalId=x.settlementJournalId AND l.lineIndex=x.settlementLineIndex JOIN erp_ac_journals j ON j.id=s.journalId WHERE x.settlementJournalId=NEW.id AND (j.status<>'posted' OR s.role<>'open-item' OR s.accountId<>l.accountId OR s.partyId IS NOT l.partyId OR (s.debitMinor>0 AND l.debitMinor>0) OR (s.creditMinor>0 AND l.creditMinor>0) OR NEW.postingDate<j.postingDate OR EXISTS(SELECT 1 FROM erp_ac_journals r WHERE r.reversalOf=j.id AND r.status='posted'))) THEN RAISE(ABORT,'OVER_ALLOCATION') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_allocations x JOIN erp_ac_lines s ON s.journalId=x.sourceJournalId AND s.lineIndex=x.sourceLineIndex WHERE x.settlementJournalId=NEW.id AND (SELECT coalesce(sum(y.amountMinor),0) FROM erp_ac_allocations y JOIN erp_ac_journals j ON j.id=y.settlementJournalId WHERE y.sourceJournalId=s.journalId AND y.sourceLineIndex=s.lineIndex AND (j.id=NEW.id OR (j.status='posted' AND NOT EXISTS(SELECT 1 FROM erp_ac_journals r WHERE r.reversalOf=j.id AND r.status='posted'))))>s.debitMinor+s.creditMinor) THEN RAISE(ABORT,'OVER_ALLOCATION') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_allocations x JOIN erp_ac_allocations y ON y.sourceJournalId=x.sourceJournalId AND y.sourceLineIndex=x.sourceLineIndex JOIN erp_ac_journals j ON j.id=y.settlementJournalId LEFT JOIN erp_ac_journals r ON r.reversalOf=j.id AND r.status='posted' WHERE x.settlementJournalId=NEW.id AND j.status='posted' AND (NEW.postingDate<j.postingDate OR NEW.postingDate<r.postingDate)) THEN RAISE(ABORT,'ALLOCATION_DATE_CONFLICT') END;
  SELECT CASE WHEN NEW.kind='reversal' AND (NOT EXISTS(SELECT 1 FROM erp_ac_journals o WHERE o.id=NEW.reversalOf AND o.status='posted' AND o.kind<>'reversal' AND NEW.postingDate>=o.postingDate) OR (SELECT count(*) FROM erp_ac_lines WHERE journalId=NEW.id)<>(SELECT count(*) FROM erp_ac_lines WHERE journalId=NEW.reversalOf) OR EXISTS(SELECT 1 FROM erp_ac_lines l LEFT JOIN erp_ac_lines o ON o.journalId=NEW.reversalOf AND o.lineIndex=l.lineIndex WHERE l.journalId=NEW.id AND (o.journalId IS NULL OR l.role<>'reversal' OR l.accountId<>o.accountId OR l.partyId IS NOT o.partyId OR l.debitMinor<>o.creditMinor OR l.creditMinor<>o.debitMinor OR l.accountCode IS NOT o.accountCode OR l.accountName IS NOT o.accountName OR l.accountRootType IS NOT o.accountRootType OR l.accountPurpose IS NOT o.accountPurpose OR l.partyCode IS NOT o.partyCode OR l.partyName IS NOT o.partyName OR l.partyKind IS NOT o.partyKind))) THEN RAISE(ABORT,'INVALID_REVERSAL') END;
  SELECT CASE WHEN NEW.kind='reversal' AND EXISTS(SELECT 1 FROM erp_ac_allocations x JOIN erp_ac_journals j ON j.id=x.settlementJournalId WHERE x.sourceJournalId=NEW.reversalOf AND j.status='posted' AND NOT EXISTS(SELECT 1 FROM erp_ac_journals r WHERE r.reversalOf=j.id AND r.status='posted')) THEN RAISE(ABORT,'ACTIVE_SETTLEMENT') END;
  SELECT CASE WHEN NEW.kind='reversal' AND EXISTS(SELECT 1 FROM erp_ac_allocations x JOIN erp_ac_journals s ON s.id=x.sourceJournalId JOIN erp_ac_allocations y ON y.sourceJournalId=x.sourceJournalId AND y.sourceLineIndex=x.sourceLineIndex JOIN erp_ac_journals j ON j.id=y.settlementJournalId LEFT JOIN erp_ac_journals r ON r.reversalOf=j.id AND r.status='posted' WHERE (x.settlementJournalId=NEW.reversalOf OR x.sourceJournalId=NEW.reversalOf) AND j.status='posted' AND (NEW.postingDate<s.postingDate OR NEW.postingDate<j.postingDate OR NEW.postingDate<r.postingDate)) THEN RAISE(ABORT,'ALLOCATION_DATE_CONFLICT') END;
  SELECT CASE WHEN NEW.kind IN ('receipt','payment') AND ((SELECT count(*) FROM erp_ac_lines WHERE journalId=NEW.id AND accountPurpose IN ('cash','bank'))<>1 OR EXISTS(SELECT 1 FROM erp_ac_lines WHERE journalId=NEW.id AND NOT ((accountPurpose IN ('cash','bank') AND role='general' AND ((NEW.kind='receipt' AND debitMinor>0) OR (NEW.kind='payment' AND creditMinor>0))) OR (role='settlement' AND ((NEW.kind='receipt' AND accountPurpose='receivable' AND creditMinor>0) OR (NEW.kind='payment' AND accountPurpose='payable' AND debitMinor>0))))) OR (SELECT count(DISTINCT partyId) FROM erp_ac_lines WHERE journalId=NEW.id AND role='settlement')<>1 OR (SELECT count(DISTINCT accountId) FROM erp_ac_lines WHERE journalId=NEW.id AND role='settlement')<>1) THEN RAISE(ABORT,'INVALID_SETTLEMENT') END;
END;
CREATE TRIGGER erp_ac_accounts_replace BEFORE INSERT ON erp_ac_accounts WHEN EXISTS(SELECT 1 FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE l.accountId=NEW.id AND j.status='posted') BEGIN SELECT RAISE(ABORT,'ACCOUNT_HISTORY'); END;
CREATE TRIGGER erp_ac_parties_replace BEFORE INSERT ON erp_ac_parties WHEN EXISTS(SELECT 1 FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE l.partyId=NEW.id AND j.status='posted') BEGIN SELECT RAISE(ABORT,'PARTY_HISTORY'); END;
CREATE TRIGGER erp_ac_accounts_active_parent_insert BEFORE INSERT ON erp_ac_accounts WHEN NEW.active=1 AND NEW.parentId IS NOT NULL BEGIN
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id,parentId,active) AS (SELECT id,parentId,active FROM erp_ac_accounts WHERE id=NEW.parentId UNION SELECT a.id,a.parentId,a.active FROM erp_ac_accounts a JOIN ancestors p ON a.id=p.parentId) SELECT 1 FROM ancestors WHERE active<>1) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
END;
CREATE TRIGGER erp_ac_accounts_active_parent_update BEFORE UPDATE ON erp_ac_accounts WHEN NEW.active=1 AND NEW.parentId IS NOT NULL BEGIN
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id,parentId,active) AS (SELECT id,parentId,active FROM erp_ac_accounts WHERE id=NEW.parentId UNION SELECT a.id,a.parentId,a.active FROM erp_ac_accounts a JOIN ancestors p ON a.id=p.parentId) SELECT 1 FROM ancestors WHERE active<>1) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
END;
CREATE TRIGGER erp_ac_post_ancestors BEFORE UPDATE OF status ON erp_ac_journals WHEN NEW.status='posted' AND NEW.kind<>'reversal' BEGIN
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(accountId,id,parentId,rootType,isGroup,active) AS (SELECT l.accountId,a.id,a.parentId,a.rootType,a.isGroup,a.active FROM erp_ac_lines l JOIN erp_ac_accounts a ON a.id=l.accountId WHERE l.journalId=NEW.id UNION SELECT p.accountId,a.id,a.parentId,a.rootType,a.isGroup,a.active FROM erp_ac_accounts a JOIN ancestors p ON a.id=p.parentId) SELECT 1 FROM ancestors p JOIN erp_ac_accounts a ON a.id=p.accountId WHERE p.id<>p.accountId AND (p.isGroup<>1 OR p.active<>1 OR p.rootType<>a.rootType)) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
END;
CREATE TABLE erp_ac_coa_imports (
  commandId TEXT PRIMARY KEY CHECK(length(commandId)=36),
  actorId TEXT NOT NULL CHECK(length(actorId)>0),
  canonicalPayloadHash TEXT NOT NULL CHECK(length(canonicalPayloadHash)=64 AND canonicalPayloadHash NOT GLOB '*[^0-9a-f]*'),
  templateId TEXT NOT NULL CHECK(length(templateId)>0),
  templateVersion TEXT NOT NULL CHECK(length(templateVersion)>0),
  resultJson TEXT NOT NULL CHECK(json_valid(resultJson)),
  createdAt TEXT NOT NULL CHECK(length(createdAt)>0)
) STRICT;
CREATE TRIGGER erp_ac_coa_imports_update BEFORE UPDATE ON erp_ac_coa_imports BEGIN SELECT RAISE(ABORT,'COA_IMPORT_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_coa_imports_delete BEFORE DELETE ON erp_ac_coa_imports BEGIN SELECT RAISE(ABORT,'COA_IMPORT_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_coa_imports_insert BEFORE INSERT ON erp_ac_coa_imports BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_coa_imports WHERE commandId=NEW.commandId) THEN RAISE(ABORT,'COA_IMPORT_IMMUTABLE') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM erp_ac_commands WHERE commandId=NEW.commandId) THEN RAISE(ABORT,'IDEMPOTENCY_CONFLICT') END;
END;
CREATE TRIGGER erp_ac_commands_coa_fence BEFORE INSERT ON erp_ac_commands WHEN EXISTS(SELECT 1 FROM erp_ac_coa_imports WHERE commandId=NEW.commandId) BEGIN SELECT RAISE(ABORT,'IDEMPOTENCY_CONFLICT'); END;
