export interface McpServerConfig {
  /** The group ID to use when none is provided by the caller. Defaults to 'default'. */
  default_group_id: string;
}

export function createMcpServerConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    default_group_id: overrides.default_group_id ?? 'default'
  };
}
