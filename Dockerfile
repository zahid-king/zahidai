FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY frontend ./frontend
EXPOSE 3000
CMD ["node", "--env-file-if-exists=.env", "server.js"]
