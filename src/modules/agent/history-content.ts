import type { ChatMessage } from "../../ai/clients"

/**
 * How much of a widget visitor's conversation the agent is shown again.
 *
 * Six turns, not a document's worth: a shop conversation is short and the
 * question being answered is the most recent one — the rest is there so "and
 * in blue?" means something. The tokens are paid out of the widget's own daily
 * ceiling, so a generous window is somebody's money.
 */
export const WIDGET_HISTORY_TURNS = 6

/**
 * Earlier turns as the alternating `user` / `assistant` messages
 * `assemblePrompt` expects, which then trims them to the token budget.
 */
export function historyMessages(turns: { question: string; answer: string }[]): ChatMessage[] {
	return turns.flatMap((turn): ChatMessage[] => [
		{ role: "user", content: turn.question },
		{ role: "assistant", content: turn.answer },
	])
}
