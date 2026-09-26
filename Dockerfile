# One image for both the API (default command) and the worker
# (docker-compose overrides the command with `node src/worker.js`).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, source second: Docker caches each layer, so a code
# change reuses the (slow) npm install layer as long as package*.json
# didn't change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Don't run as root inside the container: if the app is ever compromised,
# the attacker gets an unprivileged user, not root.
USER node

EXPOSE 3000

# Exec form (a JSON array), not `CMD node src/index.js`: the shell form
# wraps node in /bin/sh, which does NOT forward SIGTERM -- so the graceful
# shutdown handler would never run and every `docker stop` would end in a
# SIGKILL after the grace period.
CMD ["node", "src/index.js"]
