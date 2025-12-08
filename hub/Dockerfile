FROM node:18-alpine

WORKDIR /app

# Create a non-root user and group


COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev || npm install

COPY server.js services.json ./
COPY static ./static

# Change ownership of the app directory
RUN chown -R node:node /app

# Switch to the non-root user
USER node

EXPOSE 8080

CMD ["node", "server.js"]
