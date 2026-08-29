import { createApp } from "../src/api/app"

const app = createApp()

const response = await app.request("/v1/openapi.json")
const document = (await response.json()) as { paths: Record<string, Record<string, unknown>> }

const rows = Object.entries(document.paths).flatMap(([path, item]) =>
	Object.keys(item).map((method) => `${method.toUpperCase().padEnd(6)} ${path}`),
)

console.log(`status ${response.status}, ${rows.length} operations`)
console.log(rows.sort().join("\n"))
