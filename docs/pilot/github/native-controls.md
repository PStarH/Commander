# When GitHub's native controls are enough

If your only requirement is “let an automation create a PR, then review and
merge it”, start with GitHub App permissions, repository rules, required checks,
and GitHub Actions environments. GitHub CLI checks for an existing PR;
`peter-evans/create-pull-request` also handles create/update. Avoiding a duplicate
PR by itself is not a reason to deploy Commander.

Commander is aimed at teams that need a shared action identity, approval binding,
durable uncertain-result state and evidence across multiple agent entry points.
Its proposed value is reusable integration and recovery behavior. Whether that
saves enough work to justify another service requires customer trials.

| Control                         | Native role                                                     | Commander pilot role                                                                                        |
| ------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| GitHub App permissions          | Limit repository/API access                                     | Keep execution token out of agent processes; narrow the action request further                              |
| Actions environment review      | Gate jobs, protect secrets, prevent self-review when configured | Bind a human approval to the exact action proposed via Gateway/MCP                                          |
| PR reviews and checks           | Decide whether code may merge                                   | Still required; Commander does not merge or approve a code snapshot                                         |
| Kubernetes RBAC/admission       | Control Kubernetes resources and requests                       | Outside this GitHub pilot; does not replace these controls                                                  |
| Workflow engine / custom script | Can persist state and implement query-before-retry              | Reuse the adapter contract, durable action state and evidence instead of wiring each entry point separately |

For a fair comparison use the same repository, branches, credentials and failure
point. Let native tools query existing PRs and persist their own operation state.
A native solution that stops safely at UNKNOWN is a correct result, not a loss.
Compare setup/maintenance effort, number of writes, operator steps, permission
separation and evidence available after restart. Do not construct a baseline
that blindly POSTs repeatedly or lacks permissions the Commander side has.

GitHub does not promise to deduplicate PR creation using a Commander key.
Commander does not guarantee universal exactly-once effects. Its adapter's
preflight lookup is not a distributed lock; the production broker/ledger binds
and coordinates the approved operation.

Primary references:

- [GitHub pull request API](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [Deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub CLI PR create](https://cli.github.com/manual/gh_pr_create)
- [create-pull-request](https://github.com/peter-evans/create-pull-request)
- [Temporal Activity definition and idempotency](https://docs.temporal.io/activity-definition)
