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
        example: "https://example.com",
        description: "Starting URL for crawling",
      },
      match: {
        type: "string",
        example: "https://example.com/**",
        description: "URL pattern to match for crawling. Can be string or array of strings",
      },
      maxPagesToCrawl: {
        type: "integer",
        example: 10,
        description: "Maximum number of pages to crawl",
      },
      outputFileName: {
        type: "string",
        example: "output.json",
        description: "Optional: Name of the output file",
        required: false,
      },
      uploadToGCP: {
        type: "boolean",
        example: true,
        description: "Optional: Whether to upload results to GCP",
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
