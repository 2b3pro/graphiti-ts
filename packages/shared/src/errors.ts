export class GraphitiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EdgeNotFoundError extends GraphitiError {
  constructor(uuid: string) {
    super(`edge ${uuid} not found`);
  }
}

export class EdgesNotFoundError extends GraphitiError {
  constructor(uuids: string[]) {
    super(`None of the edges for ${JSON.stringify(uuids)} were found.`);
  }
}

export class GroupsEdgesNotFoundError extends GraphitiError {
  constructor(groupIds: string[]) {
    super(`no edges found for group ids ${JSON.stringify(groupIds)}`);
  }
}

export class GroupsNodesNotFoundError extends GraphitiError {
  constructor(groupIds: string[]) {
    super(`no nodes found for group ids ${JSON.stringify(groupIds)}`);
  }
}

export class NodeNotFoundError extends GraphitiError {
  constructor(uuid: string) {
    super(`node ${uuid} not found`);
  }
}

export class SearchRerankerError extends GraphitiError {
  constructor(message: string) {
    super(message);
  }
}

export class EntityTypeValidationError extends GraphitiError {
  constructor(entityType: string, entityTypeAttribute: string) {
    super(
      `${entityTypeAttribute} cannot be used as an attribute for ${entityType} as it is a protected attribute name.`
    );
  }
}

export class GroupIdValidationError extends GraphitiError {
  constructor(groupId: string) {
    super(
      `group_id "${groupId}" must contain only alphanumeric characters, dashes, or underscores`
    );
  }
}

export class NodeLabelValidationError extends GraphitiError {
  constructor(nodeLabels: string[]) {
    const labelList = nodeLabels.map((label) => `"${label}"`).join(', ');
    super(
      'node_labels must start with a letter or underscore and contain only ' +
        `alphanumeric characters or underscores: ${labelList}`
    );
  }
}
