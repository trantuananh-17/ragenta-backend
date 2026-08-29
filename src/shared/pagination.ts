import { z } from "zod"

export const paginationQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(25),
	offset: z.coerce.number().int().min(0).default(0),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export interface Page<T> {
	items: T[]
	total: number
	limit: number
	offset: number
}

export function page<T>(items: T[], total: number, query: PaginationQuery): Page<T> {
	return { items, total, limit: query.limit, offset: query.offset }
}
