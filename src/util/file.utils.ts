import tiktoken from "tiktoken";
import pdfParse from "pdf-parse";


// Token counter
export function countToken(text: string): number {
  // This encoding is used in GPT-4
  const encoding = tiktoken.get_encoding("cl100k_base");
  const tokenCount = encoding.encode(text);

  return tokenCount?.length ?? 0;
}


export const getPdfContent = async (url: string): Promise<{ title: string; text: string; fileName: string; rawData: Buffer } | null> => {
  let title: string = "";
  let text: string = "";
  let fileName: string = "";
  let rawData: Buffer = Buffer.from("");

  console.log("PDF file found - ", url);

  try {
    // Fetch PDF data from the URL
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': new URL(url).origin,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch PDF from ${url}, status ${response.status}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const pdfData = Buffer.from(arrayBuffer);

    // Parse PDF content using pdf-parse
    const pdfParsedData = await pdfParse(pdfData);

    text = pdfParsedData.text;
    rawData = pdfData;

    // Check if the PDF has a title
    title = pdfParsedData.info.Title || ""; // Default title

    // Extract possible titles from the PDF content
    const candidateTitles = extractPossiblePdfTitles(text.split("\n"));
    if (candidateTitles.length > 0) {
      title = candidateTitles[0]; // Use the first candidate title
      console.log(candidateTitles);
    }

    if (title === "" || title === "0" || title === "O") {
      // If no title found, create a title from the URL
      title = createPdfTitleFromUrl(url);
    }

    fileName = `${title.replace(/[^\w\s]/gi, "-")}`; // Sanitize title for file name

    return { title, text, fileName, rawData };
  } catch (error) {
    console.error(`Error fetching or processing PDF from ${url}:`, error);
    return null;
  }
};


export const extractPossiblePdfTitles = (pdfLines: string[]): string[] => {
  const subjectRegexes = [/SUBJECT:\s*(.*)/i, /TITLE:\s*(.*)/i];

  const mappedPdfLines = pdfLines.map((item) => {
    for (const regex of subjectRegexes) {
      const match = item.match(regex);
      if (match) {
        return match[1].trim();
      }
    }
    return ""; // Explicit return for cases where no match is found
  });

  return mappedPdfLines.filter((item) => item !== "");
};

export const createPdfTitleFromUrl = (url: string): string => {
  const urlParts = url.split("/");
  let fileName = urlParts[urlParts.length - 1]; // Get the last part of the URL (filename)
  fileName = fileName.split(".")[0];
  fileName = `${fileName.replace(/[^\w\s]/gi, "-")}`; // Sanitize title for file name

  return fileName;
};
