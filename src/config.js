const SUPPORTED_OUTPUT_FORMATS = ["flac"];

export const OUTPUT_FORMAT = process.env.OUTPUT_FORMAT ?? "flac";
export const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || null;
export const SOURCE_PREFIX = process.env.SOURCE_PREFIX ?? "source/";
export const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX ?? "transcoded/";

// Treats an empty-string env var the same as unset (falls back to
// `defaultValue`) rather than `Number("")` silently resolving to 0, as `??`
// would let happen.
function numberEnv(name, defaultValue) {
	return process.env[name] ? Number(process.env[name]) : defaultValue;
}

function requireFinite(name, value) {
	if (!Number.isFinite(value)) {
		throw new Error(
			`${name} must be a finite number, got: "${process.env[name]}"`,
		);
	}
}

function requirePositiveFinite(name, value) {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(
			`${name} must be a positive finite number, got: "${process.env[name]}"`,
		);
	}
}

// Splitting is opt-in: unset means null, which disables the whole feature
// and leaves behavior identical to before it existed.
export const SPLIT_AFTER_MINUTES = numberEnv("SPLIT_AFTER_MINUTES", null);

export const SILENCE_NOISE_DB = numberEnv("SILENCE_NOISE_DB", -30);

export const SILENCE_MIN_DURATION_SECONDS = numberEnv(
	"SILENCE_MIN_DURATION_SECONDS",
	0.5,
);

const LOOKBACK_FRACTION_OF_SPLIT_INTERVAL = 0.25;
const LOOKBACK_CAP_SECONDS = 120;

// Defaults to a quarter of the split interval (capped at 120s) so the
// lookback window scales with SPLIT_AFTER_MINUTES when set; irrelevant
// (never read) when splitting is disabled.
const lookbackDefaultSeconds =
	SPLIT_AFTER_MINUTES !== null
		? Math.min(
				LOOKBACK_CAP_SECONDS,
				SPLIT_AFTER_MINUTES * 60 * LOOKBACK_FRACTION_OF_SPLIT_INTERVAL,
			)
		: LOOKBACK_CAP_SECONDS;

export const SILENCE_LOOKBACK_MAX_SECONDS = numberEnv(
	"SILENCE_LOOKBACK_MAX_SECONDS",
	lookbackDefaultSeconds,
);

if (!SUPPORTED_OUTPUT_FORMATS.includes(OUTPUT_FORMAT)) {
	throw new Error(
		`Unsupported OUTPUT_FORMAT: "${OUTPUT_FORMAT}". Supported: ${SUPPORTED_OUTPUT_FORMATS.join(", ")}`,
	);
}

if (SPLIT_AFTER_MINUTES !== null) {
	requirePositiveFinite("SPLIT_AFTER_MINUTES", SPLIT_AFTER_MINUTES);
}

requireFinite("SILENCE_NOISE_DB", SILENCE_NOISE_DB);
requirePositiveFinite(
	"SILENCE_MIN_DURATION_SECONDS",
	SILENCE_MIN_DURATION_SECONDS,
);
requirePositiveFinite(
	"SILENCE_LOOKBACK_MAX_SECONDS",
	SILENCE_LOOKBACK_MAX_SECONDS,
);
