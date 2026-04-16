#!/bin/sh
set -e
echo "Running database migrations..."
cd /app/apps/api
npx prisma migrate deploy
echo "Starting API..."
exec node /app/apps/api/dist/main.js
