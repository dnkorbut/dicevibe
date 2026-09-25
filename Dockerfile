# dicevibe in a container.
#
# There is no build step, no database and nothing written to disk at runtime, so
# this is a dependency install, three source directories and an unprivileged user
# to run them as. The image is the game and nothing else.
#
#   docker build -t dicevibe .
#   docker run --rm -p 8888:8888 dicevibe
#
# `podman build` and `podman run` take exactly the same arguments.

# Node 24 (active LTS) on Alpine. Anything from 20.11 up works — the server uses
# `import.meta.dirname`.
FROM node:24-alpine

# Socket.IO reads this for its own defaults, and it keeps npm from looking at
# anything a device would not need.
ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, and only the two files that describe them, so editing a
# source file reuses this layer instead of reinstalling eighty packages.
#
# `ci` installs the lockfile exactly rather than resolving anything fresh, and
# `--omit=dev` drops socket.io-client, which only the test suite uses.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The three directories the server actually uses: `server/` is the game,
# `shared/` is the rules module both halves import and is served over HTTP, and
# `public/` is the client. `test/` and `docs/` stay out — the suite runs on the
# host, not in here.
COPY server ./server
COPY shared ./shared
COPY public ./public

# Nothing in the image is written at runtime, so the unprivileged `node` user the
# official image already ships can own all of it. Without this the server would
# run as root, which is the one privilege escalation a container cannot undo.
USER node

# The one setting that differs from the host: `npm start` still listens on the
# server's own default of 3000, and the image overrides it here rather than
# changing that default, so neither way of running it surprises anyone. The
# healthcheck below reads `PORT`, so it follows this without being told.
#
# `EXPOSE` is documentation and publishes nothing — `-p` on `docker run` is what
# decides which port on your machine answers.
ENV PORT=8888
EXPOSE 8888

# `/healthz` is the endpoint the test suite already waits on. Node's own `fetch`
# keeps curl out of the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Exec form, so `node` is PID 1 and receives `docker stop`'s SIGTERM directly —
# the server handles it (see the bottom of server/index.js) and a game stops in
# milliseconds rather than at the end of the grace period.
CMD ["node", "server/index.js"]
