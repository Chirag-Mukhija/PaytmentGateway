# No dependencies -- merchant-mock only uses Node's built-in http/crypto.
FROM node:22-alpine
WORKDIR /app
COPY index.js ./
USER node
EXPOSE 4000
CMD ["node", "index.js"]
