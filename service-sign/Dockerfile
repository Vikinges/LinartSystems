FROM node:20-alpine

RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY entrypoint.sh /entrypoint.sh
COPY server.js ./
COPY public ./public

RUN chown -R node:node /app \
  && chmod +x /entrypoint.sh

EXPOSE 3002

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
