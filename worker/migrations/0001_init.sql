-- Crash-test results database (D1). One row per scorecard in `runs`, one row per test in
-- `results`. A run's id is the SHA-256 of its canonical scorecard, so uploading the same
-- scorecard twice changes nothing. The full scorecard is kept as JSON for evidence.

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  network_url     TEXT NOT NULL,
  network_sha256  TEXT,
  model           TEXT NOT NULL,
  router          TEXT,
  judge           TEXT,
  test_version    INTEGER NOT NULL,
  runs_per_test   INTEGER NOT NULL,
  score           INTEGER NOT NULL,
  errors          INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL,
  finished_at     TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('cli', 'ci', 'matrix', 'attestation', 'backfill', 'site')),
  ingested_at     TEXT NOT NULL,
  scorecard_json  TEXT NOT NULL
);

CREATE INDEX runs_by_network ON runs (network_url, model, finished_at);
CREATE INDEX runs_by_finished ON runs (finished_at);

CREATE TABLE results (
  run_id      TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  test_id     TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  pass_rate   REAL NOT NULL,
  passes      INTEGER NOT NULL,
  applicable  INTEGER NOT NULL,
  judged      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, test_id)
);

CREATE INDEX results_by_test ON results (test_id, verdict);
