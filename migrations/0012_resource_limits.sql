-- Resource budgets account for registered images AND unfinished uploads.
-- All counters are maintained inside the same SQLite statement/transaction as reservations.
INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
('resource_limits', '{"maxFileBytes":20971520,"maxBatchFiles":5,"maxBatchBytes":41943040,"dailyUploadFiles":500,"dailyUploadBytes":524288000,"maxR2Bytes":8000000000,"deletionLinksEnabled":true,"deletionTokenTtlDays":0,"statisticsEnabled":true,"statisticsSampleRate":0.1,"dailyStatisticsRecords":5000,"statisticsRetentionDays":30,"auditRetentionDays":90,"cleanupBatchRows":100,"dailyCleanupRows":500,"apiKeyTouchSeconds":3600,"apiRequestsPerMinute":120,"imageRequestsPerMinute":600,"authRequestsPerMinute":10,"deletionRequestsPerMinute":30}', 'Application resource budgets; daily counters reset at 00:00 UTC');

ALTER TABLE images ADD COLUMN delete_token TEXT;
UPDATE system_settings SET value = json_set(value, '$.dailyKvDeletes', 500, '$.dailyCleanupRows', 6000) WHERE key = 'resource_limits';
CREATE TABLE resource_token_cleanup (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX resource_token_cleanup_created_at ON resource_token_cleanup(created_at);
CREATE TABLE resource_usage (
    scope TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0),
    count INTEGER NOT NULL DEFAULT 0 CHECK(count >= 0)
);
CREATE TABLE resource_reservations (
    key TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    size INTEGER NOT NULL CHECK(size >= 0),
    storage_type TEXT NOT NULL CHECK(storage_type IN ('R2', 'HF')),
    day TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX resource_reservations_created_at ON resource_reservations(created_at);
INSERT INTO resource_usage(scope, bytes, count)
SELECT 'r2', COALESCE(SUM(size), 0), COUNT(*) FROM images WHERE storage_type = 'R2' OR storage_type IS NULL;
INSERT INTO resource_usage(scope, bytes, count)
SELECT 'user:' || user_login, COALESCE(SUM(size), 0), COUNT(*) FROM images GROUP BY user_login;
-- Existing uploads/statistics today count towards the first day's budget too.
INSERT INTO resource_usage(scope, bytes, count)
SELECT 'upload:' || date('now'), COALESCE(SUM(size), 0), COUNT(*) FROM images WHERE date(created_at) = date('now');
INSERT INTO resource_usage(scope, count)
SELECT 'stats:' || date('now'), COUNT(*) FROM image_stats WHERE date(accessed_at) = date('now');

CREATE TRIGGER resource_reserve_guard BEFORE INSERT ON resource_reservations BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM images WHERE key = NEW.key)
        THEN RAISE(ABORT, 'RESOURCE_KEY_EXISTS') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE login = NEW.user_login)
        THEN RAISE(ABORT, 'RESOURCE_USER_MISSING') END;
    SELECT CASE WHEN NEW.size > json_extract((SELECT value FROM system_settings WHERE key = 'resource_limits'), '$.maxFileBytes')
        THEN RAISE(ABORT, 'RESOURCE_FILE_SIZE') END;
    SELECT CASE WHEN NEW.storage_type = 'R2' AND
        COALESCE((SELECT bytes FROM resource_usage WHERE scope = 'r2'), 0) + NEW.size >
        json_extract((SELECT value FROM system_settings WHERE key = 'resource_limits'), '$.maxR2Bytes')
        THEN RAISE(ABORT, 'RESOURCE_STORAGE') END;
    SELECT CASE WHEN COALESCE((SELECT storage_quota FROM users WHERE login = NEW.user_login), 0) > 0 AND
        COALESCE((SELECT bytes FROM resource_usage WHERE scope = 'user:' || NEW.user_login), 0) + NEW.size >
        (SELECT storage_quota FROM users WHERE login = NEW.user_login)
        THEN RAISE(ABORT, 'RESOURCE_USER_QUOTA') END;
    SELECT CASE WHEN COALESCE((SELECT count FROM resource_usage WHERE scope = 'upload:' || NEW.day), 0) + 1 >
        json_extract((SELECT value FROM system_settings WHERE key = 'resource_limits'), '$.dailyUploadFiles')
        THEN RAISE(ABORT, 'RESOURCE_DAILY_FILES') END;
    SELECT CASE WHEN COALESCE((SELECT bytes FROM resource_usage WHERE scope = 'upload:' || NEW.day), 0) + NEW.size >
        json_extract((SELECT value FROM system_settings WHERE key = 'resource_limits'), '$.dailyUploadBytes')
        THEN RAISE(ABORT, 'RESOURCE_DAILY_BYTES') END;
