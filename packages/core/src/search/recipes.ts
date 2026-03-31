import {
  CommunityRerankers,
  CommunitySearchMethods,
  createCommunitySearchConfig,
  createEdgeSearchConfig,
  createEpisodeSearchConfig,
  createNodeSearchConfig,
  createSearchConfig,
  EdgeRerankers,
  EdgeSearchMethods,
  EpisodeRerankers,
  EpisodeSearchMethods,
  NodeRerankers,
  NodeSearchMethods
} from './config';

export const COMBINED_HYBRID_SEARCH_RRF = createSearchConfig({
  edge_config: createEdgeSearchConfig({
    search_methods: [EdgeSearchMethods.bm25, EdgeSearchMethods.cosine_similarity],
    reranker: EdgeRerankers.rrf
  }),
  node_config: createNodeSearchConfig({
    search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.cosine_similarity],
    reranker: NodeRerankers.rrf
  }),
  episode_config: createEpisodeSearchConfig({
    search_methods: [EpisodeSearchMethods.bm25],
    reranker: EpisodeRerankers.rrf
  }),
  community_config: createCommunitySearchConfig({
    search_methods: [CommunitySearchMethods.bm25, CommunitySearchMethods.cosine_similarity],
    reranker: CommunityRerankers.rrf
  })
});

export const COMBINED_HYBRID_SEARCH_MMR = createSearchConfig({
  edge_config: createEdgeSearchConfig({
    search_methods: [EdgeSearchMethods.bm25, EdgeSearchMethods.cosine_similarity],
    reranker: EdgeRerankers.mmr,
    mmr_lambda: 1
  }),
  node_config: createNodeSearchConfig({
    search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.cosine_similarity],
    reranker: NodeRerankers.mmr,
    mmr_lambda: 1
  }),
  episode_config: createEpisodeSearchConfig({
    search_methods: [EpisodeSearchMethods.bm25],
    reranker: EpisodeRerankers.rrf
  }),
  community_config: createCommunitySearchConfig({
    search_methods: [CommunitySearchMethods.bm25, CommunitySearchMethods.cosine_similarity],
    reranker: CommunityRerankers.mmr,
    mmr_lambda: 1
  })
});

export const COMBINED_HYBRID_SEARCH_CROSS_ENCODER = createSearchConfig({
  edge_config: createEdgeSearchConfig({
    search_methods: [
      EdgeSearchMethods.bm25,
      EdgeSearchMethods.cosine_similarity,
      EdgeSearchMethods.bfs
    ],
    reranker: EdgeRerankers.cross_encoder
  }),
  node_config: createNodeSearchConfig({
    search_methods: [
      NodeSearchMethods.bm25,
      NodeSearchMethods.cosine_similarity,
      NodeSearchMethods.bfs
    ],
    reranker: NodeRerankers.cross_encoder
  }),
  episode_config: createEpisodeSearchConfig({
    search_methods: [EpisodeSearchMethods.bm25],
    reranker: EpisodeRerankers.cross_encoder
  }),
  community_config: createCommunitySearchConfig({
    search_methods: [CommunitySearchMethods.bm25, CommunitySearchMethods.cosine_similarity],
    reranker: CommunityRerankers.cross_encoder
  })
});

export const EDGE_HYBRID_SEARCH_RRF = createSearchConfig({
  edge_config: createEdgeSearchConfig({
    search_methods: [EdgeSearchMethods.bm25, EdgeSearchMethods.cosine_similarity],
    reranker: EdgeRerankers.rrf
  })
});

export const EDGE_HYBRID_SEARCH_MMR = createSearchConfig({
  edge_config: createEdgeSearchConfig({
    search_methods: [EdgeSearchMethods.bm25, EdgeSearchMethods.cosine_similarity],
    reranker: EdgeRerankers.mmr
  })
});

export const EDGE_HYBRID_SEARCH_NODE_DISTANCE = createSearchConfig({
  edge_config: createEdgeSearchConfig({
    search_methods: [EdgeSearchMethods.bm25, EdgeSearchMethods.cosine_similarity],
    reranker: EdgeRerankers.node_distance
  })
});

export const EDGE_HYBRID_SEARCH_EPISODE_MENTIONS = createSearchConfig({
  edge_config: createEdgeSearchConfig({
    search_methods: [EdgeSearchMethods.bm25, EdgeSearchMethods.cosine_similarity],
    reranker: EdgeRerankers.episode_mentions
  })
});

export const EDGE_HYBRID_SEARCH_CROSS_ENCODER = createSearchConfig({
  edge_config: createEdgeSearchConfig({
    search_methods: [
      EdgeSearchMethods.bm25,
      EdgeSearchMethods.cosine_similarity,
      EdgeSearchMethods.bfs
    ],
    reranker: EdgeRerankers.cross_encoder
  }),
  limit: 10
});

export const NODE_HYBRID_SEARCH_RRF = createSearchConfig({
  node_config: createNodeSearchConfig({
    search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.cosine_similarity],
    reranker: NodeRerankers.rrf
  })
});

export const NODE_HYBRID_SEARCH_MMR = createSearchConfig({
  node_config: createNodeSearchConfig({
    search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.cosine_similarity],
    reranker: NodeRerankers.mmr
  })
});

export const NODE_HYBRID_SEARCH_NODE_DISTANCE = createSearchConfig({
  node_config: createNodeSearchConfig({
    search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.cosine_similarity],
    reranker: NodeRerankers.node_distance
  })
});

export const NODE_HYBRID_SEARCH_EPISODE_MENTIONS = createSearchConfig({
  node_config: createNodeSearchConfig({
    search_methods: [NodeSearchMethods.bm25, NodeSearchMethods.cosine_similarity],
    reranker: NodeRerankers.episode_mentions
  })
});

export const NODE_HYBRID_SEARCH_CROSS_ENCODER = createSearchConfig({
  node_config: createNodeSearchConfig({
    search_methods: [
      NodeSearchMethods.bm25,
      NodeSearchMethods.cosine_similarity,
      NodeSearchMethods.bfs
    ],
    reranker: NodeRerankers.cross_encoder
  }),
  limit: 10
});

export const COMMUNITY_HYBRID_SEARCH_RRF = createSearchConfig({
  community_config: createCommunitySearchConfig({
    search_methods: [CommunitySearchMethods.bm25, CommunitySearchMethods.cosine_similarity],
    reranker: CommunityRerankers.rrf
  })
});

export const COMMUNITY_HYBRID_SEARCH_MMR = createSearchConfig({
  community_config: createCommunitySearchConfig({
    search_methods: [CommunitySearchMethods.bm25, CommunitySearchMethods.cosine_similarity],
    reranker: CommunityRerankers.mmr
  })
});

export const COMMUNITY_HYBRID_SEARCH_CROSS_ENCODER = createSearchConfig({
  community_config: createCommunitySearchConfig({
    search_methods: [CommunitySearchMethods.bm25, CommunitySearchMethods.cosine_similarity],
    reranker: CommunityRerankers.cross_encoder
  }),
  limit: 3
});
