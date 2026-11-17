-- ============================================================
-- ViteVendre v2 : schéma PostgreSQL (application vidéo type TikTok)
-- Compatible PostgreSQL 13+. Relançable sans erreur (IF NOT EXISTS).
-- ============================================================

-- ---------- Utilisateurs ----------
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  phone          TEXT NOT NULL UNIQUE CHECK (phone ~ '^\+?[0-9]{8,15}$'),
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 80),
  avatar_url     TEXT,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Vidéos ----------
-- Cycle de vie : uploading -> processing -> ready | failed
-- "ready" est atteint dès que les premières qualités (240p/480p) existent ;
-- les qualités supérieures (720p/1080p) sont ajoutées ensuite et la colonne
-- renditions est mise à jour.
CREATE TABLE IF NOT EXISTS videos (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption       TEXT NOT NULL DEFAULT '' CHECK (char_length(caption) <= 300),
  status        TEXT NOT NULL DEFAULT 'uploading'
                CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
  source_name   TEXT,                       -- fichier source dans uploads/sources/
  width         INTEGER,                    -- dimensions affichées (rotation appliquée)
  height        INTEGER,
  duration_s    NUMERIC(8, 2),
  renditions    TEXT[] NOT NULL DEFAULT '{}',   -- ex. {240p,480p,720p}
  poster_key    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_videos_feed ON videos (id DESC) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_videos_processing ON videos (id) WHERE status = 'processing';

-- ---------- Sessions d'envoi (upload reprenable par offset) ----------
-- Les octets des morceaux sont conservés dans upload_chunks. received_bytes est
-- avancé dans la même transaction que l'insertion du morceau correspondant.
-- fingerprint = signature chaînée de blocs de contenu + taille totale,
-- indépendante du nom : les blocs sont lus bornés en mémoire pour reconnaître le fichier.
CREATE TABLE IF NOT EXISTS uploads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id        BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  mime_type       TEXT NOT NULL,
  total_size      BIGINT NOT NULL CHECK (total_size > 0),
  received_bytes  BIGINT NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  fingerprint     CHAR(64) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress', 'complete', 'aborted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (received_bytes <= total_size)
);

-- Une seule session active par utilisateur et par fichier.
CREATE UNIQUE INDEX IF NOT EXISTS uq_uploads_active_fingerprint
  ON uploads (user_id, fingerprint) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_uploads_activity ON uploads (updated_at) WHERE status = 'in_progress';

-- La clé unique composite permet à chaque morceau de garantir que son video_id
-- correspond bien à la vidéo de sa session d'upload.
CREATE UNIQUE INDEX IF NOT EXISTS uq_uploads_id_video_id ON uploads (id, video_id);

-- Un morceau = une ligne BYTEA. Le numéro suit l'ordre d'arrivée; byte_offset
-- et chunk_size permettent de contrôler qu'il n'y a ni trou ni chevauchement.
CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id     UUID NOT NULL,
  video_id      BIGINT NOT NULL,
  chunk_number  BIGINT NOT NULL CHECK (chunk_number >= 0),
  byte_offset   BIGINT NOT NULL CHECK (byte_offset >= 0),
  chunk_size    INTEGER NOT NULL CHECK (chunk_size > 0),
  data          BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_number),
  FOREIGN KEY (upload_id, video_id)
    REFERENCES uploads (id, video_id) ON DELETE CASCADE,
  CHECK (octet_length(data) = chunk_size)
);

-- Les sessions commencées avant cette migration avaient leurs octets sur disque.
-- Elles repartent de zéro une seule fois; celles ayant déjà des lignes de morceaux
-- gardent leur offset, même si db:init est relancé.
UPDATE uploads u
SET received_bytes = 0
WHERE u.status = 'in_progress'
  AND u.received_bytes > 0
  AND NOT EXISTS (SELECT 1 FROM upload_chunks c WHERE c.upload_id = u.id);

-- ---------- J'aime ----------
CREATE TABLE IF NOT EXISTS video_likes (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    BIGINT  NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_video_likes_video ON video_likes (video_id);

-- ---------- Commentaires ----------
CREATE TABLE IF NOT EXISTS comments (
  id          BIGSERIAL PRIMARY KEY,
  video_id    BIGINT  NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments (video_id, id DESC);

-- ---------- Abonnements ----------
-- follower_id suit followee_id. Impossible de se suivre soi-même.
CREATE TABLE IF NOT EXISTS follows (
  follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id);
