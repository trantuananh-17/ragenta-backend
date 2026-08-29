import { env } from "./config/env"
import { closeDatabase } from "./db/client"
import { closeQueues } from "./queue/queues"
import { closeRedis } from "./redis/client"
import { logger } from "./shared/logger"
import { registerSchedules, startWorkers } from "./workers/worker"

const log = logger.child({ process: "worker" })

const workers = startWorkers()
await registerSchedules()
log.info("worker.started", { env: env.nodeEnv, queues: workers.length })

/**
 * Closing the workers first lets in-flight jobs finish before their connections
 * go away — a job killed mid-write would be retried, and retries are only free
 * because every processor is idempotent.
 */
async function shutdown(signal: string) {
	log.info("worker.shutdown", { signal })
	await Promise.allSettled(workers.map((worker) => worker.close()))
	await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()])
	process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
