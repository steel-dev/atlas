export interface FetchedSource {
  url: string;
  title: string;
}

export interface VerifiedSource {
  url: string;
  title: string;
}

export interface SourceExtractionMetadata {
  markdownChars: number;
  extractionNotes: string[];
}

export interface SourceDocument {
  url: string;
  title: string;
  markdown: string;
  originalChars: number;
  storedChars: number;
  truncated: boolean;
  metadata: SourceExtractionMetadata;
}
