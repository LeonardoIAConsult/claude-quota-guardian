'use strict';

const fs = require('node:fs');
const path = require('node:path');

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  // 'wx' (O_CREAT|O_EXCL): the tmp name is predictable, so never write through
  // whatever already sits there -- a planted symlink would redirect the write.
  // A leftover from a crashed process with the same pid is removed (rmSync
  // deletes a symlink itself, not its target) and the exclusive create retried.
  try {
    fs.writeFileSync(tmpPath, content, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    fs.rmSync(tmpPath, { force: true });
    fs.writeFileSync(tmpPath, content, { flag: 'wx' });
  }
  fs.renameSync(tmpPath, filePath);
}

module.exports = { atomicWriteFileSync };
