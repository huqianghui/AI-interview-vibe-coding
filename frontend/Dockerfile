# AI-interview frontend — Vite/React SPA built to static assets, served by nginx which also
# reverse-proxies /api to the backend Container App (same-origin, no CORS). See nginx.conf.
#
# --- build stage -------------------------------------------------------------------------------
FROM node:20-slim AS build

WORKDIR /app

# Install deps from the lockfile first for cache-friendly layers. (Unlike the reference project,
# this frontend has NO local rt-client tarball dependency, so nothing extra to COPY here.)
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# client.ts uses the relative "/api" base, so the build needs no API URL baked in — same-origin.
RUN npm run build

# --- serve stage -------------------------------------------------------------------------------
FROM nginx:1.27-alpine

# nginx.conf is a template: BACKEND_URL is substituted at container start (its value is only known
# after the backend Container App exists). We template ONLY $BACKEND_URL and leave nginx's own
# runtime vars ($uri, $http_upgrade, ...) untouched.
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# The nginx:alpine image's entrypoint runs envsubst over /etc/nginx/templates/*.template into
# /etc/nginx/conf.d/ using only the vars named in NGINX_ENVSUBST_FILTER, then starts nginx.
ENV NGINX_ENVSUBST_FILTER=BACKEND_URL

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1
