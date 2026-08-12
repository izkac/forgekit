FROM node:22-bookworm-slim
WORKDIR /app
COPY test.sh /tests/test.sh
COPY grader.mjs /tests/grader.mjs
COPY resolve-shared.mjs /tests/resolve-shared.mjs
COPY hidden-probe.mjs /tests/hidden-probe.mjs
COPY http-runtime.mjs /tests/http-runtime.mjs
COPY false-completion.mjs /tests/false-completion.mjs
COPY carryover-precondition.mjs /tests/carryover-precondition.mjs
COPY episode-01-checks.mjs /tests/episode-01-checks.mjs
COPY episode-02-checks.mjs /tests/episode-02-checks.mjs
COPY episode-03-checks.mjs /tests/episode-03-checks.mjs
ENV HARBOR_UNTRUSTED_UID=65534 \
    HARBOR_UNTRUSTED_GID=65534
RUN chmod +x /tests/test.sh \
  && chmod -R 700 /tests \
  && mkdir -p /logs/verifier \
  && chmod 700 /logs/verifier
