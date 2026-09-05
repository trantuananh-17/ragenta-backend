import { Buffer } from "node:buffer"
import { Client } from "minio"

import { env } from "../config/env"
import { AppError } from "../shared/errors"
import { logger } from "../shared/logger"

const log = logger.child({ component: "storage" })

/**
 * Object storage for uploaded documents. S3-compatible; MinIO in every
 * environment so far.
 *
 * The bytes live here and never in Postgres. A 40 MB PDF in a row makes every
 * backup, every replication stream and every `SELECT *` carry it, and the
 * database is the one thing in the stack that must stay small enough to restore
 * quickly.
 *
 * Object keys are generated from the document id, never from the uploaded
 * filename. A filename is attacker-controlled; a key built from one is how a
 * store ends up with `../` or with two uploads silently overwriting each other.
 */
export class StorageUnavailableError extends AppError {
	constructor() {
		super(
			"STORAGE_UNAVAILABLE",
			"Object storage is not configured, so this deployment cannot accept document uploads.",
			503,
		)
	}
}

let client: Client | undefined
let bucketReady = false

function getClient(): Client {
	if (!env.storage) throw new StorageUnavailableError()
	client ??= new Client({
		endPoint: env.storage.endPoint,
		port: env.storage.port,
		useSSL: env.storage.useSSL,
		accessKey: env.storage.accessKey,
		secretKey: env.storage.secretKey,
		region: env.storage.region,
	})
	return client
}

export function isStorageConfigured(): boolean {
	return env.storage !== undefined
}

function bucket(): string {
	if (!env.storage) throw new StorageUnavailableError()
	return env.storage.bucket
}

/**
 * Created on first use rather than at boot: the API starts before MinIO is
 * necessarily reachable, and a deployment that has no document feature yet
 * should not fail to start over a bucket nothing writes to.
 */
async function ensureBucket(): Promise<void> {
	if (bucketReady) return
	const minio = getClient()
	if (!(await minio.bucketExists(bucket()))) {
		await minio.makeBucket(bucket(), env.storage?.region ?? "us-east-1")
		log.info("storage.bucket_created", { bucket: bucket() })
	}
	bucketReady = true
}

/** `documents/<workspace>/<document>` — scoped so a listing is per tenant. */
export function documentKey(workspaceId: string, documentId: string): string {
	return `documents/${workspaceId}/${documentId}`
}

export async function putObject(
	key: string,
	body: Buffer,
	contentType: string,
): Promise<void> {
	await ensureBucket()
	await getClient().putObject(bucket(), key, body, body.length, {
		"Content-Type": contentType,
	})
}

export async function getObject(key: string): Promise<Buffer> {
	await ensureBucket()
	const stream = await getClient().getObject(bucket(), key)
	const parts: Buffer[] = []
	for await (const part of stream) {
		parts.push(part as Buffer)
	}
	return Buffer.concat(parts)
}

export async function removeObject(key: string): Promise<void> {
	await ensureBucket()
	await getClient().removeObject(bucket(), key)
}

/**
 * A time-limited URL for downloading one object.
 *
 * Presigned rather than streamed through the API: a download would otherwise
 * occupy a Node process for the length of the transfer, and the object store is
 * better at serving bytes than we are. The expiry is short because the URL
 * carries its own authorisation — anyone holding it is the bearer.
 */
export async function presignedDownloadUrl(key: string, expirySeconds = 300): Promise<string> {
	await ensureBucket()
	return getClient().presignedGetObject(bucket(), key, expirySeconds)
}

export async function checkStorage(): Promise<boolean> {
	if (!env.storage) return false
	try {
		await getClient().bucketExists(bucket())
		return true
	} catch {
		return false
	}
}
