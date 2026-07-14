/**
* Copyright (c) 2014-present, Facebook, Inc.
* All rights reserved.
*/

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rimraf = require('rimraf');

const binaries = {
  'darwin': `bin/darwin/Fbx2Gtlf`,
  'linux': `bin/linux/Fbx2Gtlf`,
  'win32': `bin\windows\Fbx2Gtlf.exe`,
};

/**
 * Converts an FBX to a GTLF or GLB file.
 * @param string srcFile path to the source file.
 * @param string destFile path to the destination file or destination path.
 * This must end in `.glb` or `.gltf` (case matters).
 * @param string[] [opts] options to pass to the converter tool.
 * @return Promise<string> a promise that yields the full path to the converted
 * file, an error on conversion failure.
 */
function convert(srcFile, destFile, opts = []) {
  return new Promise((resolve, reject) => {
    try {
      let binExt = os.type() === 'Windows_NT' ? '.exe' : '';
      let tool = path.join(__dirname, 'bin', os.type(), 'FBX2glTF' + binExt);
      if (!fs.existsSync(tool)) {
        throw new Error(`Unsupported OS: ${os.type()}`);
      }

      let destExt = path.extname(destFile).toLowerCase();

      if (!destExt) {
        destExt = '.gltf'

        // Step 1: path.basename() strips any directory components or path
        // separators that may be embedded in the user-supplied srcFile value,
        // then we further drop the extension to obtain a bare filename stem.
        let srcFilename = path.basename(path.basename(srcFile), path.extname(srcFile))
        // Step 2: Allowlist validation — only permit safe filename characters
        // (alphanumerics, dots, hyphens, underscores) to prevent path
        // traversal components (e.g. "../", null bytes) from being embedded
        // in the filename before path.join.
        if (!srcFilename || !/^[\w.\-]+$/.test(srcFilename)) {
          throw new Error('Invalid source filename: only alphanumerics, dots, hyphens, and underscores are allowed')
        }
        // Step 3: Resolve the destination directory to an absolute path so the
        // boundary check below is reliable.
        const resolvedDestDir = path.resolve(destFile)
        // Step 4: Build the candidate path and immediately verify it is strictly
        // contained within resolvedDestDir.  Using path.resolve() on the joined
        // result neutralises any residual ".." segments, and the path.sep suffix
        // on the allowed prefix ensures a directory named "destDirExtra" cannot
        // pass a plain startsWith("destDir") check.
        const candidateDestFile = path.resolve(path.join(resolvedDestDir, srcFilename + destExt))
        if (!candidateDestFile.startsWith(resolvedDestDir + path.sep)) {
          throw new Error('Invalid destination path: path traversal detected')
        }
        destFile = candidateDestFile
      }

      if (destExt !== '.glb' && destExt !== '.gltf') {
        throw new Error(`Unsupported file extension: ${destFile}`);
      }

      const binary = opts.includes('--binary') || opts.includes('-b');

      if (binary && destExt !== '.glb') {
        destExt = '.glb';
      } else if (!binary && destExt === '.glb') {
        opts.push('--binary');
      }

      let srcPath = fs.realpathSync(srcFile);
      // Resolve the destination directory to a real, absolute path so any
      // symlinks and ".." segments are fully expanded before we use it as a
      // traversal boundary.  Using realpathSync here is intentional: it
      // guarantees that destDir is a concrete, canonical directory path that
      // cannot be manipulated via symbolic links or relative segments supplied
      // in the user-provided destFile argument.
      const resolvedDestDir = fs.realpathSync(path.resolve(path.dirname(destFile)));
      let destFilename = path.basename(destFile, path.extname(destFile)) + destExt;
      // Sanitize destFilename to strip any path separator characters that could
      // allow traversal components (e.g. "../") from being embedded in the filename.
      destFilename = destFilename.replace(/[/\\]/g, '');
      if (!destFilename || /^\.+$/.test(destFilename)) {
        throw new Error('Invalid destination filename: path traversal detected');
      }
      // Allowlist validation — only permit safe filename characters
      // (alphanumerics, dots, hyphens, underscores) before passing to path.join,
      // preventing null bytes or other special characters from reaching the call.
      if (!/^[\w.\-]+$/.test(destFilename)) {
        throw new Error('Invalid destination filename: only alphanumerics, dots, hyphens, and underscores are allowed');
      }
      // Resolve the joined path immediately so any residual ".." segments are
      // neutralised before the boundary check.  The candidate must be strictly
      // *inside* resolvedDestDir (i.e. start with the dir + separator), never
      // equal to it, because we expect a file path, not the directory itself.
      const resolvedDestPath = path.resolve(path.join(resolvedDestDir, destFilename));
      if (!resolvedDestPath.startsWith(resolvedDestDir + path.sep)) {
        throw new Error('Invalid destination path: path traversal detected');
      }
      let destPath = resolvedDestPath;

      let args = opts.slice(0);
      args.push('--input', srcPath, '--output', destPath);
      let child = childProcess.spawn(tool, args);

      let output = '';
      child.stdout.on('data', (data) => output += data);
      child.stderr.on('data', (data) => output += data);
      child.on('error', reject);
      child.on('close', code => {
        // the FBX SDK may create an .fbm dir during conversion; delete!
        let fbmCruft = srcPath.replace(/.fbx$/i, '.fbm');
        // don't stick a fork in things if this fails, just log a warning
        const onError = error =>
          error && console.warn(`Failed to delete ${fbmCruft}: ${error}`);
        try {
          fs.existsSync(fbmCruft) && rimraf(fbmCruft, {}, onError);
        } catch (error) {
          onError(error);
        }

        // non-zero exit code is failure
        if (code != 0) {
          reject(new Error(`Converter output:\n` +
                           (output.length ? output : "<none>")));
        } else {
          resolve(destPath);
        }
      });

    } catch (error) {
      reject(error);
    }
  });
}

module.exports = convert;
