// For more information, see https://crawlee.dev/
import { Configuration, PlaywrightCrawler, downloadListOfUrls } from "crawlee";
import { glob } from "glob";
import { Config, configSchema } from "./config.js";
import { Page } from "playwright";
import { isWithinTokenLimit } from "gpt-tokenizer";
import { PathLike } from "fs";
import { mkdir } from "fs/promises";
import { readdir, readFile, writeFile } from "fs/promises";
import path from "path";

let pageCounter = 0;
let crawler: PlaywrightCrawler;

export function getPageHtml(page: Page, selector = "body") {
  return page.evaluate((selector) => {
    // Check if the selector is an XPath
    if (selector.startsWith("/")) {
      const elements = document.evaluate(
        selector,
        document,
        null,
        XPathResult.ANY_TYPE,
        null,
      );
      let result = elements.iterateNext();
      return result ? result.textContent || "" : "";
    } else {
      // Handle as a CSS selector
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
    // PlaywrightCrawler crawls the web using a headless
    // browser controlled by the Playwright library.
    crawler = new PlaywrightCrawler(
      {
        // Use the requestHandler to process each of the crawled pages.
        async requestHandler({ request, page, enqueueLinks, log, pushData }) {
          if (request.loadedUrl && request.loadedUrl.endsWith(".pdf")) {
            log.warning("Skipping PDF URL: " + request.loadedUrl);
            return;
          }

          const title = await page.title();
          pageCounter++;
          log.info(
            `Crawling: Page ${pageCounter} / ${config.maxPagesToCrawl} - URL: ${request.loadedUrl}...`,
          );

          // Use custom handling for XPath selector
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

          // Save results as JSON to ./storage/datasets/default
          await pushData({ title, url: request.loadedUrl, html });

          if (config.onVisitPage) {
            await config.onVisitPage({ page, pushData });
          }

          const links = await page.$$eval("a", (elements) =>
            elements
              .map((el) => {
                const href = el.href;
                if (!href) return null;
                // Common document extensions to track
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
          console.log("Found document links before enqueuing:", links?.map((link) => link?.url));

          let pdfLinks = links.filter((link) => link?.type === "pdf");

          console.log(
            "found pdf links",
            pdfLinks.map((link) => link?.url),
          );
          // Extract links from the current page
          // and add them to the crawling queue.
          const { processedRequests, unprocessedRequests } = await enqueueLinks(
            {
              globs:
                typeof config.match === "string"
                  ? [config.match]
                  : config.match,
              exclude: [
                ...(typeof config.exclude === "string"
                  ? [config.exclude]
                  : config.exclude ?? []),
                "**/*.pdf", // Exclude PDF files from being enqueued
              ],
              transformRequestFunction: (request) => {
                if (request.url.endsWith(".pdf")) return false;
                return request;
              },
            },
          );

          const totalProcessedRequests = processedRequests.length;
          const filteredRequests = processedRequests.filter(
            (req) => !req.wasAlreadyPresent,
          );
          const filteredCount = filteredRequests.length;
          const uniqueKeys = filteredRequests.map((req) => req.uniqueKey);

          log.info(`Total processed requests: ${totalProcessedRequests}`);
          log.info(
            `Filtered requests count (wasAlreadyPresent: false): ${filteredCount}`,
          );
          log.info(
            `Unique keys of filtered requests: ${uniqueKeys.join(", ")}`,
          );
        },
        // Comment this option to scrape the full website.
        maxRequestsPerCrawl: config.maxPagesToCrawl,
        // Uncomment this option to see the browser window.
        // headless: false,
        preNavigationHooks: [
          // Abort requests for certain resource types
          async ({ request, page, log }) => {
            // Skip PDF URLs before navigation
            if (request.url.endsWith(".pdf")) {
              log.info("Skipping PDF URL before navigation: " + request.url);
              return;
            }

            // If there are no resource exclusions, return
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
          },
        ],
      },
      new Configuration({
        purgeOnStart: true,
      }),
    );

    const isUrlASitemap = /sitemap.*\.xml$/.test(config.url);

    if (isUrlASitemap) {
      const listOfUrls = await downloadListOfUrls({ url: config.url });

      // Add the initial URL to the crawling queue.
      await crawler.addRequests(listOfUrls);

      // Run the crawler
      await crawler.run();
    } else {
      // Add first URL to the queue and start the crawl.
      await crawler.run([config.url]);
    }
  }
}

export async function write(config: Config) {
  let nextFileNameString: PathLike = "";
  const jsonFiles = await glob("storage/datasets/default/*.json", {
    absolute: true,
  });

  console.log(`Found ${jsonFiles.length} files to combine...`);

  let currentResults: Record<string, any>[] = [];
  let currentSize: number = 0;
  let fileCounter: number = 1; // Initialize a counter for serialized numbers
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
        // Only write the batch if it's not empty (something to write)
        if (currentResults.length > 0) {
          await writeBatchToFile();
        }
        // Since the addition of a single item exceeded the token limit, halve it.
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

  // Iterate over each JSON file and process its contents.
  for (const file of jsonFiles) {
    const fileContent = await readFile(file, "utf-8");
    const data: Record<string, any> = JSON.parse(fileContent);
    await addContentOrSplit(data);
  }

  // Check if any remaining data needs to be written to a file.
  if (currentResults.length > 0) {
    await writeBatchToFile();
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
    return new Promise(async (resolve, reject) => {
      try {
        const baseFolder = "web-crawled";
        const outputFolder = `${baseFolder}/${
          this.config.name || "defaultFolder"
        }`;
        const jsonFolder = `${outputFolder}/json`;

        // Create output and json folders
        await mkdir(outputFolder, { recursive: true });
        await mkdir(jsonFolder, { recursive: true });

        // Read all JSON files from the default dataset folder
        const datasetFolder = "storage/datasets/default";
        const files = await readdir(datasetFolder);

        const combinedData = [];

        let fileCounter = 1; // Initialize a counter for serialized numbers

        for (const file of files) {
          if (path.extname(file) === ".json") {
            const filePath = path.join(datasetFolder, file);
            const content = await readFile(filePath, "utf-8");
            const data = JSON.parse(content);

            // Create a safe filename from the URL
            const safeFilename = this.createSafeFilename(data.url);
            // Add serialized number to the filename
            const jsonFileName = `${fileCounter
              .toString()
              .padStart(6, "0")}_${safeFilename}.json`;
            const jsonFilePath = path.join(jsonFolder, jsonFileName);

            // Write the individual JSON file
            await writeFile(jsonFilePath, JSON.stringify(data, null, 2));
            console.log(`Wrote JSON content to ${jsonFilePath}`);

            // Add to combined data with filename and filetype
            combinedData.push({
              filename: jsonFileName,
              filetype: "json",
              data: data,
            });

            fileCounter++; // Increment the counter for the next file
          }
        }

        // Write the combined JSON file (without a serialized number)
        const combinedFilePath = path.join(
          outputFolder,
          "combined_output.json",
        );
        await writeFile(
          combinedFilePath,
          JSON.stringify(combinedData, null, 2),
        );
        console.log(`Wrote combined JSON to ${combinedFilePath}`);

        resolve(combinedFilePath);
      } catch (error) {
        console.error(`Error in write method: ${error}`);
        reject(error);
      }
    });
  }

  private createSafeFilename(url: string): string {
    // Remove protocol and www
    let filename = url.replace(/^(https?:\/\/)?(www\.)?/, "");
    // Replace non-alphanumeric characters with underscores
    filename = filename.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    // Trim underscores from start and end
    filename = filename.replace(/^_+|_+$/g, "");
    // Limit length
    return filename.slice(0, 100);
  }
}

export default GPTCrawlerCore;
