import swaggerAutogen from "swagger-autogen";

const doc = {
  info: {
    title: "GPT Crawler API",
    description: "API for crawling websites and processing content with GPT",
    version: "1.0.0",
  },
  host: "localhost:3000",
  basePath: "/",
  schemes: ["http"],
  consumes: ["application/json"],
  produces: ["application/json"],
  tags: [
    {
      name: "Crawler",
      description: "Crawler endpoints",
    },
  ],
  definitions: {
    CrawlRequest: {
      name: {
        type: "string",
        example: "my-crawl-project",
        description: "Name of the crawl project",
      },
      url: {
        type: "string",
        example: "https://www.builder.io/c/docs/developers",
        description: "URL to start the crawl, if url is a sitemap, it will crawl all pages in the sitemap",
      },
      match: {
        oneOf: [
          {
            type: "string",
            example: "https://www.builder.io/c/docs/**",
          },
          {
            type: "array",
            items: {
              type: "string",
            },
            example: ["https://www.builder.io/c/docs/**", "https://www.builder.io/blog/**"],
          },
        ],
        description: "Pattern to match against for links on a page to subsequently crawl",
      },
      exclude: {
        oneOf: [
          {
            type: "string",
            example: "https://www.builder.io/private/**",
          },
          {
            type: "array",
            items: {
              type: "string",
            },
            example: ["https://www.builder.io/private/**", "https://www.builder.io/internal/**"],
          },
        ],
        description: "Pattern to match against for links on a page to exclude from crawling",
        required: false,
      },
      selector: {
        type: "string",
        example: ".docs-builder-container",
        description: "Selector to grab the inner text from",
        required: false,
      },
      maxPagesToCrawl: {
        type: "integer",
        example: 50,
        description: "Maximum number of pages to crawl",
        minimum: 1,
      },
      outputFileName: {
        type: "string",
        example: "output.json",
        description: "File name for the finished data",
        required: false,
      },
      cookie: {
        oneOf: [
          {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
            },
            required: ["name", "value"],
          },
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "string" },
              },
              required: ["name", "value"],
            },
          },
        ],
        example: {
          name: "cookieConsent",
          value: "true",
        },
        description: "Optional cookie to be set. E.g. for Cookie Consent",
        required: false,
      },
      waitForSelectorTimeout: {
        type: "integer",
        example: 1000,
        description: "Optional timeout for waiting for a selector to appear",
        minimum: 0,
        required: false,
      },
      resourceExclusions: {
        type: "array",
        items: {
          type: "string",
        },
        example: ["png", "jpg", "jpeg", "gif", "css", "js"],
        description: "Optional resources to exclude from crawling",
        required: false,
      },
      maxFileSize: {
        type: "integer",
        example: 1,
        description: "Optional maximum file size in megabytes to include in the output file",
        minimum: 1,
        required: false,
      },
      maxTokens: {
        type: "integer",
        example: 5000,
        description: "Optional maximum number tokens to include in the output file",
        minimum: 1,
        required: false,
      },
      uploadToGCP: {
        type: "boolean",
        example: false,
        description: "Whether to upload the crawl results to GCP",
        default: false,
        required: false,
      },
      cleanupAfterUpload: {
        type: "boolean",
        example: false,
        description: "Optional: Whether to delete local files after GCP upload",
        required: false,
      },
    },
    CrawlResponse: {
      message: {
        type: "string",
        example: "Crawling completed successfully",
      },
      crawlSummary: {
        type: "object",
        properties: {
          totalUrls: {
            type: "integer",
            example: 15,
          },
          successfulCrawls: {
            type: "integer",
            example: 12,
          },
          failedCrawls: {
            type: "integer",
            example: 3,
          },
          totalPdfFiles: {
            type: "integer",
            example: 5,
          },
          totalHtmlFiles: {
            type: "integer",
            example: 7,
          },
        },
      },
      crawlDetails: {
        type: "object",
        properties: {
          crawledUrls: {
            type: "array",
            items: {
              type: "string",
            },
            example: ["https://example.com/page1"],
          },
          failedUrls: {
            type: "array",
            items: {
              type: "string",
            },
            example: ["https://example.com/failed1"],
          },
        },
      },
      gcsPath: {
        type: "string",
        example: "gs://bucket-name/path/to/files",
        description: "GCS path where files were uploaded (if uploadToGCP was true)",
      },
    },
    Error: {
      message: {
        type: "string",
        example: "Error occurred during crawling",
      },
      error: {
        type: "object",
        properties: {
          code: {
            type: "string",
            example: "ERR_INVALID_URL",
          },
          message: {
            type: "string",
            example: "Invalid URL provided",
          },
          details: {
            type: "string",
            example: "Error stack trace or additional details",
          },
        },
      },
    },
  },
};

const outputFile = "./swagger-output.json";
const endpointsFiles = ["./src/server.ts"];

swaggerAutogen(outputFile, endpointsFiles, doc);
