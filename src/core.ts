import { Configuration, PlaywrightCrawler, downloadListOfUrls } from "crawlee";
import { glob } from "glob";
import { Config, configSchema } from "./config.js";
import { Page } from "playwright";
import { isWithinTokenLimit } from "gpt-tokenizer";
import fs, { PathLike } from "fs";
import { mkdir } from "fs/promises";
import { readdir, readFile, writeFile } from "fs/promises";
import path from "path";
import axios from "axios";
import PDFParser from "pdf2json";
import { parseOfficeAsync } from "officeparser";

let pageCounter = 0;
let crawler: PlaywrightCrawler;

const pdfParser = new PDFParser(this, true);
pdfParser.on("pdfParser_dataError", (errData) =>
    console.error(errData.parserError),
);
pdfParser.on("pdfParser_dataReady", (pdfData) => {
  console.log("pdfData", pdfData);
});

async function extractTextFromFile(filePath: string) {
  try {
    const data = await parseOfficeAsync(filePath);
    const output = data.toString();
    console.log("output of PDF", output);
    return output;
  } catch (error) {
    console.error(`Error extracting text from file ${filePath}:`, error);
    throw error;
  }
}

async function downloadPdf(url: string, outputPath: string) {
  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
    });

    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", (error) => {
        console.error(`Error writing PDF to ${outputPath}:`, error);
        reject(error);
      });
    });
  } catch (error) {
    console.error(`Error downloading PDF from ${url}:`, error);
    throw error;
  }
}

export function getPageHtml(page: Page, selector = "body") {
  return page.evaluate((selector) => {
    if (selector.startsWith("/")) {
      const elements = document.evaluate(
          selector,
          document,
          null,
          XPathResult.ANY_TYPE,
          null,
      );
      const result = elements.iterateNext();
      return result ? result.textContent || "" : "";
    } else {
      const el = document.querySelector(selector) as HTMLElement | null;
      return el?.innerText || "";
    }
  }, selector);
}

export async function waitForXPath(page: Page, xpath: string, timeout: number) {
  await page.waitForFunction(
      (xpath) => {
        const elements = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.ANY_TYPE,
            null,
        );
        return elements.iterateNext() !== null;
      },
      xpath,
      { timeout },
  );
}

