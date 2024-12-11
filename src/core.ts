import { Configuration, downloadListOfUrls, PlaywrightCrawler } from "crawlee";
import { glob } from "glob";
import { Config, configSchema } from "./config.js";
import { Page } from "playwright";
import { isWithinTokenLimit } from "gpt-tokenizer";
import fs, { PathLike } from "fs";
import { mkdir, readdir, readFile, rm, writeFile, access } from "fs/promises";
import path from "path";
import axios from "axios";
import PDFParser from "pdf2json";
import { parseOfficeAsync } from "officeparser";
import { CrawlStatus, FileFormat } from "./util/util.js";
import { countToken, getPdfContent } from "./util/file.utils.js";
import { exec } from "child_process";
import { Storage } from "@google-cloud/storage";
import { error } from "console";
// import puppeteer from 'puppeteer';

async function prepareOutputFolder(outputFolder: string) {
  try {
    await rm(outputFolder, { recursive: true, force: true });
    await mkdir(outputFolder, { recursive: true });
    console.log("Removing & RE-creating output folders ", outputFolder);
  } catch (error) {
    console.error(`Error preparing output folder: ${error}`);
    throw error;
  }
}

// Usage
let pageCounter = 0;
let crawler: PlaywrightCrawler;
const baseFolder = "web-crawled";

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
    // console.log("output of PDF", output);
    return data.toString();
  } catch (error) {
    console.error(`Error extracting text from file ${filePath}:`, error);
    return ""; // Return an empty string or handle the error as needed
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

async function createSafeFilename(url: string): Promise<string> {
  // Remove protocol and www
  let filename = url.replace(/(^\w+:|^)\/\//, '').replace(/^www\./, '');
  // Replace all non-alphanumeric characters with underscore
  filename = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  // Remove trailing underscores
  filename = filename.replace(/_+$/, '');
  // Limit filename length
  return filename.slice(0, 200);
}

async function checkIfFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let newPdfCounter = 0;
let newHtmlCounter = 0;
let skippedCounter = 0;

async function downloadAndProcessPdfs(
  links: { url: string; type: string }[],
  config: Config,
  log: any,
  pushData: any,
  requestUrl: string,
) {
  try {
    // Filter PDF links that match the config patterns
    const pdfLinks = links.filter(
      (link): link is { url: string; type: string } => {
        if (link?.type !== "pdf") return false;

        // Apply the same matching rules as HTML pages
        const matchPatterns = Array.isArray(config.match)
          ? config.match
          : [config.match];
        const excludePatterns = Array.isArray(config.exclude)
          ? config.exclude
          : config.exclude
            ? [config.exclude]
            : [];

        // Check if URL matches any of the include patterns
        const isMatched = matchPatterns.some((pattern) =>
          new RegExp(pattern.replace(/\*/g, ".*")).test(link.url),
        );

        // Check if URL matches any of the exclude patterns
        const isExcluded = excludePatterns.some((pattern) =>
          new RegExp(pattern.replace(/\*/g, ".*")).test(link.url),
        );

        return isMatched && !isExcluded;
      },
    );

    if (pdfLinks.length === 0) {
      return;
    }

    const outputFolder = `${baseFolder}/${config.name || "defaultFolder"}`;
    const pdfFolder = `${outputFolder}/pdf`;
    const jsonFolder = `${outputFolder}/json`;

    await mkdir(pdfFolder, { recursive: true });
    await mkdir(jsonFolder, { recursive: true });

    log.info(
      `Found ${pdfLinks.length} PDF links to process from ${requestUrl}`,
    );

    await Promise.all(
      pdfLinks.map(async (pdfLink) => {
        try {
          const safeFilename = await createSafeFilename(pdfLink.url);
          const outputPath = path.join(pdfFolder, `${safeFilename}.pdf`);
          const jsonPath = path.join(jsonFolder, `${safeFilename}.json`);

          log.info('File paths generated:', {
            originalUrl: pdfLink.url,
            safeFilename,
            pdfPath: outputPath,
            jsonPath
          });

          // Check file existence separately for better logging
          const pdfExists = await checkIfFileExists(outputPath);
          const jsonExists = await checkIfFileExists(jsonPath);

          log.info('File existence check:', {
            pdfPath: outputPath,
            pdfExists,
            jsonPath,
            jsonExists
          });

          // Skip if both PDF and JSON already exist
          if (pdfExists && jsonExists) {
            log.info(`Skipping ${pdfLink.url} - Files already exist`);
            skippedCounter++;
            return;
          }

          newPdfCounter++;
          const pdfFileName = safeFilename;
          log.info(
            `Crawling: PDF ${newPdfCounter} / ${config.maxPagesToCrawl}: ${pdfLink?.url} to with name ${pdfFileName} from -> ${requestUrl} -> ${outputPath}`,
          );

          const pdfContent = await getPdfContent(pdfLink?.url ?? "");
          // log.info(
          //   "pdfContent after getPdfContent",
          //   pdfContent?.fileName,
          //   pdfContent?.title,
          //   pdfContent?.text,
          // );
          if (pdfContent?.rawData) {
            await writeFile(outputPath, pdfContent.rawData);
            // log.info("PDF saved using raw data to:", outputPath);
          }

          const content =
            pdfContent?.text ?? (await extractTextFromFile(outputPath));
          const tokenCount = countToken(content);

          // Prepare data for both JSON file and pushData
          const data = {
            title: pdfFileName,
            counter: `${pdfLink.url}`,
            sourceUrl: requestUrl,
            url: pdfLink?.url,
            filetype: FileFormat.Pdf,
            status: CrawlStatus.Crawled,
            datetime: new Date().toISOString(),
            tokenCount,
            content,
          };

          // Save JSON file
          await writeFile(jsonPath, JSON.stringify(data, null, 2));
          log.info(`Successfully saved JSON at: ${jsonPath}`);

          // Push data to the system
          await pushData(data);
        } catch (error) {
          log.error(`Error processing PDF ${pdfLink?.url}:`, error);

          const errorData = {
            title: path.basename(pdfLink?.url ?? ""),
            url: pdfLink?.url,
            counter: `${pdfLink.url}`,
            sourceUrl: requestUrl,
            filetype: FileFormat.Pdf,
            status: CrawlStatus.Failed,
            datetime: new Date().toISOString(),
            error: `${error}`,
          };

          // // Save error information to JSON
          // await writeFile(jsonPath, JSON.stringify(errorData, null, 2));
          // log.info(`Saved error information to JSON at: ${jsonPath}`);

          // Push error data to the system
          await pushData(errorData);
        }
      }),
    );
  } catch (error) {
    log.error(
      `Critical error in downloadAndProcessPdfs for ${requestUrl}:`,
      error,
    );
    await pushData({
      url: requestUrl,
      counter: `${pageCounter} / ${config.maxPagesToCrawl}`,
      filetype: FileFormat.Pdf,
      status: CrawlStatus.Failed,
      datetime: new Date().toISOString(),
      error: `${error}`,
    });
  }
}

async function extractAndProcessHtmlContent(
  page: Page,
  config: Config,
  log: any,
  pushData: any,
  requestUrl: string,
) {
  try {
    // Check if URL matches the patterns
    const matchPatterns = Array.isArray(config.match)
      ? config.match
      : [config.match];
    const excludePatterns = Array.isArray(config.exclude)
      ? config.exclude
      : config.exclude
        ? [config.exclude]
        : [];

    // Check if URL matches any of the include patterns
    const isMatched = matchPatterns.some((pattern) =>
      new RegExp(pattern.replace(/\*/g, ".*")).test(requestUrl),
    );

    // Check if URL matches any of the exclude patterns
    const isExcluded = excludePatterns.some((pattern) =>
      new RegExp(pattern.replace(/\*/g, ".*")).test(requestUrl),
    );

    // Skip if URL doesn't match patterns or is excluded
    if (!isMatched || isExcluded) {
      log.info(
        `Skipping ${requestUrl} - Does not match patterns or is excluded`,
      );
      return;
    }

    const outputFolder = `${baseFolder}/${config.name || "defaultFolder"}`;
    const pdfFolder = `${outputFolder}/pdf`;
    const jsonFolder = `${outputFolder}/json`;

    await mkdir(pdfFolder, { recursive: true });
    await mkdir(jsonFolder, { recursive: true });

    const safeFilename = await createSafeFilename(requestUrl);
    const pdfPath = path.join(pdfFolder, `${safeFilename}.pdf`);
    const jsonPath = path.join(jsonFolder, `${safeFilename}.json`);

    log.info('File paths generated:', {
      originalUrl: requestUrl,
      safeFilename,
      pdfPath,
      jsonPath
    });

    // Check file existence separately for better logging
    const pdfExists = await checkIfFileExists(pdfPath);
    const jsonExists = await checkIfFileExists(jsonPath);

    log.info('File existence check:', {
      pdfPath,
      pdfExists,
      jsonPath,
      jsonExists
    });

    // Skip if both PDF and JSON already exist
    if (pdfExists && jsonExists) {
      log.info(`Skipping ${requestUrl} - Files already exist`);
      skippedCounter++;
      return;
    }

    newHtmlCounter++;
    const title = await page.title();
    pageCounter++;
    log.info(
      `Crawling: Page ${pageCounter} / ${config.maxPagesToCrawl} - URL: ${requestUrl}...`,
    );

    let html = "";
    let extractionError = null;

    try {
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
      html = await getPageHtml(page, config.selector);

      // Generate PDF from the page
      await page.pdf({
        path: pdfPath,
        format: 'A4',
        margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
        printBackground: true
      });

      log.info(`Successfully generated PDF at: ${pdfPath}`);

    } catch (error) {
      extractionError = error;
      log.error(`Error extracting content from ${requestUrl}: ${error}`);
    }

    const data = {
      title,
      counter: `${pageCounter} / ${config.maxPagesToCrawl}`,
      url: requestUrl,
      filetype: FileFormat.Html,
      status: extractionError ? CrawlStatus.Failed : CrawlStatus.Crawled,
      datetime: new Date().toISOString(),
      tokenCount: extractionError ? 0 : countToken(html),
      content: extractionError ? "" : html,
      error: extractionError ?? undefined,
    };

    // Write JSON file
    await writeFile(jsonPath, JSON.stringify(data, null, 2));
    await pushData(data);

    if (extractionError) {
      log.error(`Failed to process ${requestUrl}:`, error);
    } else {
      log.info(`Successfully processed ${requestUrl}`);
    }
  } catch (error) {
    // Handle any errors in the main function
    log.error(`Critical error processing ${requestUrl}:`, {
      error,
      selector: config.selector,
    });

    await pushData({
      title: "Error",
      counter: `${pageCounter} / ${config.maxPagesToCrawl}`,
      url: requestUrl,
      filetype: FileFormat.Html,
      status: CrawlStatus.Failed,
      datetime: new Date().toISOString(),
      tokenCount: 0,
      content: "",
      error,
    });
  }
}

async function getPageLinks(page: Page) {
  return await page.$$eval("a", (elements) =>
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
          fileExtensions.some((ext) => href.toLowerCase().endsWith(ext)) ||
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
}

export async function crawl(config: Config) {
  configSchema.parse(config);
  pageCounter = 0;
  const outputFolder = `${baseFolder}/${config.name || "defaultFolder"}`;

  // await prepareOutputFolder(outputFolder);

  if (process.env.NO_CRAWL !== "true") {
    crawler = new PlaywrightCrawler(
      {
        async requestHandler({ request, page, enqueueLinks, log, pushData }) {
          try {
            if (request.loadedUrl && request.loadedUrl.endsWith(".pdf")) {
              log.warning("Skipping PDF URL: " + request.loadedUrl);
              return;
            }

            const loadedUrl = request.loadedUrl ?? "";
            await extractAndProcessHtmlContent(
              page,
              config,
              log,
              pushData,
              loadedUrl,
            );

            if (config.onVisitPage) {
              // @ts-ignore
              await config.onVisitPage({ page, pushData });
            }

            try {
              const links = await getPageLinks(page);
              const validLinks = links.filter(
                (link): link is { url: string; type: string } => link !== null,
              );

              if (validLinks.length > 0) {
                try {
                  await downloadAndProcessPdfs(
                    validLinks,
                    config,
                    log,
                    pushData,
                    loadedUrl,
                  );
                } catch (pdfError) {
                  log.error(
                    `Error processing PDFs from ${loadedUrl}: - ${pdfError}`,
                  );
                  // Continue with crawling despite PDF processing error
                }
              } else {
                log.info(`No valid links found to process from ${loadedUrl}`);
              }
            } catch (linkError) {
              log.error(`Error extracting links from ${loadedUrl}:`, { error });
              // Continue with crawling despite link extraction error
            }

            const { processedRequests, unprocessedRequests } =
              await enqueueLinks({
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
              });

            log.info(`Total processed requests: ${processedRequests.length}`);
            log.info(
              `Filtered requests count (wasAlreadyPresent: false): ${
                processedRequests.filter((req) => !req.wasAlreadyPresent).length
              }`,
            );
          } catch (error) {
            log.error(
              `Error in requestHandler: ${error} - URL -${request.loadedUrl}`,
            );
            await pushData({
              title: "",
              counter: `${pageCounter} / ${config.maxPagesToCrawl}`,
              url: request.loadedUrl,
              filetype: FileFormat.Html,
              status: CrawlStatus.Failed,
              datetime: new Date().toISOString(),
              tokenCount: 0,
              content: "",
              error: `${error}`,
            });
          }
        },
        maxRequestsPerCrawl: config.maxPagesToCrawl,
        maxConcurrency: 5, // Add this to limit concurrent requests
        navigationTimeoutSecs: 180, // Increase from default 60s
        requestHandlerTimeoutSecs: 180, // Increase from default 60s
        maxRequestRetries: 5, // Add retry mechanism
        browserPoolOptions: {
          maxOpenPagesPerBrowser: 8,
          preLaunchHooks: [
            async () => {
              // Clear system memory before launching new browser
              if (process.platform === "linux") {
                await exec(
                  "sync && echo 3 | sudo tee /proc/sys/vm/drop_caches",
                );
              }
            },
          ],
        },
        sessionPoolOptions: {
          maxPoolSize: 100,
          sessionOptions: {
            maxUsageCount: 50,
          },
        },
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

export async function write(config: Config): Promise<PathLike> {
  try {
    const datasetFolder = path.join(
      "storage",
      "datasets",
      config.name || "default",
    );

    // If no new content was crawled, return existing crawl log if it exists
    if (newPdfCounter === 0 && newHtmlCounter === 0) {
      console.log("No new content was crawled. All URLs were either skipped or already processed.");

      const crawlLogFile = path.join(datasetFolder, "logs", "crawl.log.json");

      // Check if crawl log exists and return it
      try {
        await access(crawlLogFile);
        return crawlLogFile;
      } catch {
        // If no existing crawl log, return the dataset folder
        return datasetFolder;
      }
    }

    const jsonFolder = path.join(datasetFolder, "json");
    const pdfFolder = path.join(datasetFolder, "pdf");

    // Create all necessary folders upfront
    await mkdir(datasetFolder, { recursive: true });
    await mkdir(jsonFolder, { recursive: true });
    await mkdir(pdfFolder, { recursive: true });

    // Check if directory exists and has files
    const files = await readdir(datasetFolder).catch(() => []);

    if (files.length === 0) {
      console.log("No files found to process. This may happen if all URLs were skipped or if no new content was crawled.");
      return datasetFolder;
    }

    const crawledUrls: string[] = [];
    const failedUrls: string[] = [];
    let htmlCounter = 0;
    let pdfCounter = 0;
    let fileCounter = 1;

    const formattedData = [];
    const formattedDataWithText = [];

    for (const file of files) {
      if (path.extname(file) === ".json") {
        const filePath = path.join(datasetFolder, file);
        const content = await readFile(filePath, "utf-8");
        const data = JSON.parse(content);

        // Create safe filename without extension
        const safeFilename = await createSafeFilename(data.url);
        const formattedSafeFilename = safeFilename.replace(/\.json$/, "");

        // Base item structure without text
        const baseItem = {
          serial: fileCounter,
          url: data.url,
          title: data.title,
          fileName: formattedSafeFilename,
          fileType: data.filetype?.toLowerCase() || "html",
          jsonPath: path
            .join(
              "./datasets",
              config.name,
              "json",
              `${formattedSafeFilename}.json`,
            )
            .replace(/\\/g, "/"), // Convert Windows paths to forward slashes
          pdfPath:
            data.filetype?.toLowerCase() === "pdf"
              ? path
                  .join(
                    "./datasets",
                    config.name,
                    "pdf",
                    `${data.title ?? "unnamed"}`,
                  )
                  .replace(/\\/g, "/")
              : null,
          tokenCount: data.tokenCount || 0,
        };

        // Add to formattedData without text
        formattedData.push(baseItem);

        // Add to formattedDataWithText including text
        formattedDataWithText.push({
          ...baseItem,
          text: data?.content || data?.text || "",
        });

        if (data?.status === CrawlStatus.Crawled) {
          crawledUrls.push(data?.url);
          if (data?.filetype === FileFormat.Html) {
            htmlCounter++;
          } else if (data?.filetype === FileFormat.Pdf) {
            pdfCounter++;
          }
        } else {
          failedUrls.push(data?.url);
        }

        fileCounter++;
      }
    }

    const crawlMapData = {
      crawledUrls,
      failedUrls,
      totalPdf: pdfCounter,
      totalHtml: htmlCounter,
      newPdfCount: newPdfCounter,
      newHtmlCount: newHtmlCounter,
      skippedCount: skippedCounter
    };

    const outputFolder = `${baseFolder}/${config.name || "defaultFolder"}`;
    const logFolder = path.join(outputFolder, "logs");
    const crawlLogFile = path.join(logFolder, "crawl.log.json");
    const crawlMapFile = path.join(logFolder, "crawl.map.json");
    const configNameFile = path.join(outputFolder, `${config.name || "default"}.json`);

    await Promise.all([
      mkdir(outputFolder, { recursive: true }),
      mkdir(logFolder, { recursive: true }),
    ]);

    await Promise.all([
      writeFile(crawlMapFile, JSON.stringify(formattedData, null, 2)),
      writeFile(crawlLogFile, JSON.stringify(crawlMapData, null, 2)),
      writeFile(configNameFile, JSON.stringify(formattedDataWithText, null, 2)),
    ]);

    // Upload to GCS if configured
    if (process.env.GCP_BUCKET_NAME && config.uploadToGCP) {
      const storage = new Storage({
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      });
      const bucket = storage.bucket(process.env.GCP_BUCKET_NAME);

      // Create a folder structure in GCS
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const crawlId = `crawl-${timestamp}`;

      console.log(
        `\nUploading results to GCS bucket: ${process.env.GCP_BUCKET_NAME}/${crawlId}`,
      );

      // Upload combined output to root
      await bucket.upload(crawlMapFile, {
        destination: `${crawlId}/logs/crawl.map.json`,
        metadata: {
          contentType: "application/json",
        },
      });
      console.log("✅ Uploaded combined output");

      // Upload crawl map to logs directory
      await bucket.upload(crawlLogFile, {
        destination: `${crawlId}/logs/crawl.log.json`,
        metadata: {
          contentType: "application/json",
        },
      });
      console.log("✅ Uploaded crawl map to logs directory");

      // Upload config-named file to root directory
      await bucket.upload(configNameFile, {
        destination: `${crawlId}/${config.name || "default"}.json`,
        metadata: {
          contentType: "application/json",
        },
      });
      console.log(`✅ Uploaded ${config.name || "default"}.json to root directory`);

      // Upload JSON files to json directory
      const jsonFiles = await glob(`${jsonFolder}/*.json`);
      if (jsonFiles.length > 0) {
        console.log(`\nUploading ${jsonFiles.length} JSON files...`);
        await Promise.all(
          jsonFiles.map(async (filePath) => {
            const fileName = path.basename(filePath);
            await bucket.upload(filePath, {
              destination: `${crawlId}/json/${fileName}`,
              metadata: {
                contentType: "application/json",
              },
            });
          }),
        );
        console.log("✅ Uploaded all JSON files");
      }

      // Upload PDF files to pdf directory
      const pdfFolder = `${outputFolder}/pdf`;
      const pdfFiles = await glob(`${pdfFolder}/*.pdf`);
      if (pdfFiles.length > 0) {
        console.log(`\nUploading ${pdfFiles.length} PDF files...`);
        await Promise.all(
          pdfFiles.map(async (filePath) => {
            const fileName = path.basename(filePath);
            await bucket.upload(filePath, {
              destination: `${crawlId}/pdf/${fileName}`,
              metadata: {
                contentType: "application/pdf",
              },
            });
          }),
        );
        console.log(" Uploaded all PDF files");
      }

      // Log upload summary
      console.log("\nUpload Summary:");
      console.log(`- Combined output: ${crawlId}/logs/crawl.map.json`);
      console.log(`- Crawl map: ${crawlId}/logs/crawl_map.json`);
      console.log(`- Config file: ${crawlId}/${config.name || "default"}.json`);
      console.log(`- JSON files: ${jsonFiles.length}`);
      console.log(`- PDF files: ${pdfFiles.length}`);

      // Optionally clean up local files
      if (config.cleanupAfterUpload) {
        await rm(outputFolder, { recursive: true, force: true });
        console.log("\n🧹 Cleaned up local files");
      }

      // return `gs://${process.env.GCP_BUCKET_NAME}/${crawlId}`;
    }

    console.log(`Wrote combined JSON to ${crawlMapFile}`);
    return crawlLogFile;
  } catch (error) {
    console.error(`Error in write method:`, error);
    throw error;
  }
}

class GPTCrawlerCore {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async crawl() {
    await crawl(this.config);
  }

  async write(this: GPTCrawlerCore): Promise<PathLike> {
    try {
      const outputFolder = path.join(
          baseFolder,
          this.config.name || "defaultFolder",
      );
      // If no new content was crawled, return existing crawl log if it exists
      if (newPdfCounter === 0 && newHtmlCounter === 0) {
        console.log("No new content was crawled. All URLs were either skipped or already processed.");
        // const datasetFolder = path.join(
        //   "storage",
        //   "datasets",
        //   this.config.name || "default",
        // );
        const crawlLogFile = path.join(outputFolder, "logs", "crawl.log.json");


        // Check if crawl log exists and return it
        try {
         let output =  await access(crawlLogFile);
          return crawlLogFile;
        } catch {
          // If no existing crawl log, return the dataset folder
          return outputFolder;
        }
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const crawlId = `crawl-${timestamp}`;


      const jsonFolder = path.join(outputFolder, "json");
      const pdfFolder = path.join(outputFolder, "pdf");
      const logFolder = path.join(outputFolder, "logs");
      const crawlLogFile = path.join(logFolder, "crawl.log.json");
      const crawlMapFile = path.join(logFolder, "crawl.map.json");
      const configNameFile = path.join(outputFolder, `${this.config.name || "default"}.json`);

      await Promise.all([
        mkdir(outputFolder, { recursive: true }),
        mkdir(jsonFolder, { recursive: true }),
        mkdir(logFolder, { recursive: true }),
      ]);

      const datasetFolder = "storage/datasets/default";
      const files = await readdir(datasetFolder);

      const formattedData = [];
      const formattedDataWithText = [];
      let fileCounter = 1;
      let htmlCounter = 0;
      let pdfCounter = 0;
      const crawledUrls: string[] = [];
      const failedUrls: string[] = [];

      for (const file of files) {
        if (path.extname(file) === ".json") {
          const filePath = path.join(datasetFolder, file);
          const content = await readFile(filePath, "utf-8");
          const data = JSON.parse(content);

          // Create safe filename without extension
          const safeFilename = await createSafeFilename(data.url);
          const formattedSafeFilename = safeFilename.replace(/\.json$/, "");

          // Base item structure without text
          const baseItem = {
            serial: fileCounter,
            url: data.url,
            title: data.title,
            fileName: formattedSafeFilename,
            fileType: data.filetype?.toLowerCase() || "html",
            jsonPath: path
              .join(
                "./datasets",
                this.config.name,
                "json",
                `${formattedSafeFilename}.json`,
              )
              .replace(/\\/g, "/"), // Convert Windows paths to forward slashes
            pdfPath: path
                    .join(
                      "./datasets",
                      this.config.name,
                      "pdf",
                      `${formattedSafeFilename}.pdf`,
                    )
                    .replace(/\\/g, "/"),
            tokenCount: data.tokenCount || 0,
          };

          // Add to formattedData without text
          formattedData.push(baseItem);

          // Add to formattedDataWithText including text
          formattedDataWithText.push({
            ...baseItem,
            text: data?.content || data?.text || "",
          });

          if (data?.status === CrawlStatus.Crawled) {
            crawledUrls.push(data?.url);
            if (data?.filetype === FileFormat.Html) {
              htmlCounter++;
            } else if (data?.filetype === FileFormat.Pdf) {
              pdfCounter++;
            }
          } else {
            failedUrls.push(data?.url);
          }

          fileCounter++;
        }
      }

      const crawlMapData = {
        crawledUrls,
        failedUrls,
        totalPdf: pdfCounter,
        totalHtml: htmlCounter,
        newPdfCount: newPdfCounter,
        newHtmlCount: newHtmlCounter,
        skippedCount: skippedCounter
      };

      await Promise.all([
        writeFile(crawlMapFile, JSON.stringify(formattedData, null, 2)),
        writeFile(crawlLogFile, JSON.stringify(crawlMapData, null, 2)),
        writeFile(configNameFile, JSON.stringify(formattedDataWithText, null, 2)),
      ]);

      // Upload to GCS if configured
      if (process.env.GCP_BUCKET_NAME && this.config.uploadToGCP) {
        const storage = new Storage({
          keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        });
        const bucket = storage.bucket(process.env.GCP_BUCKET_NAME);

        // Create a folder structure in GCS
        const gcsBasePath = `${this.config.name}`;

        console.log(
          `\nUploading results to GCS bucket: ${process.env.GCP_BUCKET_NAME}/${gcsBasePath}`,
        );

        // Upload combined output to root
        await bucket.upload(crawlMapFile, {
          destination: `${gcsBasePath}/logs/crawl.map.json`,
          metadata: {
            contentType: "application/json",
          },
        });
        console.log("✅ Uploaded combined output");

        // Upload crawl map to logs directory
        await bucket.upload(crawlLogFile, {
          destination: `${gcsBasePath}/logs/crawl.log.json`,
          metadata: {
            contentType: "application/json",
          },
        });
        console.log("✅ Uploaded crawl map to logs directory");

        // Upload config-named file to root directory
        await bucket.upload(configNameFile, {
          destination: `${gcsBasePath}/${this.config.name || "default"}.json`,
          metadata: {
            contentType: "application/json",
          },
        });
        console.log(`✅ Uploaded ${this.config.name || "default"}.json to root directory`);

        // Upload JSON files to json directory
        const jsonFiles = await glob(`${jsonFolder}/*.json`);
        if (jsonFiles.length > 0) {
          console.log(`\nUploading ${jsonFiles.length} JSON files...`);
          await Promise.all(
            jsonFiles.map(async (filePath) => {
              const fileName = path.basename(filePath);
              await bucket.upload(filePath, {
                destination: `${gcsBasePath}/json/${fileName}`,
                metadata: {
                  contentType: "application/json",
                },
              });
            }),
          );
          console.log("✅ Uploaded all JSON files");
        }

        // Upload PDF files to pdf directory
        const pdfFiles = await glob(`${pdfFolder}/*.pdf`);
        if (pdfFiles.length > 0) {
          console.log(`\nUploading ${pdfFiles.length} PDF files...`);
          await Promise.all(
            pdfFiles.map(async (filePath) => {
              const fileName = path.basename(filePath);
              await bucket.upload(filePath, {
                destination: `${gcsBasePath}/pdf/${fileName}`,
                metadata: {
                  contentType: "application/pdf",
                },
              });
            }),
          );
          console.log(" Uploaded all PDF files");
        }

        // Log upload summary
        console.log("\nUpload Summary:");
        console.log(`- Combined output: ${gcsBasePath}/logs/crawl.map.json`);
        console.log(`- Crawl map: ${gcsBasePath}/logs/crawl_map.json`);
        console.log(`- Config file: ${gcsBasePath}/${this.config.name || "default"}.json`);
        console.log(`- JSON files: ${jsonFiles.length}`);
        console.log(`- PDF files: ${pdfFiles.length}`);

        // Optionally clean up local files
        if (this.config.cleanupAfterUpload) {
          await rm(outputFolder, { recursive: true, force: true });
          console.log("\n🧹 Cleaned up local files");
        }

        // return `gs://${process.env.GCP_BUCKET_NAME}/${gcsBasePath}`;
      }

      console.log(`Wrote combined JSON to ${crawlMapFile}`);
      return crawlLogFile;
    } catch (error) {
      console.error(`Error in write method:`, error);
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

async function uploadToGCS(
  bucketName: string,
  fileName: string,
  filePath: string,
) {
  try {
    const storage = new Storage({
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    });
    const bucket = storage.bucket(bucketName);

    // Upload file to GCP
    await bucket.upload(filePath, {
      destination: fileName,
      metadata: {
        contentType: "application/json",
        cacheControl: "public, max-age=31536000",
      },
    });

    console.log(`${fileName} uploaded to ${bucketName}`);

    // Optionally make the file public
    // await bucket.file(fileName).makePublic();

    return `gs://${bucketName}/${fileName}`;
  } catch (error) {
    console.error(`Error uploading to GCS: ${error}`);
    throw error;
  }
}

export default GPTCrawlerCore;
