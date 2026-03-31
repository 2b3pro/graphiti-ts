export interface Edge {
  uuid: string;
  group_id: string;
  source_node_uuid: string;
  target_node_uuid: string;
  created_at: Date;
}

export interface EntityEdge extends Edge {
  name: string;
  fact: string;
  fact_embedding?: number[] | null;
  episodes?: string[];
  valid_at?: Date | null;
  invalid_at?: Date | null;
  expired_at?: Date | null;
  attributes?: Record<string, unknown>;
}

export interface EpisodicEdge extends Edge {}

export interface CommunityEdge extends Edge {
  rank?: number | null;
}

export interface HasEpisodeEdge extends Edge {}

export interface NextEpisodeEdge extends Edge {}
