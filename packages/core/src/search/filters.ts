import { type GraphProvider, validateCypherIdentifier, validateNodeLabels } from '@graphiti/shared';
import { serializeForCypher } from '../utils/serialization';

export const ComparisonOperators = {
	equals: '=',
	not_equals: '<>',
	greater_than: '>',
	less_than: '<',
	greater_than_equal: '>=',
	less_than_equal: '<=',
	is_null: 'IS NULL',
	is_not_null: 'IS NOT NULL',
} as const;

export type ComparisonOperator = (typeof ComparisonOperators)[keyof typeof ComparisonOperators];

export interface DateFilter {
	/**
	 * Comparison value. A `Date` is coerced to an ISO-8601 string at the query
	 * boundary (date props are stored as ISO strings); an ISO string may be
	 * passed directly. Omit for `IS NULL` / `IS NOT NULL` operators.
	 */
	date?: Date | string | null;
	comparison_operator: ComparisonOperator;
}

export interface PropertyFilter {
	property_name: string;
	property_value?: string | number | null;
	comparison_operator: ComparisonOperator;
}

export interface ConditionStateFilter {
	entity_uuid: string;
	state: 'active' | 'inactive';
}

export interface SearchFilters {
	node_labels?: string[] | null;
	edge_types?: string[] | null;
	valid_at?: DateFilter[][] | null;
	invalid_at?: DateFilter[][] | null;
	created_at?: DateFilter[][] | null;
	expired_at?: DateFilter[][] | null;
	edge_uuids?: string[] | null;
	property_filters?: PropertyFilter[] | null;
	condition_state?: ConditionStateFilter[] | null;
	anchor_lens?: {
		anchor_type?: import('../domain/anchoring').AnchorType;
		anchor_uuid?: string;
	} | null;
}

export function createSearchFilters(overrides: Partial<SearchFilters> = {}): SearchFilters {
	if (overrides.node_labels) {
		validateNodeLabels(overrides.node_labels);
	}
	validatePropertyFilters(overrides.property_filters);

	return {
		node_labels: overrides.node_labels ?? null,
		edge_types: overrides.edge_types ?? null,
		valid_at: overrides.valid_at ?? null,
		invalid_at: overrides.invalid_at ?? null,
		created_at: overrides.created_at ?? null,
		expired_at: overrides.expired_at ?? null,
		edge_uuids: overrides.edge_uuids ?? null,
		property_filters: overrides.property_filters ?? null,
		condition_state: overrides.condition_state ?? null,
		anchor_lens: overrides.anchor_lens ?? null,
	};
}

export function cypherToOpensearchOperator(op: ComparisonOperator): string {
	const mapping: Partial<Record<ComparisonOperator, string>> = {
		[ComparisonOperators.greater_than]: 'gt',
		[ComparisonOperators.less_than]: 'lt',
		[ComparisonOperators.greater_than_equal]: 'gte',
		[ComparisonOperators.less_than_equal]: 'lte',
	};

	return mapping[op] ?? op;
}

export function dateFilterQueryConstructor(
	valueName: string,
	paramName: string,
	operator: ComparisonOperator,
): string {
	if (operator === ComparisonOperators.is_null || operator === ComparisonOperators.is_not_null) {
		return `(${valueName} ${operator})`;
	}

	return `(${valueName} ${operator} ${paramName})`;
}

export function nodeSearchFilterQueryConstructor(
	filters: SearchFilters,
	_provider: GraphProvider,
): [string[], Record<string, unknown>] {
	const filterQueries: string[] = [];
	const filterParams: Record<string, unknown> = {};

	if (filters.node_labels) {
		validateNodeLabels(filters.node_labels);

		filterQueries.push(`n:${filters.node_labels.join('|')}`);
	}

	return [filterQueries, filterParams];
}

