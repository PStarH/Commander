# Pilot Charter

Complete this charter before registering a manifest. A customer owner and a
Commander engagement owner must retain the completed version with the pilot
record.

## Required decisions

| Item                                    | Customer owner                                                | Recorded decision |
| --------------------------------------- | ------------------------------------------------------------- | ----------------- |
| Executive sponsor and platform/SRE lead | Name and escalation path                                      |                   |
| Security owner                          | Name and review outcome                                       |                   |
| Policy owner                            | Pinned `policyId` and `policyDigest`                          |                   |
| Sample owner                            | Declared sample source, selection rule, count, and exclusions |                   |
| Observation-window owner                | Start/end time in UTC and late-record handling                |                   |
| Retention owner                         | 1–30 day retention period and backup treatment                |                   |
| Deletion owner                          | Campaign withdrawal authority and evidence recipient          |                   |
| Export owner                            | Report recipient and report public-key distribution path      |                   |
| Usefulness owner                        | Decision question, success threshold, and review date         |                   |
| Mismatch adjudication owner             | Review queue, classification, and decision authority          |                   |
| Stop-condition owner                    | Immediate stop authority and communication path               |                   |

## Acceptance criteria for the historical evaluation

The charter must name a useful decision the report can inform, such as whether
the pinned policy would have required approval for records the customer marked
`allow`. It must define how the team will adjudicate each mismatch and how it
will treat `unknown` and `insufficient_evidence` records as uncomparable.

The declared sample is the only coverage claim. The report denominator is the
signed manifest count; it is not a measure of all customer activity.

## Stop conditions

Stop imports and move to withdrawal or investigation when any of the following
occurs:

- a manifest signature, digest, tenant binding, or policy digest does not
  validate;
- a proposed observation contains data outside the approved field boundary;
- PostgreSQL readiness, TLS validation, or cleanup freshness fails;
- a record conflict or cross-tenant access attempt is observed;
- the retention, deletion, export, or mismatch-adjudication owner is absent;
- the customer or Commander security owner requests a stop.

Legal/DPA review remains an external review and is not an acceptance criterion
implemented by the command-line tool.
