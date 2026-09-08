/**
 * The schedule scan.
 *
 * On the agent queue rather than the billing one: what it produces is agent
 * runs, and a scan blocked behind a slow refill would fire every schedule late.
 */
export const JOB_SCAN_TRIGGERS = "trigger.scan" as const
