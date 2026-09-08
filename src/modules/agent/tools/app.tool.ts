import { callConnectedApp } from "../../oauth/app-api"
import {
	githubCreateIssueParameters,
	githubSearchIssuesParameters,
	notionSearchParameters,
	renderIssues,
	renderNotionPages,
	renderSlackMessages,
	slackHistoryParameters,
	slackPostParameters,
} from "./app-content"
import type { RenderableIssue, RenderableNotionPage, RenderableSlackMessage } from "./app-content"
import type { AgentTool, ToolContext, ToolResult } from "./types"

/**
 * Slack, GitHub and Notion, as the account a workspace connected.
 *
 * Three providers rather than the six the roadmap names, and that is a decision
 * rather than an omission: these three have genuinely different API shapes —
 * Slack answers 200 with `ok: false`, GitHub uses a search grammar, Notion posts
 * a JSON filter — so building them proves the framework generalises. Discord,
 * Jira and Linear are mechanical after this, and shipping six connectors that
 * have each met a real API zero times is worse than three considered ones
 * (ADR-061).
 */

async function attempt(work: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await work()
	} catch (error) {
		return { ok: false, content: error instanceof Error ? error.message : "That call failed." }
	}
}

/** Slack answers 200 with `ok: false` on refusal, which `!response.ok` never sees. */
const slackError = (payload: Record<string, unknown>) =>
	payload.ok === false && typeof payload.error === "string" ? payload.error : undefined

export const slackPostTool: AgentTool = {
	name: "slack_post",
	description:
		"Post a message to a Slack channel as the connected account. Give a channel id, or a name with a leading hash.",
	parameters: slackPostParameters,
	writes: true,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = slackPostParameters.parse(args)

		return attempt(async () => {
			const payload = await callConnectedApp(context.workspaceId, {
				provider: "slack",
				method: "POST",
				url: "https://slack.com/api/chat.postMessage",
				readErrorFrom: slackError,
				body: {
					channel: input.channel,
					text: input.text,
					...(input.threadTs ? { thread_ts: input.threadTs } : {}),
				},
			})

			return {
				ok: true,
				content: `Posted to ${input.channel}.`,
				metadata: { channel: input.channel, ts: payload.ts },
			}
		})
	},
}

export const slackHistoryTool: AgentTool = {
	name: "slack_history",
	description:
		"Read recent messages in a Slack channel the connected account can see. Read only.",
	parameters: slackHistoryParameters,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = slackHistoryParameters.parse(args)

		return attempt(async () => {
			const payload = await callConnectedApp(context.workspaceId, {
				provider: "slack",
				url: `https://slack.com/api/conversations.history?channel=${encodeURIComponent(input.channel)}&limit=${input.limit}`,
				readErrorFrom: slackError,
			})

			const messages: RenderableSlackMessage[] = (
				(payload.messages as SlackMessage[] | undefined) ?? []
			).map((message) => ({
				user: message.user ?? message.bot_id ?? "unknown",
				ts: message.ts ?? "",
				text: message.text ?? "",
			}))

			return {
				ok: true,
				content: renderSlackMessages(input.channel, messages),
				metadata: { channel: input.channel, results: messages.length },
			}
		})
	},
}

export const githubSearchIssuesTool: AgentTool = {
	name: "github_search_issues",
	description:
		"Search issues and pull requests the connected GitHub account can see, using GitHub's own search syntax.",
	parameters: githubSearchIssuesParameters,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = githubSearchIssuesParameters.parse(args)

		return attempt(async () => {
			const payload = await callConnectedApp(context.workspaceId, {
				provider: "github",
				url: `https://api.github.com/search/issues?q=${encodeURIComponent(input.query)}&per_page=${input.limit}`,
				headers: { accept: "application/vnd.github+json" },
			})

			const issues: RenderableIssue[] = (
				(payload.items as GitHubIssue[] | undefined) ?? []
			).map((issue) => ({
				number: issue.number ?? 0,
				title: issue.title ?? "",
				state: issue.state ?? "",
				// The API returns no repository field on a search hit; it is the
				// middle of the html_url, which is stable and is what somebody reads.
				repository: repoFromUrl(issue.html_url ?? ""),
				author: issue.user?.login ?? "unknown",
				url: issue.html_url ?? "",
				body: issue.body ?? "",
			}))

			return {
				ok: true,
				content: renderIssues(issues),
				metadata: { query: input.query, results: issues.length },
			}
		})
	},
}

