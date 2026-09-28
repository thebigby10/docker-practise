#!/bin/bash
set -euo pipefail

JAVA_OPTS="${JAVA_OPTS:--XX:MaxRAMPercentage=70}"
echo "starting orders with JAVA_OPTS=${JAVA_OPTS}"
exec java ${JAVA_OPTS} -jar /app/app.jar "$@"
