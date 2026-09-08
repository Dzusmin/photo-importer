# Backup job lifecycle

Backup planning and execution are separate backend jobs. Both run outside the
UI thread and expose their current state through list commands and progress
events. At most one planning job may run for a given target; a subsequent
request returns the identifier of the job that is already running.

## Persistence

Active jobs and completed plans intentionally remain in process memory. When
the process exits, the worker ceases to exist, so restoring a record in the
`running` state would be misleading. A completed plan contains hashes and paths
that represent a snapshot of the library; after restarting the application, it
must be generated again instead of executing a potentially stale plan.

Execution results stored in the target's SQLite manifest are persistent. If
the application is to resume work after a process restart in the future, it
must persist the worker checkpoint (including its phase and a safe resume
point) and mark orphaned records as interrupted at startup before resuming
them.
