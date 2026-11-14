#!/bin/sh
# Zorgt dat de map(pen) voor database en uploads bestaan en schrijfbaar zijn voor de gebruiker "node"
# (een gekoppelde schijf is standaard van root), en start daarna de app zonder root-rechten.
# Lukt iets hiervan niet, dan start de app toch (eventueel als root), zodat de site nooit platligt.
for f in "${CRM_DB:-/app/data/crm.db}" "${CRM_UPLOADS:-/app/data/uploads}/x"; do
  d=$(dirname "$f")
  mkdir -p "$d" 2>/dev/null || echo "[start] Kan map $d niet aanmaken"
  if [ "$(id -u)" = "0" ]; then chown -R node:node "$d" 2>/dev/null || echo "[start] Kan rechten van $d niet aanpassen"; fi
done
if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1 && id node >/dev/null 2>&1; then
  exec su-exec node "$@"
fi
exec "$@"
