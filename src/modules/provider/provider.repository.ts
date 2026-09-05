import { asc, eq } from "drizzle-orm"

import { db } from "../../db/client"
import type { DbExecutor } from "../../db/client"
import { platformSetting, providerCredential, providerModel } from "../../db/schema"

export type ProviderCredentialRow = typeof providerCredential.$inferSelect
export type ProviderModelRow = typeof providerModel.$inferSelect
export type NewProviderModel = typeof providerModel.$inferInsert

export const providerRepository = {
	/**
	 * Every stored credential. `encrypted_key` is selected here because this is
	 * the one place allowed to see it — the catalogue decrypts it in memory and
	 * nothing above that layer receives the row.
	 */
	async listCredentials(executor: DbExecutor = db) {
		return executor.select().from(providerCredential).orderBy(asc(providerCredential.provider))
	},

	async findCredential(provider: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(providerCredential)
			.where(eq(providerCredential.provider, provider))
			.limit(1)
		return rows[0]
	},

	async upsertCredential(
		values: typeof providerCredential.$inferInsert,
		executor: DbExecutor = db,
	) {
		const { provider: _provider, createdAt: _createdAt, ...updatable } = values
		const rows = await executor
			.insert(providerCredential)
			.values(values)
			.onConflictDoUpdate({
				target: providerCredential.provider,
				set: { ...updatable, updatedAt: new Date() },
			})
			.returning()
		return rows[0]
	},

	/** Records the outcome of a live check without touching the key itself. */
	async recordCheck(
		provider: string,
		result: { ok: boolean; error: string | null },
		executor: DbExecutor = db,
	) {
		await executor
			.update(providerCredential)
			.set({
				lastCheckedAt: new Date(),
				lastCheckOk: result.ok,
				lastCheckError: result.error,
			})
			.where(eq(providerCredential.provider, provider))
	},

	async deleteCredential(provider: string, executor: DbExecutor = db) {
		const rows = await executor
			.delete(providerCredential)
			.where(eq(providerCredential.provider, provider))
			.returning({ provider: providerCredential.provider })
		return rows.length > 0
	},

	async listModels(executor: DbExecutor = db) {
		return executor
			.select()
			.from(providerModel)
			.orderBy(asc(providerModel.provider), asc(providerModel.model))
	},

	async findModelById(id: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(providerModel)
			.where(eq(providerModel.id, id))
			.limit(1)
		return rows[0]
	},

	/**
	 * Insert-or-replace on `(provider, model)`. Switching a built-in model off is
	 * the same write as adding a custom one — the row simply carries the built-in
	 * definition — which is what keeps the merge in `src/ai/catalogue.ts` to one
	 * rule instead of a matrix of nullable overrides.
	 */
	async upsertModel(values: NewProviderModel, executor: DbExecutor = db) {
		const { id: _id, createdAt: _createdAt, createdBy: _createdBy, ...updatable } = values
		const rows = await executor
			.insert(providerModel)
			.values(values)
			.onConflictDoUpdate({
				target: [providerModel.provider, providerModel.model],
				set: { ...updatable, updatedAt: new Date() },
			})
			.returning()
		return rows[0]
	},

	async deleteModel(id: string, executor: DbExecutor = db) {
		const rows = await executor
			.delete(providerModel)
			.where(eq(providerModel.id, id))
			.returning({ id: providerModel.id })
		return rows.length > 0
	},

	async findSetting(key: string, executor: DbExecutor = db) {
		const rows = await executor
			.select()
			.from(platformSetting)
			.where(eq(platformSetting.key, key))
			.limit(1)
		return rows[0]
	},

	async upsertSetting(
		key: string,
		value: unknown,
		updatedBy: string | null,
		executor: DbExecutor = db,
	) {
		const rows = await executor
			.insert(platformSetting)
			.values({ key, value, updatedBy })
			.onConflictDoUpdate({
				target: platformSetting.key,
				set: { value, updatedBy, updatedAt: new Date() },
			})
			.returning()
		return rows[0]
	},
}
