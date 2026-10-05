FROM nginx:1.27-alpine

# @intent Install lightweight reverse proxy that renders host-based routes at runtime
RUN rm -f /etc/nginx/conf.d/default.conf

# @intent Long hostnames from routes require larger server_names hash bucket (default 64 fails).
COPY reverse-proxy/00-server-names-hash-bucket.conf /etc/nginx/conf.d/00-server-names-hash-bucket.conf

# @intent Build context is component root (infra-docker). Routes list mounted at runtime (generated/reverse-proxy-routes.txt).
COPY reverse-proxy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]


