# Postgres & pgAdmin — Default Settings

This document describes the default credentials and connection settings for the
`ob2-postgres` and `ob2-pgadmin` services defined in
[`docker/docker-compose.yml`](../docker/docker-compose.yml).

## Postgres (`ob2-postgres`)

Service: `pgvector/pgvector:pg17` (docker-compose.yml:144)

| Setting       | Value                                |
| ------------- | ------------------------------------ |
| Database      | `ob2`                                |
| Username      | `ob2`                                |
| Password      | `${OB2_PG_PASSWORD:-ob2secret}`      |
| Container     | `ob2-postgres`                       |
| Internal port | `5432`                               |
| Host port     | `${OB2_PG_PORT:-5433}`               |

### Connection URLs

- **Inside the docker network** (used by `ob2-server`, see docker-compose.yml:28):
  ```
  postgres://ob2:ob2secret@ob2-postgres:5432/ob2
  ```
- **From the host machine** (see `.env.example:16`):
  ```
  postgres://ob2:ob2secret@127.0.0.1:5433/ob2
  ```

Replace `ob2secret` with the value of `OB2_PG_PASSWORD` if you have overridden
it in your `.env` file.

## pgAdmin (`ob2-pgadmin`)

Service: `dpage/pgadmin4:latest` (docker-compose.yml:163)

| Setting    | Value                                |
| ---------- | ------------------------------------ |
| URL        | `http://localhost:${OB2_PGADMIN_PORT:-5051}` (default `http://localhost:5051`) |
| Login email| `admin@ob2.com`                      |
| Password   | `${OB2_PG_PASSWORD:-ob2secret}` (same as Postgres) |

### Registering the Postgres server in pgAdmin

pgAdmin does not auto-register the `ob2-postgres` server. After logging in,
add a new server with these values:

| Field                | Value                                  |
| -------------------- | -------------------------------------- |
| Host name / address  | `ob2-postgres`  *(container name — not `localhost`, since pgAdmin runs in the same docker network)* |
| Port                 | `5432`  *(internal port, not the host-mapped `5433`)* |
| Maintenance database | `ob2`                                  |
| Username             | `ob2`                                  |
| Password             | `${OB2_PG_PASSWORD}` (or `ob2secret`)  |

## Environment variable overrides

Set any of these in `.env` to override defaults:

| Variable            | Default     | Effect                                    |
| ------------------- | ----------- | ----------------------------------------- |
| `OB2_PG_PASSWORD`   | `ob2secret` | Password for both Postgres and pgAdmin    |
| `OB2_PG_PORT`       | `5433`      | Host port mapped to Postgres `5432`       |
| `OB2_PGADMIN_PORT`  | `5051`      | Host port mapped to pgAdmin `80`          |
