import { serve } from "@hono/node-server"

import { createApp } from "./api/app"
import { env } from "./config/env"
import { closeDatabase } from "./db/client"
import { closeQueues } from "./queue/queues"
import { closeRedis } from "./redis/client"
import { logger } from "./shared/logger"

const log = logger.child({ process: "api" })

const server = serve({ fetch: createApp().fetch, port: env.port }, (info) => {
	log.info("api.started", { port: info.port, env: env.nodeEnv })
})

async function shutdown(signal: string) {
	log.info("api.shutdown", { signal })
	server.close()
	await Promise.allSettled([closeQueues(), closeRedis(), closeDatabase()])
	process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
