import type { SQSHandler } from "aws-lambda";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION });

export const handler: SQSHandler = async (event) => {
  const failedIds: string[] = [];

  for (const record of event.Records) {
    try {
      // S3 event notification comes via SQS
      const s3Event = JSON.parse(record.body);
      const s3Records = s3Event.Records || [];

      for (const s3Record of s3Records) {
        const bucket = s3Record.s3.bucket.name;
        const key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, " "));

        if (!key.startsWith("originals/")) continue;

        // Get original
        const original = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks: Uint8Array[] = [];
        for await (const chunk of original.Body as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        // Process with Sharp (must be installed as ARM64 binary)
        // dynamic import to avoid bundling issues
        const sharp = (await import("sharp")).default;
        const hash = key.replace("originals/", "").replace(/\.[^.]+$/, "");

        // Thumbnail: 300px WebP
        const thumbnail = await sharp(buffer)
          .resize(300, 300, { fit: "cover" })
          .webp({ quality: 80 })
          .toBuffer();

        // Optimized: 1200px WebP
        const optimized = await sharp(buffer)
          .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer();

        await Promise.all([
          s3.send(new PutObjectCommand({
            Bucket: bucket, Key: `thumbnails/${hash}.webp`,
            Body: thumbnail, ContentType: "image/webp",
          })),
          s3.send(new PutObjectCommand({
            Bucket: bucket, Key: `optimized/${hash}.webp`,
            Body: optimized, ContentType: "image/webp",
          })),
        ]);

        console.log(JSON.stringify({ level: "info", msg: "Media processed", key, hash }));
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "Media processing failed", err, messageId: record.messageId }));
      failedIds.push(record.messageId);
    }
  }

  if (failedIds.length > 0) {
    return { batchItemFailures: failedIds.map((id) => ({ itemIdentifier: id })) };
  }
};
