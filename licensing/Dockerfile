# Soundbox license server — one zero-dependency Node process (server.mjs).
#
# Fly terminates TLS at the edge, so inside the container the server speaks plain
# HTTP on port 8787 (HOST=0.0.0.0, set in fly.toml [env]). The signing key and the
# license database live on the /data volume (LICENSE_DATA_DIR=/data) and are NEVER
# baked into the image — licensing/data/ is excluded by .dockerignore.
#
# Runs as root on purpose: Fly mounts volumes as root, and this container's only
# job is to hold the private key + db behind HTTPS + a bearer-token admin gate.
FROM node:22-alpine

WORKDIR /app

# Zero npm dependencies: copy only the server/CLI scripts, never licensing/data/.
COPY lib.mjs cli.mjs server.mjs webhook.mjs ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    LICENSE_DATA_DIR=/data

# ensureDb creates /data/licenses.json (a fresh keypair) on first boot when the
# volume is empty. See README → Production deploy: seed the volume with the db the
# released builds trust, or regenerate the keypair first.
RUN mkdir -p /data

EXPOSE 8787

CMD ["node", "server.mjs"]
