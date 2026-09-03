# Public documentation

Product and operator docs that ship with the repository.

> **Status:** Commander is alpha and not production-ready. Deployment checklists
> describe configuration steps; they are not a production-readiness guarantee.
> See [the privacy boundary](../PRIVACY.md) before using provider-backed tasks.

| Doc | Purpose |
|-----|---------|
| [getting-started.md](./getting-started.md) | Quick start |
| [enterprise/quickstart.md](./enterprise/quickstart.md) | Dedicated enterprise pilot quickstart |
| [enterprise/workflow-template-kubernetes-rollback.md](./enterprise/workflow-template-kubernetes-rollback.md) | Supported workflow mapping |
| [enterprise/support-runbook.md](./enterprise/support-runbook.md) | Pilot operations and incident handling |
| [deploy.md](./deploy.md) | Deployment |
| [v2-migration-guide.md](./v2-migration-guide.md) | Architecture V2 migration |
| [slo.md](./slo.md) | SLO definitions |
| [architecture/](./architecture/) | Canonical architecture ADRs |
| [runbooks/](./runbooks/) | Ops runbooks |
| [security/](./security/) | Public security process docs |
| [../PRIVACY.md](../PRIVACY.md) | Data flows, storage, retention, and deletion |

Internal audits, agent plans, and diligence notes are **not** in this tree.
They live only on developer machines under `.internal/` (gitignored).
