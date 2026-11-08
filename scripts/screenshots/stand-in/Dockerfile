FROM busybox:1.37
RUN mkdir -p /www && echo '<!doctype html><title>Demo</title><p>Gluon demo app' > /www/index.html
COPY run.sh /run.sh
ENTRYPOINT ["sh", "/run.sh"]
