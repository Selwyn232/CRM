# Robin Foundation CRM — Node.js met ingebouwde SQLite (+ Anthropic-SDK voor vertalen).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# su-exec: start de app als gewone gebruiker nadat de map voor gegevens rechten heeft gekregen.
RUN apk add --no-cache su-exec

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data && chown -R node:node /app && chmod +x /app/docker-entrypoint.sh

# Render (en andere hosts) geven de poort mee via $PORT; standaard 3000.
ENV PORT=3000
EXPOSE 3000

# Gegevens: standaard /app/data. Met een vaste schijf (bv. Render Disk op /var/data) zet je
# CRM_DB=/var/data/crm.db en CRM_UPLOADS=/var/data/uploads; het startscript geeft die map de juiste rechten.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
