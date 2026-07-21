const SUPPORTED_OUTPUT_FORMATS = ["flac"];

export const OUTPUT_FORMAT = process.env.OUTPUT_FORMAT ?? "flac";
export const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || null;
export const SOURCE_PREFIX = process.env.SOURCE_PREFIX ?? "source/";
export const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX ?? "transcoded/";

const rawPartLength = process.env.PART_LENGTH_SECONDS;
export const PART_LENGTH_SECONDS =
	rawPartLength === undefined || rawPartLength === ""
		? null
		: Number(rawPartLength);

const rawPartOverlap = process.env.PART_OVERLAP_SECONDS;
export const PART_OVERLAP_SECONDS =
	rawPartOverlap === undefined || rawPartOverlap === ""
		? 0
		: Number(rawPartOverlap);

if (!SUPPORTED_OUTPUT_FORMATS.includes(OUTPUT_FORMAT)) {
	throw new Error(
		`Unsupported OUTPUT_FORMAT: "${OUTPUT_FORMAT}". Supported: ${SUPPORTED_OUTPUT_FORMATS.join(", ")}`,
	);
}

if (
	PART_LENGTH_SECONDS !== null &&
	(!Number.isFinite(PART_LENGTH_SECONDS) || PART_LENGTH_SECONDS <= 0)
) {
	throw new Error(
		`Invalid PART_LENGTH_SECONDS: "${rawPartLength}". Must be a finite positive number of seconds.`,
	);
}

if (!Number.isFinite(PART_OVERLAP_SECONDS) || PART_OVERLAP_SECONDS < 0) {
	throw new Error(
		`Invalid PART_OVERLAP_SECONDS: "${rawPartOverlap}". Must be a finite number of seconds >= 0.`,
	);
}

if (
	PART_LENGTH_SECONDS !== null &&
	PART_OVERLAP_SECONDS >= PART_LENGTH_SECONDS
) {
	throw new Error(
		`PART_OVERLAP_SECONDS (${PART_OVERLAP_SECONDS}) must be less than PART_LENGTH_SECONDS (${PART_LENGTH_SECONDS}).`,
	);
}