END;
CREATE TRIGGER resource_reserve_charge AFTER INSERT ON resource_reservations BEGIN
    INSERT INTO resource_usage(scope, bytes, count) VALUES('user:' || NEW.user_login, NEW.size, 1)
        ON CONFLICT(scope) DO UPDATE SET bytes = bytes + NEW.size, count = count + 1;
    INSERT INTO resource_usage(scope, bytes, count) SELECT 'r2', NEW.size, 1 WHERE NEW.storage_type = 'R2'
        ON CONFLICT(scope) DO UPDATE SET bytes = bytes + NEW.size, count = count + 1;
    INSERT INTO resource_usage(scope, bytes, count) VALUES('upload:' || NEW.day, NEW.size, 1)
        ON CONFLICT(scope) DO UPDATE SET bytes = bytes + NEW.size, count = count + 1;
END;
CREATE TRIGGER resource_reserve_release AFTER DELETE ON resource_reservations
WHEN NOT EXISTS (SELECT 1 FROM images WHERE key = OLD.key) BEGIN
    UPDATE resource_usage SET bytes = MAX(0, bytes - OLD.size), count = MAX(0, count - 1) WHERE scope = 'user:' || OLD.user_login;
    UPDATE resource_usage SET bytes = MAX(0, bytes - OLD.size), count = MAX(0, count - 1) WHERE scope = 'r2' AND OLD.storage_type = 'R2';
    -- Daily attempts are deliberately not refunded: failed attempts may have consumed KV/R2 operations.
END;
CREATE TRIGGER resource_image_reserve BEFORE INSERT ON images
WHEN NOT EXISTS (SELECT 1 FROM resource_reservations WHERE key = NEW.key) BEGIN
    INSERT INTO resource_reservations(key, user_login, size, storage_type) VALUES(NEW.key, NEW.user_login, NEW.size, COALESCE(NEW.storage_type, 'R2'));
END;
CREATE TRIGGER resource_image_validate BEFORE INSERT ON images
WHEN EXISTS (SELECT 1 FROM resource_reservations WHERE key = NEW.key AND
    (size != NEW.size OR user_login != NEW.user_login OR storage_type != COALESCE(NEW.storage_type, 'R2'))) BEGIN
    SELECT RAISE(ABORT, 'RESOURCE_RESERVATION_MISMATCH');
END;
CREATE TRIGGER resource_image_commit AFTER INSERT ON images BEGIN
    DELETE FROM resource_reservations WHERE key = NEW.key;
END;
CREATE TRIGGER resource_image_delete AFTER DELETE ON images BEGIN
    UPDATE resource_usage SET bytes = MAX(0, bytes - OLD.size), count = MAX(0, count - 1) WHERE scope = 'user:' || OLD.user_login;
    UPDATE resource_usage SET bytes = MAX(0, bytes - OLD.size), count = MAX(0, count - 1) WHERE scope = 'r2' AND COALESCE(OLD.storage_type, 'R2') = 'R2';
END;
-- Renames reserve the temporary copy before writing it. Changing metadata transfers that reservation.
CREATE TRIGGER resource_image_move_guard BEFORE UPDATE OF key ON images WHEN NEW.key != OLD.key BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM resource_reservations WHERE key = NEW.key AND size = OLD.size
        AND user_login = OLD.user_login AND storage_type = COALESCE(OLD.storage_type, 'R2'))
        THEN RAISE(ABORT, 'RESOURCE_RESERVATION_MISMATCH') END;
END;
CREATE TRIGGER resource_image_move AFTER UPDATE OF key ON images WHEN NEW.key != OLD.key BEGIN
    UPDATE resource_usage SET bytes = MAX(0, bytes - OLD.size), count = MAX(0, count - 1) WHERE scope = 'user:' || OLD.user_login;
    UPDATE resource_usage SET bytes = MAX(0, bytes - OLD.size), count = MAX(0, count - 1) WHERE scope = 'r2' AND COALESCE(OLD.storage_type, 'R2') = 'R2';
    DELETE FROM resource_reservations WHERE key = NEW.key;
END;

CREATE TRIGGER resource_stats_guard BEFORE INSERT ON image_stats BEGIN
    SELECT CASE WHEN json_extract((SELECT value FROM system_settings WHERE key = 'resource_limits'), '$.statisticsEnabled') != 1 OR
        COALESCE((SELECT count FROM resource_usage WHERE scope = 'stats:' || date('now')), 0) >=
        json_extract((SELECT value FROM system_settings WHERE key = 'resource_limits'), '$.dailyStatisticsRecords')
        THEN RAISE(IGNORE) END;
END;
CREATE TRIGGER resource_stats_charge AFTER INSERT ON image_stats BEGIN
    INSERT INTO resource_usage(scope, count) VALUES('stats:' || date('now'), 1)
        ON CONFLICT(scope) DO UPDATE SET count = count + 1;
END;
