export type GroupIdsInput = string | string[] | null | undefined;

export function coerceGroupIds(
	groupIds: GroupIdsInput,
	defaultGroupId: string | null | undefined,
): string[] {
	const fallback = defaultGroupId && defaultGroupId.trim() !== '' ? [defaultGroupId] : [];

	if (groupIds === null || groupIds === undefined) {
		return fallback;
	}

	if (typeof groupIds === 'string') {
		const trimmed = groupIds.trim();
		return trimmed === '' ? fallback : [trimmed];
	}

	const normalized = groupIds.map((gid) => gid.trim()).filter((gid) => gid !== '');
	return normalized.length > 0 ? normalized : fallback;
}
