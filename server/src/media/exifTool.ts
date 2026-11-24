import os from 'node:os';
import { ExifTool } from 'exiftool-vendored';

export const exiftool = new ExifTool({
  taskTimeoutMillis: 15000,
  maxProcs: Math.min(6, Math.max(2, Math.floor(os.cpus().length / 2))),
});
