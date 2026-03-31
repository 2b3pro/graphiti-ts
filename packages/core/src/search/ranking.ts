export function reciprocalRankFusion(
  results: string[][],
  rankConstant = 1,
  minScore = 0
): { uuids: string[]; scores: number[] } {
  const scores = new Map<string, number>();

  for (const result of results) {
    result.forEach((uuid, index) => {
      scores.set(uuid, (scores.get(uuid) ?? 0) + 1 / (index + rankConstant));
    });
  }

  const scored = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  const filtered = scored.filter(([, score]) => score >= minScore);

  return {
    uuids: filtered.map(([uuid]) => uuid),
    scores: filtered.map(([, score]) => score)
  };
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function rankByCosineSimilarity<ResultShape>(
  candidates: ResultShape[],
  queryEmbedding: number[],
  candidateEmbeddingGetter: (candidate: ResultShape) => number[] | null | undefined,
  candidateUuidGetter: (candidate: ResultShape) => string,
  minScore = 0,
  limit = 10
): ResultShape[] {
  return candidates
    .map((candidate) => ({
      candidate,
      uuid: candidateUuidGetter(candidate),
      score: cosineSimilarity(queryEmbedding, candidateEmbeddingGetter(candidate) ?? [])
    }))
    .filter((entry) => entry.uuid !== '' && entry.score >= minScore)
    .sort((left, right) => {
      const scoreDifference = right.score - left.score;
      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return left.uuid.localeCompare(right.uuid);
    })
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

export function maximalMarginalRelevance<ResultShape>(
  candidates: ResultShape[],
  queryEmbedding: number[],
  candidateEmbeddingGetter: (candidate: ResultShape) => number[] | null | undefined,
  candidateUuidGetter: (candidate: ResultShape) => string,
  lambda = 0.5,
  minScore = 0,
  limit = 10
): { items: ResultShape[]; scores: number[] } {
  const pool = candidates
    .map((candidate) => {
      const embedding = candidateEmbeddingGetter(candidate) ?? [];
      return {
        candidate,
        uuid: candidateUuidGetter(candidate),
        embedding,
        relevance: cosineSimilarity(queryEmbedding, embedding)
      };
    })
    .filter((entry) => entry.uuid !== '' && entry.relevance >= minScore);

  const selected: typeof pool = [];
  const selectedScores: number[] = [];
  const remaining = [...pool];

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (!candidate) {
        continue;
      }

      const diversityPenalty =
        selected.length === 0
          ? 0
          : Math.max(
              ...selected.map((selectedEntry) =>
                cosineSimilarity(candidate.embedding, selectedEntry.embedding)
              )
            );
      const score = lambda * candidate.relevance - (1 - lambda) * diversityPenalty;
      const currentBestUuid = remaining[bestIndex]?.uuid ?? '';

      if (
        score > bestScore ||
        (score === bestScore && candidate.uuid.localeCompare(currentBestUuid) < 0)
      ) {
        bestIndex = index;
        bestScore = score;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    if (!picked) {
      break;
    }

    selected.push(picked);
    selectedScores.push(bestScore);
  }

  return {
    items: selected.map((entry) => entry.candidate),
    scores: selectedScores
  };
}
