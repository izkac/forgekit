FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a

WORKDIR /app
COPY test.sh /tests/test.sh
COPY grader.mjs /tests/grader.mjs
# Only the root grader may read hidden verifier sources and write rewards.
# Agent-controlled application code and tests always execute as nobody.
ENV HARBOR_UNTRUSTED_UID=65534 \
    HARBOR_UNTRUSTED_GID=65534
RUN chmod +x /tests/test.sh \
  && chmod -R 700 /tests \
  && mkdir -p /logs/verifier \
  && chmod 700 /logs/verifier
