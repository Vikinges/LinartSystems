# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache su-exec

COPY package*.json ./
RUN npm install --production

# Copy only necessary files
COPY server.js mapping.json fields.json ./
COPY public ./public
COPY data/admin.json data/projects.json data/templates.json ./data/
COPY entrypoint.sh /entrypoint.sh

RUN chown -R node:node /app \
  && chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
