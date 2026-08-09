FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a

WORKDIR /app
COPY test.sh /tests/test.sh
COPY grader.mjs /tests/grader.mjs
COPY original-src/ /tests/original-src/
# Only the root grader can read hidden checks or write verifier rewards. All
# agent-controlled application and test processes run with the nobody identity.
ENV HARBOR_UNTRUSTED_UID=65534 \
    HARBOR_UNTRUSTED_GID=65534
RUN chmod +x /tests/test.sh \
  && chmod -R 700 /tests \
  && mkdir -p /logs/verifier \
  && chmod 700 /logs/verifier
