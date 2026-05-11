# Context

## Domain Language

- **Account**: A Claude account entity. It has an `index` (integer), an `email` (string), and `quotas`.
- **Quota**: Usage limits for an account. There are two windows: `5h` (5 hours) and `7d` (7 days). Each quota has a `percentage` used and a `reset_time`.
- **CLI Adapter**: The low-level interface to the `cswap` and `claude` command-line tools.
- **Auto-activate**: The behavior of automatically switching to an account when its quota is available.
- **Audit Log**: A persistent record of system actions, switches, and execution results.

## Architecture Goals

- **Depth**: We want to hide the "how" of CLI interactions (exec, regex, error strings) behind a deep interface that speaks in terms of **Accounts** and **Actions**.
- **Locality**: Parsing logic and command formatting should live together in the **Claude Interface Module**.
- **Seams**: We want a clear seam between the domain logic (scheduling, API) and the external system (the CLI tools).