export function edgeSearchFilterQueryConstructor(
	filters: SearchFilters,
	_provider: GraphProvider,
): [string[], Record<string, unknown>] {
	const filterQueries: string[] = [];
	const filterParams: Record<string, unknown> = {};

	if (filters.edge_types) {
		filterQueries.push('e.name in $edge_types');
		filterParams.edge_types = filters.edge_types;
	}

	if (filters.edge_uuids) {
		filterQueries.push('e.uuid in $edge_uuids');
		filterParams.edge_uuids = filters.edge_uuids;
	}

	if (filters.node_labels) {
		validateNodeLabels(filters.node_labels);

		const nodeLabels = filters.node_labels.join('|');
		filterQueries.push(`n:${nodeLabels} AND m:${nodeLabels}`);
	}

	appendDateFilters(filterQueries, filterParams, 'valid_at', filters.valid_at, 'e.valid_at');
	appendDateFilters(filterQueries, filterParams, 'invalid_at', filters.invalid_at, 'e.invalid_at');
	appendDateFilters(filterQueries, filterParams, 'created_at', filters.created_at, 'e.created_at');
	appendDateFilters(filterQueries, filterParams, 'expired_at', filters.expired_at, 'e.expired_at');

	if (filters.property_filters) {
		for (const [index, pf] of filters.property_filters.entries()) {
			validateCypherIdentifier(pf.property_name);
			if (
				pf.comparison_operator === ComparisonOperators.is_null ||
				pf.comparison_operator === ComparisonOperators.is_not_null
			) {
				filterQueries.push(`(e.${pf.property_name} ${pf.comparison_operator})`);
			} else {
				filterParams[`prop_filter_${index}`] = pf.property_value ?? null;
				filterQueries.push(
					`(e.${pf.property_name} ${pf.comparison_operator} $prop_filter_${index})`,
				);
			}
		}
	}

	if (filters.anchor_lens) {
		if (filters.anchor_lens.anchor_uuid) {
			filterParams.anchor_uuid = filters.anchor_lens.anchor_uuid;
			filterQueries.push('(e.anchored_by IS NOT NULL AND $anchor_uuid IN e.anchored_by)');
		}
		// anchor_type filtering requires inspecting interpretations JSON —
		// done post-query in application code for both Neo4j and FalkorDB
	}

	// condition_state filtering is handled post-query in application code:
	// conditions are stored as a JSON string in Neo4j/FalkorDB properties,
	// so Cypher-level filtering would require APOC (Neo4j) or is impossible (FalkorDB).
	// Callers should use evaluateConditions() from domain/conditions.ts to filter results.

	return [filterQueries, filterParams];
}

function validatePropertyFilters(propertyFilters: PropertyFilter[] | null | undefined): void {
	if (!propertyFilters) {
		return;
	}

	for (const filter of propertyFilters) {
		validateCypherIdentifier(filter.property_name);
	}
}

function appendDateFilters(
	filterQueries: string[],
	filterParams: Record<string, unknown>,
	paramPrefix: string,
	filterGroups: DateFilter[][] | null | undefined,
	fieldName: string,
): void {
	if (!filterGroups) {
		return;
	}

	const orQueries: string[] = [];

	for (const orList of filterGroups) {
		const andQueries: string[] = [];

		for (const [index, dateFilter] of orList.entries()) {
			if (
				dateFilter.comparison_operator !== ComparisonOperators.is_null &&
				dateFilter.comparison_operator !== ComparisonOperators.is_not_null
			) {
				// Date properties are persisted as ISO-8601 strings (serializeForCypher,
				// the write-side serializer). The comparison param must go through the
				// SAME path: a raw JS Date makes the driver send a Neo4j DateTime, and
				// `string <op> datetime` is a type mismatch that silently matches
				// nothing. ISO-8601 UTC strings compare lexicographically in
				// chronological order, so string comparison is correct.
				filterParams[`${paramPrefix}_${index}`] = serializeForCypher(dateFilter.date) ?? null;
			}

			andQueries.push(
				dateFilterQueryConstructor(
					fieldName,
					`$${paramPrefix}_${index}`,
					dateFilter.comparison_operator,
				),
			);
		}

		orQueries.push(andQueries.join(' AND '));
	}

	filterQueries.push(`(${orQueries.join(' OR ')})`);
}
