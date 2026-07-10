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
