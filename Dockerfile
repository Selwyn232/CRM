# Robin Foundation CRM — geen dependencies nodig, alleen Node.js met ingebouwde SQLite.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Database en uploads staan in /app/data (koppel hier een persistente schijf aan om gegevens te bewaren).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# Render (en andere hosts) geven de poort mee via $PORT; standaard 3000.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
