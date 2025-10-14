FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install
COPY . .
EXPOSE 3001
CMD ["node","index.js"]
