// analyzers/bboxGhostscript.js
const { exec } = require('child_process');

function runGhostscriptBBox(filePath) {
  return new Promise((resolve, reject) => {
    const command = `gs -dSAFER -dNOPAUSE -dBATCH -sDEVICE=bbox "${filePath}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Ghostscript bbox error:', stderr);
        return reject(new Error('Ghostscript bbox failed'));
      }

      // On recherche la première HiResBoundingBox
      const m = stderr.match(/%%HiResBoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/);
      if (!m) {
        return reject(new Error('No HiResBoundingBox found'));
      }

      const [, llxStr, llyStr, urxStr, uryStr] = m;
      const llx = parseFloat(llxStr);
      const lly = parseFloat(llyStr);
      const urx = parseFloat(uryStr ? urxStr : llxStr); // sécurité basique
      const ury = parseFloat(uryStr);

      const widthPt = urx - llx;
      const heightPt = ury - lly;
      const ptToMm = (pt) => pt * 25.4 / 72;

      resolve({
        llx, lly, urx, ury,
        widthPt,
        heightPt,
        width_mm: +ptToMm(widthPt).toFixed(2),
        height_mm: +ptToMm(heightPt).toFixed(2),
        method: 'bbox_render'
      });
    });
  });
}

module.exports = { runGhostscriptBBox };