export const githubCreateIssueTool: AgentTool = {
	name: "github_create_issue",
	description:
		"Open an issue on a GitHub repository the connected account can write to. It is filed as that person.",
	parameters: githubCreateIssueParameters,
	writes: true,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = githubCreateIssueParameters.parse(args)

		return attempt(async () => {
			const payload = await callConnectedApp(context.workspaceId, {
				provider: "github",
				method: "POST",
				url: `https://api.github.com/repos/${input.repo}/issues`,
				headers: { accept: "application/vnd.github+json" },
				body: {
					title: input.title,
					body: input.body,
					...(input.labels.length > 0 ? { labels: input.labels } : {}),
				},
			})

			return {
				ok: true,
				content: `Opened ${input.repo}#${String(payload.number ?? "?")}: ${String(payload.html_url ?? "")}`,
				metadata: { repo: input.repo, number: payload.number, url: payload.html_url },
			}
		})
	},
}

export const notionSearchTool: AgentTool = {
	name: "notion_search",
	description:
		"Find pages and databases in the connected Notion workspace by title. Returns ids and links, not page contents.",
	parameters: notionSearchParameters,

	async execute(context: ToolContext, args: unknown): Promise<ToolResult> {
		const input = notionSearchParameters.parse(args)

		return attempt(async () => {
			const payload = await callConnectedApp(context.workspaceId, {
				provider: "notion",
				method: "POST",
				url: "https://api.notion.com/v1/search",
				headers: { "notion-version": "2022-06-28" },
				body: { query: input.query, page_size: input.limit },
			})

			const pages: RenderableNotionPage[] = (
				(payload.results as NotionResult[] | undefined) ?? []
			).map((result) => ({
				id: result.id ?? "",
				title: notionTitle(result),
				url: result.url ?? "",
				lastEdited: result.last_edited_time ?? "",
			}))

			return {
				ok: true,
				content: renderNotionPages(pages),
				metadata: { query: input.query, results: pages.length },
			}
		})
	},
}

export const APP_TOOLS: AgentTool[] = [
	slackPostTool,
	slackHistoryTool,
	githubSearchIssuesTool,
	githubCreateIssueTool,
	notionSearchTool,
]

interface SlackMessage {
	user?: string
	bot_id?: string
	ts?: string
	text?: string
}

interface GitHubIssue {
	number?: number
	title?: string
	state?: string
	html_url?: string
	body?: string
	user?: { login?: string }
}

interface NotionResult {
	id?: string
	url?: string
	last_edited_time?: string
	properties?: Record<string, { title?: { plain_text?: string }[] }>
	title?: { plain_text?: string }[]
}

/** `https://github.com/owner/name/issues/12` → `owner/name`. */
function repoFromUrl(url: string): string {
	const match = /github\.com\/([^/]+\/[^/]+)\//.exec(url)
	return match?.[1] ?? ""
}

/**
 * Notion puts a page's title in a differently-named property on every database,
 * and a database's own title in a top-level field. Neither is guaranteed, so an
 * untitled result is named rather than dropped: a page with no title is still a
 * page somebody may want the id of.
 */
function notionTitle(result: NotionResult): string {
	const direct = result.title?.map((part) => part.plain_text ?? "").join("")
	if (direct) return direct

	for (const property of Object.values(result.properties ?? {})) {
		const text = property.title?.map((part) => part.plain_text ?? "").join("")
		if (text) return text
	}
	return "(untitled)"
}
