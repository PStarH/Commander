# Retention, Withdrawal, and Teardown

The charter sets one retention period between 1 and 30 days. The retention owner
runs `retention run` on the agreed schedule and monitors cleanup freshness.
Expired campaign data is deleted from the authoritative PostgreSQL schema.

## Export before deletion

The export owner may create the required historical record with `report export
--campaign --output`. The recipient independently checks it with `report verify
--bundle --public-key --manifest-keys` using the separately distributed report
and manifest trust records and retains it according to the customer's records
policy.
An export is a copy; the customer must decide how any backup or recipient copy is
handled.

## Withdrawal

The deletion owner uses `campaign withdraw --campaign --confirm` and must type
the exact campaign identifier as the confirmation value. Withdrawal stops further
campaign ingestion, deletes payload, and keeps only the minimum withdrawn
campaign tombstone plus a hashed deletion audit. It does not delete a report
already exported, PostgreSQL backups, or records outside the dedicated schema.

## Teardown checklist

- Confirm the export recipient and retention owner have recorded the outcome.
- Run campaign withdrawal and record the JSON result.
- Use the tenant's reader login for the authoritative check. Confirm `tenant_bound`
  is true and the count is zero in the same transaction. A false or null binding
  invalidates the count; the readiness-only `status` command does not count campaigns:

  ```sql
  BEGIN;
  SELECT set_config('commander_shadow.tenant_id', 'tenant-1', true);
  SELECT commander_shadow.tenant_access_allowed('tenant-1') AS tenant_bound;
  SELECT count(*)
    FROM commander_shadow.campaigns
   WHERE tenant_id = 'tenant-1' AND state <> 'withdrawn';
  COMMIT;
  ```

- Remove the customer’s Shadow-specific PostgreSQL roles, schema, key references,
  and deployment configuration using the customer change process.
- Remove or expire report public-key distribution entries according to the
  customer key-management process.
- Track backup deletion and legal/DPA obligations through the customer’s external
  review process.

The customer may stop the pilot at any time. A stop does not make a statement
about policy quality or historical coverage.
