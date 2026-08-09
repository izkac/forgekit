# Make Reservation Confirmation Safe Under Concurrency

The dependency-free Node 22 service in `/app` confirms held reservations by
charging a payment gateway and storing the result. Sequential retries work, but
two confirmation calls can overlap at the asynchronous charge boundary and
charge the same reservation more than once.

Repair `ConfirmationService` so the following contract holds:

- simultaneous calls for one reservation with the same idempotency key share
  one confirmation operation, make exactly one payment charge, and both resolve
  to the same stored confirmation;
- while that operation is in flight, a call with a different key is rejected
  with the existing `already_confirmed` domain error and never charges;
- a failed payment is shared by its concurrent callers but does not poison a
  later retry;
- expiry remains an admission deadline: a new call at or after `expiresAt` is
  rejected without charging, while an operation admitted before the deadline
  may finish after it; and
- the existing sequential replay and HTTP behavior remain compatible.

Add a deterministic automated test in a new `src/*.test.mjs` file that forces
the overlap with deferred promises or explicit barriers and proves the
same-key exactly-once behavior. Do not use timing sleeps. Run the complete test
suite.

Do not edit or replace the pre-existing
`src/confirmation-service.test.mjs`; keep the new coverage separate.
