import {
  GroupIdValidationError,
  NodeLabelValidationError
} from './errors';
import {
  GROUP_ID_PATTERN,
  SAFE_CYPHER_IDENTIFIER_PATTERN
} from './graph';

export function validateGroupId(groupId: string | null | undefined): true {
  if (!groupId) {
    return true;
  }

  if (!GROUP_ID_PATTERN.test(groupId)) {
    throw new GroupIdValidationError(groupId);
  }

  return true;
}

export function validateGroupIds(groupIds: string[] | null | undefined): true {
  if (!groupIds) {
    return true;
  }

  for (const groupId of groupIds) {
    validateGroupId(groupId);
  }

  return true;
}

export function validateNodeLabels(nodeLabels: string[] | null | undefined): true {
  if (!nodeLabels || nodeLabels.length === 0) {
    return true;
  }

  const invalidLabels = nodeLabels.filter(
    (label) => !SAFE_CYPHER_IDENTIFIER_PATTERN.test(label)
  );

  if (invalidLabels.length > 0) {
    throw new NodeLabelValidationError(invalidLabels);
  }

  return true;
}
