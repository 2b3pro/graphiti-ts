const DEFAULT_ATTRIBUTE_MAX_LENGTH = 250;
const LIST_AGGREGATE_MULTIPLIER = 8;
const NULL_STAND_INS = new Set(['null', 'none', 'n/a', 'na', 'not applicable', 'unknown']);

type JsonSchemaLike = Record<string, unknown>;

export function capStringAttributes(
	attributes: Record<string, unknown>,
	schema: JsonSchemaLike | null | undefined,
	globalMaxLength = getGlobalAttributeMaxLength(),
): Record<string, unknown> {
	const capped: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(attributes)) {
		const maxLength = getFieldMaxLength(schema?.[key], globalMaxLength);
		const cappedValue = capAttributeValue(value, maxLength);
		if (cappedValue !== undefined) {
			capped[key] = cappedValue;
		}
	}

	return capped;
}

function capAttributeValue(value: unknown, maxLength: number): unknown {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0 || isNullStandIn(trimmed) || trimmed.length > maxLength) {
			return undefined;
		}
		return trimmed;
	}

	if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
		const filtered = value
			.map((item) => item.trim())
			.filter((item) => item.length > 0 && !isNullStandIn(item) && item.length <= maxLength);

		const aggregateLength = filtered.reduce((sum, item) => sum + item.length, 0);
		if (filtered.length === 0 || aggregateLength > maxLength * LIST_AGGREGATE_MULTIPLIER) {
			return undefined;
		}

		return filtered;
	}

	return value;
}

function getFieldMaxLength(fieldSchema: unknown, fallback: number): number {
	if (fieldSchema && typeof fieldSchema === 'object') {
		const schema = fieldSchema as Record<string, unknown>;
		const maxLength = schema.maxLength ?? schema.max_length;
		if (typeof maxLength === 'number' && Number.isFinite(maxLength) && maxLength > 0) {
			return Math.trunc(maxLength);
		}
	}

	return fallback;
}

function getGlobalAttributeMaxLength(): number {
	const raw = process.env.GRAPHITI_ATTRIBUTE_MAX_LENGTH;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ATTRIBUTE_MAX_LENGTH;
}

function isNullStandIn(value: string): boolean {
	return NULL_STAND_INS.has(value.toLowerCase());
}
