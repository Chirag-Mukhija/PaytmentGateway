FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The ledger lives on a mounted volume (see docker-compose.yml) so the
# bank's record of what it charged survives container restarts -- the
# PENDING resolution job and reconciliation both depend on that.
ENV FAKE_BANK_DATA_FILE=/data/transactions.jsonl
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 5000
CMD ["node", "src/index.js"]
