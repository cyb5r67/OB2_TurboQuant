-- OB2 initial database setup.
-- Runs once when the pgvector container first starts.

CREATE EXTENSION IF NOT EXISTS vector;

-- The StorageBackend creates tables on first connection, but having the
-- extension ready avoids a CREATE EXTENSION inside the app code needing
-- superuser privileges on some hosting platforms.