export async function crawl(config: Config) {
  configSchema.parse(config);

  if (process.env.NO_CRAWL !== "true") {
    crawler = new PlaywrightCrawler(
        {
          async requestHandler({ request, page, enqueueLinks, log, pushData }) {
            try {
              if (request.loadedUrl && request.loadedUrl.endsWith(".pdf")) {
                log.warning("Skipping PDF URL: " + request.loadedUrl);
                return;
              }

              const title = await page.title();
              pageCounter++;
              log.info(
                  `Crawling: Page ${pageCounter} / ${config.maxPagesToCrawl} - URL: ${request.loadedUrl}...`,
              );

              let content = "";
              if (config.selector) {
                if (config.selector.startsWith("/")) {
                  await waitForXPath(
                      page,
                      config.selector,
                      config.waitForSelectorTimeout ?? 1000,
                  );
                } else {
                  await page.waitForSelector(config.selector, {
                    timeout: config.waitForSelectorTimeout ?? 1000,
                  });
                }
              }
              content = await getPageHtml(page, config.selector);
              const html = await getPageHtml(page, config.selector);

              await pushData({ title, url: request.loadedUrl, html });

              if (config.onVisitPage) {
                // @ts-ignore
                await config.onVisitPage({ page, pushData });
              }

              const links = await page.$$eval("a", (elements) =>
                  elements
                      .map((el) => {
                        const href = el.href;
                        if (!href) return null;
                        const fileExtensions = [
                          ".html",
                          ".pdf",
                          ".doc",
                          ".docx",
                          ".xls",
                          ".xlsx",
                          ".ppt",
                          ".pptx",
                          ".txt",
                          ".csv",
                        ];
                        if (
                            fileExtensions.some((ext) =>
                                href.toLowerCase().endsWith(ext),
                            ) ||
                            !href.includes(".")
                        ) {
                          return {
                            url: href,
                            type: href.split(".").pop()?.toLowerCase() || "html",
                          };
                        }
                        return null;
                      })
                      .filter((link) => link !== null),
              );

              const pdfLinks = links.filter((link) => link?.type === "pdf");

              const baseFolder = "web-crawled";
              const outputFolder = `${baseFolder}/${
                  config.name || "defaultFolder"
              }`;
              const pdfFolder = `${outputFolder}/pdf`;

              await mkdir(outputFolder, { recursive: true });
              await mkdir(pdfFolder, { recursive: true });

              await Promise.all(
                  pdfLinks.map(async (pdfLink) => {
                    const outputPath = path.join(
                        pdfFolder,
                        path.basename(pdfLink?.url ?? ""),
                    );
                    await downloadPdf(pdfLink?.url ?? "", outputPath);
                    log.info(`Downloaded PDF: ${pdfLink?.url} to ${outputPath}`);
                    const fileContent = await extractTextFromFile(outputPath);
                    await pushData({
                      title: "pdfcontent",
                      url: pdfLink?.url,
                      pdf: fileContent,
                    });
                  }),
              );

              const { processedRequests, unprocessedRequests } = await enqueueLinks(
                  {
                    globs:
                        typeof config.match === "string"
                            ? [config.match]
                            : config.match,
                    exclude: [
                      ...(typeof config.exclude === "string"
                          ? [config.exclude]
                          : (config.exclude ?? [])),
                      "**/*.pdf",
                    ],
                    transformRequestFunction: (request) => {
                      if (request.url.endsWith(".pdf")) return false;
                      return request;
                    },
                  },
              );

              log.info(`Total processed requests: ${processedRequests.length}`);
              log.info(
                  `Filtered requests count (wasAlreadyPresent: false): ${processedRequests.filter(
                      (req) => !req.wasAlreadyPresent,
                  ).length}`,
              );
            } catch (error) {
              log.error(`Error in requestHandler: ${error}`);
            }
          },
          maxRequestsPerCrawl: config.maxPagesToCrawl,
          preNavigationHooks: [
            async ({ request, page, log }) => {
              try {
                if (request.url.endsWith(".pdf")) {
                  log.info("Skipping PDF URL before navigation: " + request.url);
                  return;
                }

                const RESOURCE_EXCLUSTIONS = config.resourceExclusions ?? [];
                if (RESOURCE_EXCLUSTIONS.length === 0) {
                  return;
                }
                if (config.cookie) {
                  const cookies = (
                      Array.isArray(config.cookie) ? config.cookie : [config.cookie]
                  ).map((cookie) => {
                    return {
                      name: cookie.name,
                      value: cookie.value,
                      url: request.loadedUrl,
                    };
                  });
                  await page.context().addCookies(cookies);
                }
                await page.route(
                    `**\/*.{${RESOURCE_EXCLUSTIONS.join()}}`,
                    (route) => route.abort("aborted"),
                );
                log.info(
                    `Aborting requests for as this is a resource excluded route`,
                );
              } catch (error) {
                log.error(`Error in preNavigationHooks: ${error}`);
              }
            },
          ],
        },
        new Configuration({
          purgeOnStart: true,
        }),
    );

    try {
      const isUrlASitemap = /sitemap.*\.xml$/.test(config.url);
      if (isUrlASitemap) {
        const listOfUrls = await downloadListOfUrls({ url: config.url });
        await crawler.addRequests(listOfUrls);
        await crawler.run();
      } else {
        await crawler.run([config.url]);
      }
    } catch (error) {
      console.error(`Error in crawl function: ${error}`);
    }
  }
}

