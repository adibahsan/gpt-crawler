import { Storage } from "@google-cloud/storage";
import dotenv from "dotenv";
import path from "path";

// Load environment variables
dotenv.config();

async function testGCSConnection() {
  try {
    console.log("Testing GCS Connection...");

    // Log environment variables (sanitized)
    console.log("Environment Check:");
    console.log(
      "- GOOGLE_APPLICATION_CREDENTIALS:",
      process.env.GOOGLE_APPLICATION_CREDENTIALS ? "✓ Set" : "✗ Missing",
    );
    console.log(
      "- GCP_BUCKET_NAME:",
      process.env.GCP_BUCKET_NAME ? "✓ Set" : "✗ Missing",
    );

    // Initialize Storage
    const storage = new Storage({
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    });

    // Test bucket listing
    console.log("\nTesting bucket access...");
    const [buckets] = await storage.getBuckets();
    console.log(
      "Available buckets:",
      buckets.map((b) => b.name),
    );

    // Test specific bucket access
    if (process.env.GCP_BUCKET_NAME) {
      console.log(`\nTesting access to bucket: ${process.env.GCP_BUCKET_NAME}`);
      const bucket = storage.bucket(process.env.GCP_BUCKET_NAME);
      const [exists] = await bucket.exists();
      console.log("Bucket exists:", exists ? "✓ Yes" : "✗ No");

      if (exists) {
        // Test file listing
        console.log("\nTesting file listing...");
        const [files] = await bucket.getFiles({ maxResults: 5 });
        console.log(
          "First 5 files in bucket:",
          files.map((f) => f.name),
        );

        // Test write permission
        console.log("\nTesting write permission...");
        const testFileName = `test-${Date.now()}.txt`;
        const file = bucket.file(testFileName);
        await file.save("Test content");
        console.log("Test file created:", testFileName);

        // Clean up test file
        await file.delete();
        console.log("Test file cleaned up");
      }
    }

    console.log("\n✅ GCS Connection test completed successfully!");
  } catch (error) {
    console.error("\n❌ GCS Connection test failed:", error);

    // // Provide more helpful error messages
    // if (error.code === 'ENOENT') {
    //     console.error('\nCredentials file not found. Make sure:');
    //     console.error('1. You have downloaded your service account key');
    //     console.error('2. The path in GOOGLE_APPLICATION_CREDENTIALS is correct');
    //     console.error(`3. The file exists at: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
    // } else if (error.code === 403) {
    //     console.error('\nPermission denied. Make sure:');
    //     console.error('1. Your service account has the correct permissions');
    //     console.error('2. The bucket name is correct');
    //     console.error('3. The project is correctly set up');
    // }
  }
}

// Run the test
testGCSConnection();
