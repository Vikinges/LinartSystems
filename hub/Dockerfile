FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
