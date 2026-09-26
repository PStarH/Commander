# GitHub pilot security boundary

The governed write path is Agent → Commander API/approval → PostgreSQL ledger →
worker/adapter-ops → GitHub. The read-only recovery path reuses the persisted
request. Human approval and execution credentials are separate from the Agent.

| Input or failure                         | Required behavior                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Agent attempts approval                  | API denies unless the authenticated identity has approval authority; the Agent must not have it                  |
| Same operation ID with changed request   | Gateway/broker/kernel reject the conflicting identity; creating another ID is a new proposal                     |
| Query envelope drift                     | Read `request.args`; missing title/body/head/base means UNKNOWN, without a permissive fallback                   |
| Lost response or unreadable remote state | Query or escalate; never infer NOT_APPLIED from an empty list, 403, 404, 429 or timeout                          |
| Forged or copied body marker             | Require exact marker plus approved content, branch names and same-repository identity; ambiguity remains UNKNOWN |
| Malicious pagination / redirect          | Reject cross-host/repository links and changed filters; never forward the execution credential there             |
| Excessive or stalled reads               | Maximum ten pages and a ten-second adapter budget; daemon's shorter timeout cancels the request                  |
| Wrong compensation target                | Require original key and complete persisted receipt; missing fields or mismatched PR/repo/branches block PATCH   |
| Merged PR or concurrent merge            | Never report a merge as undone; check merged state before close and reread after PATCH                           |

The body marker is a correlation tag, not a signature. Repository writers can
edit/copy it or perform actions outside Commander. Compromised admins, the
execution service, its secret manager or the database authority are outside
this pilot's containment claim. MCP is a transport, not a sandbox.

The approved action is “create this PR request”, not “approve these immutable
code bytes”. Head branches can change. The persisted/observed `headSha` does not
replace GitHub review of the current diff. GitHub does not offer the atomic
conditional close needed to eliminate a GET-to-PATCH merge race. A successful
compensation means a subsequent observation found the PR closed and unmerged;
it does not prove Commander was the only actor or reverse downstream effects.

Queries can fail to reconcile legitimate actions after body edits, deleted
branches, repository renames, permission loss or a pagination budget limit.
That deliberate uncertainty needs an operator path. The pilot rejects redirects
and requires reconfiguration after repository moves.

Full receipts remain in protected ledger state. The demo prints only selected
identifiers/metadata. Existing signed evidence export retains its stricter global
allowlist; adapter receipt fields are not automatically public evidence fields.
Use sandbox data when demonstrating and keep secrets out of transcripts.
