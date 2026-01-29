# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache su-exec python3 make g++ sqlite

COPY package*.json ./
RUN npm install --production

COPY server.js ./
COPY public ./public
COPY entrypoint.sh /entrypoint.sh

RUN chown -R node:node /app \
  && chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3002
EXPOSE 3002

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
