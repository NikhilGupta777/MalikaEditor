import { promises as fs } from "fs";

const VIDEO_MAGIC_BYTES: { [key: string]: { bytes: number[]; offset?: number }[] } = {
  "video/mp4": [
    { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  ],
  "video/quicktime": [
    { bytes: [0x66, 0x74, 0x79, 0x70, 0x71, 0x74], offset: 4 },
    { bytes: [0x6D, 0x6F, 0x6F, 0x76], offset: 4 },
  ],
  "video/webm": [
    { bytes: [0x1A, 0x45, 0xDF, 0xA3] },
  ],
  "video/x-msvideo": [
    { bytes: [0x52, 0x49, 0x46, 0x46] },
  ],
  "video/x-matroska": [
    { bytes: [0x1A, 0x45, 0xDF, 0xA3] },
  ],
  "video/mpeg": [
    { bytes: [0x00, 0x00, 0x01, 0xBA] },
    { bytes: [0x00, 0x00, 0x01, 0xB3] },
  ],
};

export async function validateVideoMagicBytes(filePath: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(12);
    await handle.read(buffer, 0, 12, 0);
    await handle.close();

    for (const [mimeType, signatures] of Object.entries(VIDEO_MAGIC_BYTES)) {
      for (const sig of signatures) {
        const offset = sig.offset || 0;
        let matches = true;
        for (let i = 0; i < sig.bytes.length; i++) {
          if (buffer[offset + i] !== sig.bytes[i]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          return { valid: true };
        }
      }
    }

    const ftypOffset4 = buffer.slice(4, 8).toString("ascii");
    if (ftypOffset4 === "ftyp") {
      return { valid: true };
    }

    return {
      valid: false,
      error: "File does not appear to be a valid video format",
    };
  } catch (error) {
    return {
      valid: false,
      error: "Could not validate file format",
    };
  }
}
