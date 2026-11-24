import { atomicFileOps } from '../src/media/atomicFile.js';
import { rotatePhotoFile } from '../src/media/imagePipeline.js';

const exchange = atomicFileOps.exchangeFiles;
atomicFileOps.exchangeFiles = async (candidate, original) => {
  await exchange(candidate, original);
  process.stdout.write('EXCHANGE_COMPLETE\n');
  // The parent kills this synthetic process here to exercise the actual gap.
  await new Promise<void>(() => { setInterval(() => {}, 1000); });
};
await rotatePhotoFile(process.argv[2], 'jpg', 90);
