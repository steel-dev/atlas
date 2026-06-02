import { PDFParse } from "pdf-parse";

interface PdfTextExtraction {
  text: string;
}

export async function extractPdfText(data: Uint8Array): Promise<PdfTextExtraction> {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return { text: result.text };
  } finally {
    await parser.destroy();
  }
}
