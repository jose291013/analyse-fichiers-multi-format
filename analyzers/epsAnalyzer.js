// analyzers/epsAnalyzer.js
//
// Analyse un fichier EPS et renvoie son bounding box + dimensions en mm.
// - 1er essai : lecture du header %%BoundingBox
// - fallback : calcul via Ghostscript (bbox rendu)

const fs = require('fs');
const { exec } = require('child_process');

// Choix de la commande Ghostscript selon l'OS
const GS_CMD = process.platform === 'win32' ? 'gswin64c' : 'gs';

// Conversion points → millimètres
function ptToMm(pt) {
  return (pt * 25.4) / 72;
}

// Fallback : calcul du bbox via Ghostscript (sDEVICE=bbox)
function runGhostscriptBBox(filePath) {
  return new Promise((resolve, reject) => {
    const command = `${GS_CMD} -dSAFER -dNOPAUSE -dBATCH -sDEVICE=bbox "${filePath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Ghostscript bbox error:', stderr || error.message);
        return reject(new Error('Ghostscript bbox failed'));
      }

      // On cherche la première HiResBoundingBox
      const match = stderr.match(
        /%%HiResBoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/
      );

      if (!match) {
        return reject(new Error('No HiResBoundingBox found in Ghostscript output'));
      }

      const [, llxStr, llyStr, urxStr, uryStr] = match;
      const llx = parseFloat(llxStr);
      const lly = parseFloat(llyStr);
      const urx = parseFloat(urxStr);
      const ury = parseFloat(uryStr);

      const widthPt = urx - llx;
      const heightPt = ury - lly;

      resolve({
        source: 'ghostscript',
        llx,
        lly,
        urx,
        ury,
        widthPt,
        heightPt,
        width_mm: +ptToMm(widthPt).toFixed(2),
        height_mm: +ptToMm(heightPt).toFixed(2)
      });
    });
  });
}

// Analyse les dimensions EPS
async function analyzeEPS(filePath) {
  // 1) Tentative lecture directe du header %%BoundingBox
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/%%BoundingBox:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);

    if (match) {
      const [, x1Str, y1Str, x2Str, y2Str] = match;
      const x1 = parseFloat(x1Str);
      const y1 = parseFloat(y1Str);
      const x2 = parseFloat(x2Str);
      const y2 = parseFloat(y2Str);

      const widthPt = x2 - x1;
      const heightPt = y2 - y1;

      return {
        format: 'eps',
        source: 'eps_header',
        llx: x1,
        lly: y1,
        urx: x2,
        ury: y2,
        widthPt,
        heightPt,
        width_mm: +ptToMm(widthPt).toFixed(2),
        height_mm: +ptToMm(heightPt).toFixed(2)
      };
    }
  } catch (err) {
    console.warn('Erreur lecture EPS (header):', err.message);
    // on tombera en fallback GS
  }

  // 2) Fallback : calcul via Ghostscript
  const bbox = await runGhostscriptBBox(filePath);
  return {
    format: 'eps',
    ...bbox
  };
}

module.exports = {
  analyzeEPS
};
