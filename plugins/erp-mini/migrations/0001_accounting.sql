CREATE TABLE erp_ac_migrations (
  version INTEGER PRIMARY KEY CHECK(version > 0),
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  appliedAt TEXT NOT NULL
) STRICT;
CREATE TABLE erp_ac_settings (
  id TEXT PRIMARY KEY CHECK(id = 'book'), schemaVersion INTEGER NOT NULL CHECK(schemaVersion = 1),
  revision TEXT NOT NULL CHECK(length(revision) > 0),
  currency TEXT NOT NULL CHECK(currency = 'VND'), minorUnits INTEGER NOT NULL CHECK(minorUnits = 0),
  startDate TEXT NOT NULL CHECK(length(startDate) = 10 AND startDate GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(startDate,1,4) <> '0000' AND date(startDate,'+0 days') IS startDate),
  installationId TEXT NOT NULL UNIQUE CHECK(length(installationId) = 36),
  createdAt TEXT NOT NULL, createdBy TEXT NOT NULL CHECK(length(createdBy) > 0),
  updatedAt TEXT NOT NULL, updatedBy TEXT NOT NULL CHECK(length(updatedBy) > 0)
) STRICT;
CREATE TABLE erp_ac_accounts (
  id TEXT PRIMARY KEY CHECK(length(id) = 36), schemaVersion INTEGER NOT NULL CHECK(schemaVersion = 1),
  revision TEXT NOT NULL CHECK(length(revision) > 0), code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64),
  codeKey TEXT NOT NULL UNIQUE CHECK(length(codeKey) > 0), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200), nameKey TEXT NOT NULL,
  rootType TEXT NOT NULL CHECK(rootType IN ('asset','liability','equity','income','expense')),
  purpose TEXT NOT NULL CHECK(purpose IN ('general','cash','bank','receivable','payable')),
  isGroup INTEGER NOT NULL CHECK(isGroup IN (0,1)), parentId TEXT REFERENCES erp_ac_accounts(id), active INTEGER NOT NULL CHECK(active IN (0,1)),
  createdAt TEXT NOT NULL, createdBy TEXT NOT NULL CHECK(length(createdBy)>0), updatedAt TEXT NOT NULL, updatedBy TEXT NOT NULL CHECK(length(updatedBy)>0),
  CHECK(parentId IS NULL OR parentId <> id), CHECK(isGroup = 0 OR purpose = 'general'),
  CHECK(purpose = 'general' OR (purpose IN ('cash','bank','receivable') AND rootType = 'asset') OR (purpose = 'payable' AND rootType = 'liability'))
) STRICT;
CREATE TABLE erp_ac_parties (
  id TEXT PRIMARY KEY CHECK(length(id) = 36), schemaVersion INTEGER NOT NULL CHECK(schemaVersion = 1), revision TEXT NOT NULL CHECK(length(revision)>0),
  kind TEXT NOT NULL CHECK(kind IN ('customer','supplier')), code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64), codeKey TEXT NOT NULL CHECK(length(codeKey)>0),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200), nameKey TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
  sourceKind TEXT, sourceId TEXT, sourceRevision TEXT,
  createdAt TEXT NOT NULL, createdBy TEXT NOT NULL CHECK(length(createdBy)>0), updatedAt TEXT NOT NULL, updatedBy TEXT NOT NULL CHECK(length(updatedBy)>0),
  UNIQUE(kind,codeKey), UNIQUE(sourceKind,sourceId,kind),
  CHECK((sourceKind IS NULL AND sourceId IS NULL AND sourceRevision IS NULL) OR (sourceKind IS 'customer' AND kind = 'customer' AND sourceId IS NOT NULL AND length(sourceId)=36 AND sourceRevision IS NOT NULL AND length(sourceRevision)>0))
) STRICT;
CREATE TABLE erp_ac_journals (
  id TEXT PRIMARY KEY CHECK(length(id)=36), schemaVersion INTEGER NOT NULL CHECK(schemaVersion=1), revision TEXT NOT NULL CHECK(length(revision)>0),
  kind TEXT NOT NULL CHECK(kind IN ('journal','opening','receipt','payment','reversal')), status TEXT NOT NULL CHECK(status IN ('draft','cancelled','posted')),
  postingDate TEXT NOT NULL CHECK(length(postingDate)=10 AND postingDate GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(postingDate,1,4)<>'0000' AND date(postingDate,'+0 days') IS postingDate),
  memo TEXT NOT NULL CHECK(length(memo)<=2000), reference TEXT NOT NULL CHECK(length(reference)<=200), currency TEXT NOT NULL CHECK(currency='VND'),
  number TEXT UNIQUE, postedSequence INTEGER UNIQUE CHECK(postedSequence BETWEEN 1 AND 9007199254740991), postedAt TEXT, postedBy TEXT,
  reversalOf TEXT UNIQUE REFERENCES erp_ac_journals(id),
  createdAt TEXT NOT NULL, createdBy TEXT NOT NULL CHECK(length(createdBy)>0), updatedAt TEXT NOT NULL, updatedBy TEXT NOT NULL CHECK(length(updatedBy)>0),
  CHECK((status='posted' AND number IS NOT NULL AND length(number)>0 AND postedSequence IS NOT NULL AND postedAt IS NOT NULL AND postedBy IS NOT NULL AND length(postedBy)>0) OR (status<>'posted' AND number IS NULL AND postedSequence IS NULL AND postedAt IS NULL AND postedBy IS NULL)),
  CHECK((kind='reversal' AND reversalOf IS NOT NULL AND reversalOf<>id) OR (kind<>'reversal' AND reversalOf IS NULL))
) STRICT;
CREATE TABLE erp_ac_lines (
  journalId TEXT NOT NULL REFERENCES erp_ac_journals(id), lineIndex INTEGER NOT NULL CHECK(lineIndex BETWEEN 0 AND 49),
  accountId TEXT NOT NULL REFERENCES erp_ac_accounts(id), partyId TEXT REFERENCES erp_ac_parties(id),
  role TEXT NOT NULL CHECK(role IN ('general','open-item','settlement','reversal')),
  accountCode TEXT, accountName TEXT, accountRootType TEXT CHECK(accountRootType IN ('asset','liability','equity','income','expense')),
  accountPurpose TEXT CHECK(accountPurpose IN ('general','cash','bank','receivable','payable')),
  partyCode TEXT, partyName TEXT, partyKind TEXT CHECK(partyKind IN ('customer','supplier')),
  debitMinor INTEGER NOT NULL CHECK(debitMinor BETWEEN 0 AND 1000000000000), creditMinor INTEGER NOT NULL CHECK(creditMinor BETWEEN 0 AND 1000000000000),
  PRIMARY KEY(journalId,lineIndex), CHECK((debitMinor>0 AND creditMinor=0) OR (creditMinor>0 AND debitMinor=0)),
  CHECK((partyId IS NULL AND partyCode IS NULL AND partyName IS NULL AND partyKind IS NULL) OR partyId IS NOT NULL)
) STRICT;
CREATE TABLE erp_ac_allocations (
  settlementJournalId TEXT NOT NULL, settlementLineIndex INTEGER NOT NULL,
  sourceJournalId TEXT NOT NULL, sourceLineIndex INTEGER NOT NULL,
  amountMinor INTEGER NOT NULL CHECK(amountMinor BETWEEN 1 AND 1000000000000),
  PRIMARY KEY(settlementJournalId,settlementLineIndex,sourceJournalId,sourceLineIndex),
  FOREIGN KEY(settlementJournalId,settlementLineIndex) REFERENCES erp_ac_lines(journalId,lineIndex),
  FOREIGN KEY(sourceJournalId,sourceLineIndex) REFERENCES erp_ac_lines(journalId,lineIndex),
  CHECK(settlementJournalId<>sourceJournalId)
) STRICT;
CREATE TABLE erp_ac_audit (
  id TEXT PRIMARY KEY CHECK(length(id)=36), entity TEXT NOT NULL CHECK(entity IN ('book','account','party','journal')),
  recordId TEXT NOT NULL, journalId TEXT REFERENCES erp_ac_journals(id), event TEXT NOT NULL CHECK(length(event)>0),
  actorId TEXT NOT NULL CHECK(length(actorId)>0), occurredAt TEXT NOT NULL, revision TEXT NOT NULL CHECK(length(revision)>0),
  postedSequence INTEGER REFERENCES erp_ac_journals(postedSequence),
  CHECK((entity='journal' AND journalId IS recordId) OR (entity<>'journal' AND journalId IS NULL AND postedSequence IS NULL))
) STRICT;
CREATE TABLE erp_ac_commands (
  commandId TEXT PRIMARY KEY CHECK(length(commandId)=36), action TEXT NOT NULL CHECK(action IN ('post-journal','reverse-journal')),
  actorId TEXT NOT NULL CHECK(length(actorId)>0), canonicalPayloadHash TEXT NOT NULL CHECK(length(canonicalPayloadHash)=64),
  journalId TEXT NOT NULL REFERENCES erp_ac_journals(id), revision TEXT NOT NULL CHECK(length(revision)>0),
  postedSequence INTEGER NOT NULL REFERENCES erp_ac_journals(postedSequence), createdAt TEXT NOT NULL
) STRICT;
CREATE INDEX erp_ac_accounts_search ON erp_ac_accounts(active,nameKey,id);
CREATE INDEX erp_ac_parties_search ON erp_ac_parties(kind,active,nameKey,id);
CREATE INDEX erp_ac_journals_date ON erp_ac_journals(postingDate,postedSequence,id);
CREATE INDEX erp_ac_journals_status ON erp_ac_journals(status,postingDate,id);
CREATE INDEX erp_ac_journals_reversal ON erp_ac_journals(reversalOf,postedSequence);
CREATE INDEX erp_ac_lines_account ON erp_ac_lines(accountId,journalId,lineIndex);
CREATE INDEX erp_ac_lines_party ON erp_ac_lines(partyId,accountId,journalId,lineIndex);
CREATE INDEX erp_ac_allocations_source ON erp_ac_allocations(sourceJournalId,sourceLineIndex,settlementJournalId,settlementLineIndex);
CREATE INDEX erp_ac_audit_record ON erp_ac_audit(entity,recordId,occurredAt,id);
CREATE TRIGGER erp_ac_settings_update BEFORE UPDATE ON erp_ac_settings BEGIN SELECT RAISE(ABORT,'BOOK_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_settings_delete BEFORE DELETE ON erp_ac_settings BEGIN SELECT RAISE(ABORT,'BOOK_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_audit_update BEFORE UPDATE ON erp_ac_audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_audit_delete BEFORE DELETE ON erp_ac_audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_commands_update BEFORE UPDATE ON erp_ac_commands BEGIN SELECT RAISE(ABORT,'COMMAND_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_commands_delete BEFORE DELETE ON erp_ac_commands BEGIN SELECT RAISE(ABORT,'COMMAND_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_commands_insert BEFORE INSERT ON erp_ac_commands BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM erp_ac_journals WHERE id=NEW.journalId AND status='posted' AND revision=NEW.revision AND postedSequence=NEW.postedSequence AND postedBy=NEW.actorId AND ((NEW.action='reverse-journal' AND kind='reversal') OR (NEW.action='post-journal' AND kind<>'reversal'))) THEN RAISE(ABORT,'INVALID_RECEIPT') END;
END;
CREATE TRIGGER erp_ac_journals_insert BEFORE INSERT ON erp_ac_journals WHEN NEW.status<>'draft' BEGIN SELECT RAISE(ABORT,'INVALID_TRANSITION'); END;
CREATE TRIGGER erp_ac_journals_update BEFORE UPDATE ON erp_ac_journals WHEN OLD.status<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_journals_delete BEFORE DELETE ON erp_ac_journals WHEN OLD.status='posted' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_lines_insert BEFORE INSERT ON erp_ac_lines WHEN (SELECT status FROM erp_ac_journals WHERE id=NEW.journalId)<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_lines_update BEFORE UPDATE ON erp_ac_lines WHEN (SELECT status FROM erp_ac_journals WHERE id=OLD.journalId)<>'draft' OR (SELECT status FROM erp_ac_journals WHERE id=NEW.journalId)<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_lines_delete BEFORE DELETE ON erp_ac_lines WHEN (SELECT status FROM erp_ac_journals WHERE id=OLD.journalId)<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_allocations_insert BEFORE INSERT ON erp_ac_allocations WHEN (SELECT status FROM erp_ac_journals WHERE id=NEW.settlementJournalId)<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_allocations_update BEFORE UPDATE ON erp_ac_allocations WHEN (SELECT status FROM erp_ac_journals WHERE id=OLD.settlementJournalId)<>'draft' OR (SELECT status FROM erp_ac_journals WHERE id=NEW.settlementJournalId)<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_allocations_delete BEFORE DELETE ON erp_ac_allocations WHEN (SELECT status FROM erp_ac_journals WHERE id=OLD.settlementJournalId)<>'draft' BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
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
CREATE TRIGGER erp_ac_settings_replace BEFORE INSERT ON erp_ac_settings WHEN EXISTS(SELECT 1 FROM erp_ac_settings WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'BOOK_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_audit_replace BEFORE INSERT ON erp_ac_audit WHEN EXISTS(SELECT 1 FROM erp_ac_audit WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_commands_replace BEFORE INSERT ON erp_ac_commands WHEN EXISTS(SELECT 1 FROM erp_ac_commands WHERE commandId=NEW.commandId) BEGIN SELECT RAISE(ABORT,'COMMAND_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_journals_replace BEFORE INSERT ON erp_ac_journals WHEN EXISTS(SELECT 1 FROM erp_ac_journals WHERE id=NEW.id AND status<>'draft') BEGIN SELECT RAISE(ABORT,'JOURNAL_IMMUTABLE'); END;
CREATE TRIGGER erp_ac_accounts_replace BEFORE INSERT ON erp_ac_accounts WHEN EXISTS(SELECT 1 FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE l.accountId=NEW.id AND j.status='posted') BEGIN SELECT RAISE(ABORT,'ACCOUNT_HISTORY'); END;
CREATE TRIGGER erp_ac_parties_replace BEFORE INSERT ON erp_ac_parties WHEN EXISTS(SELECT 1 FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE l.partyId=NEW.id AND j.status='posted') BEGIN SELECT RAISE(ABORT,'PARTY_HISTORY'); END;
CREATE TRIGGER erp_ac_audit_insert BEFORE INSERT ON erp_ac_audit WHEN NEW.postedSequence IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM erp_ac_journals WHERE id=NEW.journalId AND status='posted' AND postedSequence=NEW.postedSequence AND revision=NEW.revision AND postedBy=NEW.actorId) THEN RAISE(ABORT,'INVALID_RECEIPT') END;
END;
CREATE TRIGGER erp_ac_parties_source_update BEFORE UPDATE ON erp_ac_parties
WHEN NEW.sourceKind IS NOT OLD.sourceKind OR NEW.sourceId IS NOT OLD.sourceId OR NEW.sourceRevision IS NOT OLD.sourceRevision
BEGIN SELECT RAISE(ABORT,'PARTY_HISTORY'); END;
CREATE TRIGGER erp_ac_parties_source_replace BEFORE INSERT ON erp_ac_parties
WHEN EXISTS(SELECT 1 FROM erp_ac_parties WHERE id=NEW.id AND sourceKind IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'PARTY_HISTORY'); END;
CREATE TRIGGER erp_ac_accounts_active_parent_insert BEFORE INSERT ON erp_ac_accounts WHEN NEW.active=1 AND NEW.parentId IS NOT NULL BEGIN
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id,parentId,active) AS (SELECT id,parentId,active FROM erp_ac_accounts WHERE id=NEW.parentId UNION SELECT a.id,a.parentId,a.active FROM erp_ac_accounts a JOIN ancestors p ON a.id=p.parentId) SELECT 1 FROM ancestors WHERE active<>1) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
END;
CREATE TRIGGER erp_ac_accounts_active_parent_update BEFORE UPDATE ON erp_ac_accounts WHEN NEW.active=1 AND NEW.parentId IS NOT NULL BEGIN
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id,parentId,active) AS (SELECT id,parentId,active FROM erp_ac_accounts WHERE id=NEW.parentId UNION SELECT a.id,a.parentId,a.active FROM erp_ac_accounts a JOIN ancestors p ON a.id=p.parentId) SELECT 1 FROM ancestors WHERE active<>1) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
END;
CREATE TRIGGER erp_ac_post_ancestors BEFORE UPDATE OF status ON erp_ac_journals WHEN NEW.status='posted' AND NEW.kind<>'reversal' BEGIN
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(accountId,id,parentId,rootType,isGroup,active) AS (SELECT l.accountId,a.id,a.parentId,a.rootType,a.isGroup,a.active FROM erp_ac_lines l JOIN erp_ac_accounts a ON a.id=l.accountId WHERE l.journalId=NEW.id UNION SELECT p.accountId,a.id,a.parentId,a.rootType,a.isGroup,a.active FROM erp_ac_accounts a JOIN ancestors p ON a.id=p.parentId) SELECT 1 FROM ancestors p JOIN erp_ac_accounts a ON a.id=p.accountId WHERE p.id<>p.accountId AND (p.isGroup<>1 OR p.active<>1 OR p.rootType<>a.rootType)) THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END;
END;