export async function write(config: Config) {
  let nextFileNameString: PathLike = "";
  try {
    const jsonFiles = await glob("storage/datasets/default/*.json", {
      absolute: true,
    });

    console.log(`Found ${jsonFiles.length} files to combine...`);

    let currentResults: Record<string, any>[] = [];
    let currentSize: number = 0;
    let fileCounter: number = 1;
    const maxBytes: number = config.maxFileSize
        ? config.maxFileSize * 1024 * 1024
        : Infinity;

    const getStringByteSize = (str: string): number =>
        Buffer.byteLength(str, "utf-8");

    const nextFileName = (): string =>
        `${config.outputFileName.replace(/\.json$/, "")}-${fileCounter}.json`;

    const writeBatchToFile = async (): Promise<void> => {
      nextFileNameString = nextFileName();
      await writeFile(
          nextFileNameString,
          JSON.stringify(currentResults, null, 2),
      );
      console.log(
          `Wrote ${currentResults.length} items to ${nextFileNameString}`,
      );
      currentResults = [];
      currentSize = 0;
      fileCounter++;
    };

    let estimatedTokens: number = 0;

    const addContentOrSplit = async (
        data: Record<string, any>,
    ): Promise<void> => {
      const contentString: string = JSON.stringify(data);
      const tokenCount: number | false = isWithinTokenLimit(
          contentString,
          config.maxTokens || Infinity,
      );

      if (typeof tokenCount === "number") {
        if (estimatedTokens + tokenCount > config.maxTokens!) {
          if (currentResults.length > 0) {
            await writeBatchToFile();
          }
          estimatedTokens = Math.floor(tokenCount / 2);
          currentResults.push(data);
        } else {
          currentResults.push(data);
          estimatedTokens += tokenCount;
        }
      }

      currentSize += getStringByteSize(contentString);
      if (currentSize > maxBytes) {
        await writeBatchToFile();
      }
    };

    for (const file of jsonFiles) {
      const fileContent = await readFile(file, "utf-8");
      const data: Record<string, any> = JSON.parse(fileContent);
      await addContentOrSplit(data);
    }

    if (currentResults.length > 0) {
      await writeBatchToFile();
    }
  } catch (error) {
    console.error(`Error in write function: ${error}`);
    throw error;
  }

  return nextFileNameString;
}

class GPTCrawlerCore {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async crawl() {
    await crawl(this.config);
  }

  async write(): Promise<PathLike> {
    try {
      const baseFolder = "web-crawled";
      const outputFolder = `${baseFolder}/${
          this.config.name || "defaultFolder"
      }`;
      const jsonFolder = `${outputFolder}/json`;

      await mkdir(outputFolder, { recursive: true });
      await mkdir(jsonFolder, { recursive: true });

      const datasetFolder = "storage/datasets/default";
      const files = await readdir(datasetFolder);

      const combinedData = [];

      let fileCounter = 1;

      for (const file of files) {
        if (path.extname(file) === ".json") {
          const filePath = path.join(datasetFolder, file);
          const content = await readFile(filePath, "utf-8");
          const data = JSON.parse(content);

          const safeFilename = this.createSafeFilename(data.url);
          const jsonFileName = `${fileCounter
              .toString()
              .padStart(6, "0")}_${safeFilename}.json`;
          const jsonFilePath = path.join(jsonFolder, jsonFileName);

          await writeFile(jsonFilePath, JSON.stringify(data, null, 2));
          console.log(`Wrote JSON content to ${jsonFilePath}`);

          combinedData.push({
            filename: jsonFileName,
            filetype: "json",
            data: data,
          });

          fileCounter++;
        }
      }

      const combinedFilePath = path.join(outputFolder, "combined_output.json");
      await writeFile(
          combinedFilePath,
          JSON.stringify(combinedData, null, 2),
      );
      console.log(`Wrote combined JSON to ${combinedFilePath}`);

      return combinedFilePath;
    } catch (error) {
      console.error(`Error in write method: ${error}`);
      throw error;
    }
  }

  private createSafeFilename(url: string): string {
    let filename = url.replace(/^(https?:\/\/)?(www\.)?/, "");
    filename = filename.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    filename = filename.replace(/^_+|_+$/g, "");
    return filename.slice(0, 100);
  }
}

export default GPTCrawlerCore;
