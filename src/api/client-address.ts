/**
 * Which address a request came from, for the purposes of counting it.
 *
 * Only ever read behind nginx. Both headers are ones a client can send, and
 * both are overwritten or appended to by `proxy/staging.conf` before the API
 * sees them — `X-Real-IP $remote_addr` is *set*, so whatever the client wrote
 * is discarded, and `X-Forwarded-For $proxy_add_x_forwarded_for` *appends* the
 * peer nginx actually observed. That is why the two are read in this order and
 * why the forwarded chain is read from the **end**: the first entry there is
 * the one entry a client fully controls, and keying a rate limit on it would
 * let one caller mint a fresh quota per request.
 *
 * Every container binds 127.0.0.1 and nginx is the only public surface, so
 * there is no path on which these headers arrive unfiltered. Exposing the API
 * directly would change that, which is the reason this reasoning is written
 * down next to the parsing rather than left implied.
 */
export function clientAddress(
	realIp: string | undefined,
	forwardedFor: string | undefined,
): string | undefined {
	const direct = realIp?.trim()
	if (direct) return direct

	const hops = (forwardedFor ?? "")
		.split(",")
		.map((hop) => hop.trim())
		.filter((hop) => hop.length > 0)

	return hops.at(-1)
}
