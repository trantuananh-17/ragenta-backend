/**
 * A page's markup reduced to the text a model can actually use.
 *
 * Its own module because two tools fetch HTML — `http_request` gets the server's
 * response, `browser_read` gets what a real browser rendered — and a second copy
 * of this would drift from the first the moment one of them learned to strip
 * something new.
 *
 * Not a parser, and not trying to be. Markup is most of a page's bytes and none
 * of its meaning, and a run that spent its context window on `<div class="...">`
 * would be paying for nothing.
 */
export function htmlToText(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim()
}

/** The document's title, or null when the markup carries none. */
export function readHtmlTitle(html: string): string | null {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
	if (!match?.[1]) return null
	const title = htmlToText(match[1])
	return title.length > 0 ? title.slice(0, 300) : null
}
