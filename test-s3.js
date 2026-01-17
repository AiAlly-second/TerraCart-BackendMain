const { S3Client, PutObjectCommand, ListBucketsCommand } = require("@aws-sdk/client-s3");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

const testS3Connection = async () => {
  console.log("🧪 Testing S3 Configuration...\n");

  // Check environment variables
  console.log("📋 Environment Variables:");
  console.log("  USE_S3:", process.env.USE_S3);
  console.log("  AWS_REGION:", process.env.AWS_REGION);
  console.log("  AWS_BUCKET_NAME:", process.env.AWS_BUCKET_NAME);
  console.log("  AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID ? "✅ Set" : "❌ Missing");
  console.log("  AWS_SECRET_ACCESS_KEY:", process.env.AWS_SECRET_ACCESS_KEY ? "✅ Set" : "❌ Missing");
  console.log("");

  if (process.env.USE_S3 !== "true") {
    console.log("⚠️  USE_S3 is not set to 'true'. S3 uploads are disabled.");
    console.log("   Files will be saved locally to /uploads folder.");
    return;
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.log("❌ AWS credentials are missing!");
    return;
  }

  // Initialize S3 Client
  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  try {
    // Test 1: List buckets (verify credentials)
    console.log("🔐 Test 1: Verifying AWS credentials...");
    const listCommand = new ListBucketsCommand({});
    const buckets = await s3.send(listCommand);
    console.log("✅ Credentials are valid!");
    console.log(`   Found ${buckets.Buckets.length} bucket(s):`);
    buckets.Buckets.forEach(bucket => {
      const isTarget = bucket.Name === process.env.AWS_BUCKET_NAME;
      console.log(`   ${isTarget ? '👉' : '  '} ${bucket.Name}`);
    });
    console.log("");

    // Test 2: Upload a test file
    console.log("📤 Test 2: Uploading test file to S3...");
    const testContent = `Test upload at ${new Date().toISOString()}`;
    const testKey = `test/upload-test-${Date.now()}.txt`;
    
    const uploadCommand = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: testKey,
      Body: testContent,
      ContentType: "text/plain",
    });

    await s3.send(uploadCommand);
    console.log("✅ Test file uploaded successfully!");
    console.log(`   Location: s3://${process.env.AWS_BUCKET_NAME}/${testKey}`);
    console.log(`   Public URL: https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${testKey}`);
    console.log("");

    console.log("🎉 All tests passed! S3 is configured correctly.");
    console.log("");
    console.log("💡 If uploads still fail, check:");
    console.log("   1. Bucket permissions (must allow PutObject)");
    console.log("   2. Bucket CORS settings (for browser uploads)");
    console.log("   3. IAM user permissions");

  } catch (error) {
    console.log("❌ S3 Test Failed!");
    console.log("");
    console.log("Error details:");
    console.log("  Code:", error.Code || error.code || "Unknown");
    console.log("  Message:", error.message);
    console.log("");

    if (error.Code === "InvalidAccessKeyId" || error.code === "InvalidAccessKeyId") {
      console.log("💡 Solution: Your AWS Access Key ID is invalid.");
      console.log("   - Check if the key is correct in .env");
      console.log("   - Verify the IAM user exists in AWS Console");
    } else if (error.Code === "SignatureDoesNotMatch" || error.code === "SignatureDoesNotMatch") {
      console.log("💡 Solution: Your AWS Secret Access Key is incorrect.");
      console.log("   - Double-check the secret key in .env");
      console.log("   - Make sure there are no extra spaces");
    } else if (error.Code === "NoSuchBucket" || error.code === "NoSuchBucket") {
      console.log("💡 Solution: The bucket doesn't exist or is in a different region.");
      console.log("   - Verify bucket name:", process.env.AWS_BUCKET_NAME);
      console.log("   - Check if region is correct:", process.env.AWS_REGION);
    } else if (error.Code === "AccessDenied" || error.code === "AccessDenied") {
      console.log("💡 Solution: Your IAM user doesn't have permission.");
      console.log("   - Go to AWS Console → IAM → Users → Your User");
      console.log("   - Add policy: AmazonS3FullAccess (or custom policy with PutObject)");
    }
  }
};

testS3Connection();
