CREATE EXTENSION IF NOT EXISTS timescaledb;

ALTER USER postgres WITH PASSWORD 'postgres';

CREATE TABLE IF NOT EXISTS users (
    id       SERIAL PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    hash     VARCHAR(255) NOT NULL,
    role     VARCHAR(50)  NOT NULL DEFAULT 'viewer',
    time     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
    id      SERIAL PRIMARY KEY,
    message VARCHAR(255) NOT NULL,
    time    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS intersections (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(255) NOT NULL,
    latitude  FLOAT,
    longitude FLOAT,
    time      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS streets (
    id              SERIAL PRIMARY KEY,
    intersection_id INTEGER NOT NULL REFERENCES intersections(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    time            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cctvs (
    id              SERIAL PRIMARY KEY,
    intersection_id INTEGER NOT NULL REFERENCES intersections(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    rtsp_url        VARCHAR(255) NOT NULL,
    status          VARCHAR(50)  NOT NULL DEFAULT 'offline',
    is_being_viewed BOOLEAN      NOT NULL DEFAULT FALSE,
    time            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
    id                SERIAL PRIMARY KEY,
    cctv_id           INTEGER     NOT NULL UNIQUE REFERENCES cctvs(id) ON DELETE CASCADE,
    worker_pid        INTEGER     NOT NULL,
    last_seen         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claim_version     INTEGER     NOT NULL DEFAULT 0,
    status            VARCHAR(50) NOT NULL DEFAULT 'running',
    frames_per_second FLOAT
);

CREATE TABLE IF NOT EXISTS regions (
    id        SERIAL PRIMARY KEY,
    cctv_id   INTEGER NOT NULL REFERENCES cctvs(id)   ON DELETE CASCADE,
    street_id INTEGER NOT NULL REFERENCES streets(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL DEFAULT 'unknown',
    time      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS region_points (
    id        SERIAL PRIMARY KEY,
    region_id INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    x         FLOAT   NOT NULL,
    y         FLOAT   NOT NULL,
    time      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS videos (
    id               SERIAL PRIMARY KEY,
    intersection_id  INTEGER REFERENCES intersections(id) ON DELETE SET NULL,
    uploaded_by      INTEGER REFERENCES users(id)         ON DELETE SET NULL,
    filename         VARCHAR(255) NOT NULL,
    filepath         VARCHAR(255) NOT NULL,
    recorded_at      TIMESTAMPTZ,
    duration_seconds INTEGER,
    total_frames     INTEGER,
    processed_frames INTEGER     NOT NULL DEFAULT 0,
    status           VARCHAR(50) NOT NULL DEFAULT 'pending',
    uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at     TIMESTAMPTZ
);


CREATE TABLE IF NOT EXISTS detections (
    id          BIGSERIAL,
    cctv_id     INTEGER     NOT NULL REFERENCES cctvs(id)  ON DELETE CASCADE,
    video_id    INTEGER              REFERENCES videos(id) ON DELETE SET NULL,
    track_id    INTEGER,
    object_type VARCHAR(50) NOT NULL,
    confidence  FLOAT       NOT NULL,
    x1          FLOAT       NOT NULL,
    y1          FLOAT       NOT NULL,
    x2          FLOAT       NOT NULL,
    y2          FLOAT       NOT NULL,
    time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, time)
);

-- No FK on detection_id - hypertable cross-chunk FK limitation (see above).
CREATE TABLE IF NOT EXISTS detections_in_regions (
    id           SERIAL PRIMARY KEY,
    region_id    INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    detection_id BIGINT  NOT NULL,
    time         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recommendations (
    id                   SERIAL PRIMARY KEY,
    intersection_id      INTEGER NOT NULL REFERENCES intersections(id) ON DELETE CASCADE,
    warrant_1_met        BOOLEAN NOT NULL DEFAULT FALSE,
    warrant_1_confidence FLOAT   NOT NULL DEFAULT 0.0,
    warrant_2_met        BOOLEAN NOT NULL DEFAULT FALSE,
    warrant_2_confidence FLOAT   NOT NULL DEFAULT 0.0,
    warrant_4_met        BOOLEAN NOT NULL DEFAULT FALSE,
    warrant_4_confidence FLOAT   NOT NULL DEFAULT 0.0,
    recommended          BOOLEAN NOT NULL DEFAULT FALSE,
    notes                TEXT,
    generated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT        NOT NULL UNIQUE,
    p256dh     TEXT        NOT NULL,
    auth       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64)  NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ  NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);


SELECT create_hypertable(
    'detections',
    'time',
    chunk_time_interval => INTERVAL '1 hour',
    if_not_exists       => TRUE
);

SELECT add_retention_policy(
    'detections',
    INTERVAL '72 hours',
    if_not_exists => TRUE
);

CREATE OR REPLACE VIEW detection_street_view AS
SELECT
    d.id            AS detection_id,
    d.cctv_id,
    d.video_id,
    d.track_id,
    d.object_type,
    d.confidence,
    d.x1,
    d.y1,
    d.x2,
    d.y2,
    d.time,
    dir.id          AS detection_in_region_id,
    r.id            AS region_id,
    r.direction,
    s.id            AS street_id,
    s.name          AS street_name,
    i.id            AS intersection_id,
    i.name          AS intersection_name
FROM detections            d
JOIN detections_in_regions dir ON dir.detection_id = d.id
JOIN regions               r   ON r.id  = dir.region_id
JOIN streets               s   ON s.id  = r.street_id
JOIN intersections         i   ON i.id  = s.intersection_id;


CREATE MATERIALIZED VIEW IF NOT EXISTS aggregation_summaries
WITH (timescaledb.continuous) AS
SELECT
    i.id                            AS intersection_id,
    s.id                            AS street_id,
    r.direction,
    d.object_type,
    time_bucket('1 minute', d.time) AS window_start,
    COUNT(*)                        AS count
FROM detections            d
JOIN detections_in_regions dir ON dir.detection_id = d.id
JOIN regions               r   ON r.id  = dir.region_id
JOIN streets               s   ON s.id  = r.street_id
JOIN intersections         i   ON i.id  = s.intersection_id
GROUP BY
    i.id,
    s.id,
    r.direction,
    d.object_type,
    time_bucket('1 minute', d.time)
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'aggregation_summaries',
    start_offset      => INTERVAL '10 minutes',
    end_offset        => INTERVAL '30 seconds',
    schedule_interval => INTERVAL '30 seconds',
    if_not_exists     => TRUE
);

-- ============================================================
-- INDEXES
-- ============================================================

-- streets
CREATE INDEX IF NOT EXISTS idx_streets_intersection_id  ON streets               (intersection_id);

-- cctvs
CREATE INDEX IF NOT EXISTS idx_cctvs_intersection_id    ON cctvs                 (intersection_id);

-- worker_heartbeats
CREATE INDEX IF NOT EXISTS idx_heartbeats_last_seen     ON worker_heartbeats     (last_seen);

-- regions
CREATE INDEX IF NOT EXISTS idx_regions_cctv_id          ON regions               (cctv_id);
CREATE INDEX IF NOT EXISTS idx_regions_street_id        ON regions               (street_id);

-- region_points
CREATE INDEX IF NOT EXISTS idx_region_points_region_id  ON region_points         (region_id);

-- videos
CREATE INDEX IF NOT EXISTS idx_videos_intersection_id   ON videos                (intersection_id);
CREATE INDEX IF NOT EXISTS idx_videos_uploaded_by       ON videos                (uploaded_by);

-- detections (TimescaleDB propagates indexes to each chunk automatically)
CREATE INDEX IF NOT EXISTS idx_detections_cctv_time     ON detections            (cctv_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_detections_video_id      ON detections            (video_id);

-- detections_in_regions (no FK on either column → no auto-index)
CREATE INDEX IF NOT EXISTS idx_dir_detection_id         ON detections_in_regions (detection_id);
CREATE INDEX IF NOT EXISTS idx_dir_region_id            ON detections_in_regions (region_id);

-- recommendations
CREATE INDEX IF NOT EXISTS idx_recommendations_intersection ON recommendations   (intersection_id);

-- push_subscriptions
CREATE INDEX IF NOT EXISTS idx_push_user_id             ON push_subscriptions    (user_id);

-- user_sessions
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions (token_hash);
CREATE        INDEX IF NOT EXISTS idx_user_sessions_user_id    ON user_sessions (user_id);
CREATE        INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions (expires_at);

-- aggregation_summaries
CREATE INDEX IF NOT EXISTS idx_agg_intersection_window  ON aggregation_summaries (intersection_id, window_start DESC);
CREATE INDEX IF NOT EXISTS idx_agg_street_window        ON aggregation_summaries (street_id,       window_start DESC);

-- ============================================================
-- DEFAULT ADMIN USER
-- Password: admin  (bcrypt cost 12) - change after first login.
-- ============================================================

INSERT INTO users (username, hash, role)
VALUES ('admin', '$2b$12$QvuwsKfyfJa4nEJ4At.PfeLcgMh78JC5OZwPh2rg3jp6mMnvJHb0O', 'admin')
ON CONFLICT (username) DO NOTHING;
