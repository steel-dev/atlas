import { PDFParse } from "pdf-parse";

interface PdfTextExtraction {
  text: string;
}

const PAGE_MARKER = /--\s*\d+\s+of\s+\d+\s*--/g;
const NO_TEXT_LAYER =
  "[This PDF has no extractable text layer — it is likely a scanned or image-only document, so its text could not be read. Do not treat this as 'the fact is not in the document'; try an alternate source, an HTML version, or a different URL for the same content.]";

export async function extractPdfText(
  data: Uint8Array,
): Promise<PdfTextExtraction> {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    const text = result.text;
    const pages = (text.match(PAGE_MARKER) ?? []).length;
    const body = text.replace(PAGE_MARKER, " ");
    const alnum = (body.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (pages >= 2 && alnum < Math.max(200, pages * 20)) {
      return { text: NO_TEXT_LAYER };
    }
    return { text };
  } finally {
    await parser.destroy();
  }
}
