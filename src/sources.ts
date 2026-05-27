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
