'use strict';

const fs = require('node:fs');
const path = require('node:path');

function atomicWriteFileSync(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Work in the directory's REAL path: on Windows an exclusive create through
  // a junction (e.g. ~/.claude moved to another drive) fails with EEXIST even
  // when nothing exists, which would make every Guardian write -- and with it
  // the hard block -- fail.
  const dir = fs.realpathSync.native(path.dirname(filePath));
  const target = path.join(dir, path.basename(filePath));
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
  fs.renameSync(tmpPath, target);
}

module.exports = { atomicWriteFileSync };
