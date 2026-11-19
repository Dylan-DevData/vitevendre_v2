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
  source_name   TEXT,                       -- MP4 source dans uploads/sources/
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
-- Les fichiers des morceaux sont stockés sous uploads/sessions/*.part.
-- PostgreSQL conserve seulement les références des morceaux; octets et tailles sont
-- sur disque. L'offset de reprise est calculé depuis les fichiers .part.
-- fingerprint contient une clé de tâche aléatoire (session-key-v2) pour rendre POST idempotent.
-- Les anciennes tâches content-chain-v1 restent acceptées pendant leur reprise.
CREATE TABLE IF NOT EXISTS uploads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id        BIGINT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  mime_type       TEXT NOT NULL,
  fingerprint     CHAR(64) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress', 'complete', 'aborted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Taille totale et offset sont conservés dans le fichier de session .meta.json;
-- retirer les anciennes colonnes SQL après db:init les avoir exportées sur disque.
DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'uploads'::regclass
      AND contype = 'c'
      AND lower(pg_get_constraintdef(oid)) ~ '(total_size|received_bytes)'
  LOOP
    EXECUTE format('ALTER TABLE uploads DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;
ALTER TABLE uploads DROP COLUMN IF EXISTS total_size;
ALTER TABLE uploads DROP COLUMN IF EXISTS received_bytes;

-- Une seule session active par utilisateur et par fichier.
CREATE UNIQUE INDEX IF NOT EXISTS uq_uploads_active_fingerprint
  ON uploads (user_id, fingerprint) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_uploads_activity ON uploads (updated_at) WHERE status = 'in_progress';

-- La clé unique composite permet à chaque morceau de garantir que son video_id
-- correspond bien à la vidéo de sa session d'upload.
CREATE UNIQUE INDEX IF NOT EXISTS uq_uploads_id_video_id ON uploads (id, video_id);

-- Une ligne de morceau conserve uniquement son association et sa référence de fichier.
CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id     UUID NOT NULL,
  video_id      BIGINT NOT NULL,
  chunk_number  BIGINT NOT NULL CHECK (chunk_number >= 0),
  part_name     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_number),
  FOREIGN KEY (upload_id, video_id)
    REFERENCES uploads (id, video_id) ON DELETE CASCADE
);

-- Migration: db:init exporte d'abord les anciens BYTEA en .part. On remplit les
-- références manquantes, puis on supprime le stockage binaire et ses tailles SQL.
ALTER TABLE upload_chunks ADD COLUMN IF NOT EXISTS part_name TEXT;
DO $$
DECLARE constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'upload_chunks'::regclass
      AND contype = 'c'
      AND lower(pg_get_constraintdef(oid)) ~ '(data|chunk_size|byte_offset)'
  LOOP
    EXECUTE format('ALTER TABLE upload_chunks DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;
UPDATE upload_chunks
SET part_name = upload_id::text || '.' || chunk_number::text || '.part';
ALTER TABLE upload_chunks ALTER COLUMN part_name SET NOT NULL;
ALTER TABLE upload_chunks DROP COLUMN IF EXISTS data;
ALTER TABLE upload_chunks DROP COLUMN IF EXISTS chunk_size;
ALTER TABLE upload_chunks DROP COLUMN IF EXISTS byte_offset;

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
