/**
 * Housekeeping that runs on a clock and that nobody waits on.
 *
 * These ride the **billing** queue rather than getting one of their own. The
 * codebase splits queues by what one job blocks — ingestion holds memory, an
 * agent run holds a provider stream open for minutes — and a nightly sweep
 * blocks nothing: it is a bounded delete with no user behind it. A queue and a
 * Redis connection per housekeeping task would be infrastructure bought for a
 * naming preference.
 */
/**
 * The nightly sweep. Named for the first table it trimmed and now covering the
 * webhook delivery log too — one job rather than one per table, because they run
 * on the same schedule, read the same retention setting, and a second repeatable
 * job would be a second thing to notice had stopped firing.
 */
export const JOB_PRUNE_PROVIDER_ERRORS = "maintenance.prune-provider-errors" as const
