# Tasks

## 1. Locate Cursor transcripts (F71)

- [x] 1.1 RED: host.test — Cursor agent-transcripts layout is found; Claude
      still preferred when both exist
- [x] 1.2 GREEN: extend findTranscripts (+ cursorProjectsDir test hook)

## 2. Honest degrade when format lacks usage

- [x] 2.1 RED: collect.test — found Cursor-format transcript → reason is not
      prune wording; names path / no token usage
- [x] 2.2 GREEN: collectMetrics honesty path

## 3. Product-loop e2e

- [x] 3.1 E2e plants Cursor layout, asserts findTranscripts found + collect
      reason. Status: `CURSOR-TRANSCRIPT found=1 prune-wording=0`
