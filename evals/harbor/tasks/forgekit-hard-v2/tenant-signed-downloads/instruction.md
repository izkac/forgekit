# Bind Signed Downloads to Their Tenant

The dependency-free Node 22 service in `/app` issues HMAC capabilities for
tenant document downloads. Ordinary downloads work, but the capability does
not enforce the complete tenant-isolation contract.

Repair the service so that:

- the authenticated tenant, tenant in the route, tenant covered by the signed
  capability, and tenant used for document storage all agree;
- a capability canonically binds the tenant ID, document ID, and integer
  `expiresAt` value rather than relying on ambiguous string concatenation;
- verification rejects a capability at the exact instant
  `now >= expiresAt`;
- malformed expiry or signature input fails closed without crashing or
  returning document bytes; and
- valid same-tenant downloads retain their existing bytes, content type, and
  content-disposition behavior.

Keep the service dependency-free and preserve the manual clock and injected
store seams. Add a deterministic automated regression test in a new
`src/*.test.mjs` file that proves tenant isolation at the HTTP boundary. Run
the complete test suite.

Do not edit or replace the pre-existing visible test files.
