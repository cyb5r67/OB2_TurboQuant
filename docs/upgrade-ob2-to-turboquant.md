# Upgrading existing `ob2`-stack deployments to `ob2_turboquant`

Phase 2 renames the Docker Compose project from `ob2` to `ob2_turboquant` and pins every
named volume so future renames cost nothing. Existing operators must perform a one-time
data migration.

**You only do this ONCE.** Fresh deployments (operators starting from scratch on Phase 2+)
skip this entirely and never have to think about the rename again.

## What changes

Before: Docker Compose used `name: ob2` and named volumes without `name:` overrides, so
on disk Docker created `ob2_ob2_data`, `ob2_ob2_pgdata`, `ob2_ob2_openwebui_data`.

After Phase 2: project is `ob2_turboquant`, and volumes have explicit `name:` pins. The
on-disk volume names become `ob2_data`, `ob2_pgdata`, `ob2_openwebui_data`. Same data,
different on-disk names — Compose creates *new empty* volumes if you don't migrate.

## Before you start

- Stop the stack: `cd /path/to/OB2_TurboQuant && scripts/docker-stop.sh`.
- Take a snapshot or backup of `ob2_ob2_pgdata` (this is your pgvector knowledge base —
  most operators care most about preserving this). On Linux: `docker run --rm -v
  ob2_ob2_pgdata:/from -v $(pwd):/backup alpine tar czf /backup/pgdata.tgz -C /from .`.
- Pull the latest `feat/llamacpp-phase2` changes (or whichever branch you're upgrading
  from) so the new compose file is in place.

## Migration

For each of the three legacy volumes, copy contents into the new pinned name:

```bash
for VOL in ob2_data ob2_pgdata ob2_openwebui_data; do
  echo "Migrating ob2_$VOL → $VOL ..."
  docker volume create "$VOL"
  docker run --rm -v "ob2_$VOL":/from -v "$VOL":/to alpine \
    sh -c "cp -a /from/. /to/ && echo OK"
done
```

That `cp -a` preserves ownership and timestamps.

## Verify before deleting the originals

Start the stack: `scripts/docker-start.sh`. Confirm:

1. The dashboard at `http://localhost:7600/dashboard` lists your existing domains and document counts.
2. A test chat against a domain you previously used returns answers grounded in your knowledge base.
3. (If using Open WebUI) Open WebUI at `http://localhost:7601` shows your existing chat history.

If everything looks right, drop the legacy volumes:

```bash
docker volume rm ob2_ob2_data ob2_ob2_pgdata ob2_ob2_openwebui_data
```

## Rollback

If something goes wrong and you want to back out:

```bash
scripts/docker-stop.sh
# Roll back the compose file by checking out the pre-Phase-2 commit, or revert
# `name: ob2_turboquant` to `name: ob2` and remove the volume `name:` pins.
```

The legacy volumes (`ob2_ob2_*`) are unchanged — you can re-launch against the old shape.

## Why we did this

Without the `name:` pins, EVERY future stack rename would force operators through this
same dance. With pinned names, the rename happens once and the data names are stable forever.
