export interface FetchedSource {
  url: string;
  title: string;
  sourceId?: string;
  canonicalUrl?: string;
}

export interface VerifiedSource {
  url: string;
  title: string;
  sourceId?: string;
  canonicalUrl?: string;
}

export interface SourceExtractionMetadata {
  markdownChars: number;
  extractionNotes: string[];
  method?: string;
  contentType?: string;
  finalUrl?: string;
  attempts?: SourceExtractionAttempt[];
  qualityWarnings?: string[];
  discoveredLinks?: SourceDiscoveredLink[];
  canonical?: string;
  author?: string;
  articleAuthor?: string;
  publishedTime?: string;
  modifiedTime?: string;
  description?: string;
  language?: string;
  jsonLd?: unknown;
}

export interface SourceExtractionAttempt {
  method: string;
  ok: boolean;
  note: string;
}

export interface SourceDiscoveredLink {
  url: string;
  title?: string;
}

export interface SourceDocument {
  sourceId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  markdown: string;
  originalChars: number;
  storedChars: number;
  truncated: boolean;
  metadata: SourceExtractionMetadata;
  chunks: SourceChunk[];
}

export interface SourceChunk {
  index: number;
  start: number;
  end: number;
}
