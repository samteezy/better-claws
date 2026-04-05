import type { MemoryEntry } from "../types.js";
import type { LongTermStore } from "./long-term-store.js";

/**
 * Simple tokenizer: lowercase, split on non-alphanumeric, filter short tokens
 * and common stop words. Zero dependencies.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all",
  "can", "had", "her", "was", "one", "our", "out", "has",
  "his", "how", "its", "may", "new", "now", "old", "see",
  "way", "who", "did", "got", "let", "say", "she", "too",
  "use", "that", "this", "with", "have", "from", "they",
  "been", "said", "each", "which", "their", "will", "other",
  "about", "many", "then", "them", "these", "some", "would",
  "into", "than", "could", "been", "more", "when", "what",
]);

/** Term frequency: count of each token in the document. */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/**
 * Inverse document frequency from a corpus of documents.
 * IDF(t) = log(N / (1 + df(t))) where df(t) is the number of documents
 * containing term t.
 */
function inverseDocumentFrequency(
  corpus: Map<string, number>[],
): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of corpus) {
    for (const term of doc.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  const n = corpus.length;
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + n / (1 + count)));
  }
  return idf;
}

/** TF-IDF score: sum of (tf * idf) for shared terms between query and doc. */
function tfidfScore(
  queryTf: Map<string, number>,
  docTf: Map<string, number>,
  idf: Map<string, number>,
): number {
  let score = 0;
  for (const [term, qtf] of queryTf) {
    const dtf = docTf.get(term);
    if (dtf === undefined) continue;
    const termIdf = idf.get(term) ?? 0;
    score += qtf * dtf * termIdf;
  }
  return score;
}

export interface RetrievalResult {
  readonly entry: MemoryEntry;
  readonly score: number;
}

export interface TfIdfRetrieverOptions {
  readonly store: LongTermStore;
  /** Minimum confidence to include in retrieval. Defaults to staleThreshold. */
  readonly minConfidence?: number;
}

/**
 * TF-IDF retriever for long-term memory. Fully deterministic, inspectable,
 * zero external dependencies.
 *
 * Pipeline:
 * 1. Category filtering (optional) narrows the search space
 * 2. TF-IDF scoring ranks remaining entries against the query
 * 3. Top-K results returned for prompt injection
 */
export class TfIdfRetriever {
  private readonly store: LongTermStore;
  private readonly minConfidence: number;

  constructor(options: TfIdfRetrieverOptions) {
    this.store = options.store;
    this.minConfidence = options.minConfidence ?? 0.2;
  }

  /**
   * Retrieve the top-K most relevant memories for a query.
   *
   * @param query  The user message or search text
   * @param topK   Maximum number of results (default 5)
   * @param category  Optional category filter applied before scoring
   */
  retrieve(
    query: string,
    topK: number = 5,
    category?: MemoryEntry["category"],
  ): readonly RetrievalResult[] {
    // 1. Filter candidates
    const candidates = this.store.search({
      category,
      minConfidence: this.minConfidence,
    });

    if (candidates.length === 0) return [];

    // 2. Tokenize query and all candidate documents
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const queryTf = termFrequency(queryTokens);

    const docData = candidates.map((entry) => ({
      entry,
      tf: termFrequency(tokenize(entry.content + " " + entry.tags.join(" "))),
    }));

    // 3. Compute IDF across the corpus
    const corpus = docData.map((d) => d.tf);
    const idf = inverseDocumentFrequency(corpus);

    // 4. Score each document
    const scored: RetrievalResult[] = docData
      .map(({ entry, tf }) => ({
        entry,
        score: tfidfScore(queryTf, tf, idf),
      }))
      .filter((r) => r.score > 0);

    // 5. Sort descending by score, take top-K
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Infer likely category from message content heuristics.
   * Returns undefined if no strong signal is detected.
   */
  inferCategory(message: string): MemoryEntry["category"] | undefined {
    const lower = message.toLowerCase();

    if (/\b(prefer|like|want|favorite|always|never)\b/.test(lower)) {
      return "preference";
    }
    if (/\b(step|how to|procedure|process|workflow|recipe)\b/.test(lower)) {
      return "procedure";
    }
    if (/\b(project|repo|codebase|sprint|milestone|deploy)\b/.test(lower)) {
      return "project";
    }
    if (/\b(who is|company|person|team|org|organization)\b/.test(lower)) {
      return "entity";
    }

    return undefined;
  }

  /**
   * Convenience: retrieve with automatic category inference.
   */
  retrieveWithInference(
    query: string,
    topK: number = 5,
  ): readonly RetrievalResult[] {
    const category = this.inferCategory(query);
    const results = this.retrieve(query, topK, category);

    // Fall back to unfiltered if category filtering yields too few results
    if (results.length < topK && category !== undefined) {
      const unfiltered = this.retrieve(query, topK);
      // Merge, deduplicate by id, re-sort
      const seen = new Set(results.map((r) => r.entry.id));
      const merged = [...results];
      for (const r of unfiltered) {
        if (!seen.has(r.entry.id)) {
          merged.push(r);
          seen.add(r.entry.id);
        }
      }
      merged.sort((a, b) => b.score - a.score);
      return merged.slice(0, topK);
    }

    return results;
  }
}
