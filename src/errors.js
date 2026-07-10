/**
 * Marks an error as transient (e.g. a network hiccup reading from or writing
 * to Cloud Storage). Transient errors are safe to retry: the same input is
 * likely to succeed on a later attempt.
 *
 * Errors that are NOT wrapped in TransientError are treated as permanent —
 * retrying them would just fail the same way forever, so the caller should
 * log and swallow them instead of rethrowing for Eventarc to retry.
 */
export class TransientError extends Error {
	constructor(message) {
		super(message);
		this.name = "TransientError";
	}
}

export function isTransientError(err) {
	return err instanceof TransientError;
}

// HTTP status codes returned by the GCS JSON API (via gaxios) that indicate
// a persistent, non-retryable problem — bad auth, missing bucket/object,
// malformed request — rather than a transient network or server issue.
const PERMANENT_GCS_STATUS_CODES = new Set([400, 401, 403, 404, 409, 412]);

/**
 * Classifies a GCS read/write stream error as transient or permanent.
 * gaxios sets `err.status` to the HTTP response status on API-level
 * failures; errors with no status (network-level failures like ECONNRESET/
 * ETIMEDOUT) and 5xx/429 responses are treated as transient, since a retry
 * is likely to succeed. The 4xx codes above indicate a persistent problem —
 * retrying won't help until the underlying misconfiguration is fixed.
 */
export function classifyGcsStreamError(err, prefix) {
	const message = `${prefix}: ${err.message}`;
	if (PERMANENT_GCS_STATUS_CODES.has(err.status)) {
		return new Error(message);
	}
	return new TransientError(message);
}
