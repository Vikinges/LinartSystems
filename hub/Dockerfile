FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache su-exec

COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev || npm install

COPY server.js services.json ./
COPY static ./static
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh && chown -R node:node /app

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
