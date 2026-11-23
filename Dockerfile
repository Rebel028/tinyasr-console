# Static test console for tinyasr-server; the browser talks to the server directly.
FROM nginx:1-alpine
COPY public /usr/share/nginx/html
