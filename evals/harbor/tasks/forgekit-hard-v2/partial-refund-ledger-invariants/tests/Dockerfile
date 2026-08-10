FROM node:22-bookworm-slim
WORKDIR /app
COPY test.sh /tests/test.sh
COPY grader.mjs /tests/grader.mjs
COPY hidden-probe.mjs /tests/hidden-probe.mjs
COPY mutants/ /tests/mutants/
ENV HARBOR_UNTRUSTED_UID=65534 \
    HARBOR_UNTRUSTED_GID=65534
RUN chmod +x /tests/test.sh \
  && chmod -R 700 /tests \
  && mkdir -p /logs/verifier \
  && chmod 700 /logs/verifier
