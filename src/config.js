const SUPPORTED_OUTPUT_FORMATS = ["flac"];

export const OUTPUT_FORMAT = process.env.OUTPUT_FORMAT ?? "flac";
export const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || null;
export const SOURCE_PREFIX = process.env.SOURCE_PREFIX ?? "source/";
export const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX ?? "transcoded/";

if (!SUPPORTED_OUTPUT_FORMATS.includes(OUTPUT_FORMAT)) {
	throw new Error(
		`Unsupported OUTPUT_FORMAT: "${OUTPUT_FORMAT}". Supported: ${SUPPORTED_OUTPUT_FORMATS.join(", ")}`,
	);
}
