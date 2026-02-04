// server.js - Version multi-format avec /analyze et /convert-to-pdf
// Objectif :
//  - /analyze : calculer le bounding box (en mm) pour EPS, PDF, AI, SVG
//  - /convert-to-pdf : convertir SVG / AI en PDF et exposer le fichier final

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// On réutilise ton analyseur EPS propre
const { analyzeEPS } = require('./analyzers/epsAnalyzer');

// Choix de la commande Ghostscript selon OS
const GS_CMD = process.platform === 'win32' ? 'gswin64c' : 'gs';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Répertoire des uploads temporaires
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Répertoire des fichiers convertis (PDF finaux)
const convertedDir = path.join(__dirname, 'converted');
if (!fs.existsSync(convertedDir)) {
  fs.mkdirSync(convertedDir, { recursive: true });
}

// Servir les PDF convertis en statique sous /converted/...
app.use('/converted', express.static(convertedDir));

// Multer : 100 Mo max
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 } // 100 Mo
});

// ---- Helpers communs ----

// Conversion points → mm
function ptToMm(pt) {
  return (pt * 25.4) / 72;
}

// Calcul du bounding box via Ghostscript (bbox rendu)
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
        llx,
        lly,
        urx,
        ury,
        widthPt,
        heightPt,
        width_mm: +ptToMm(widthPt).toFixed(2),
        height_mm: +ptToMm(heightPt).toFixed(2),
        source: 'ghostscript'
      });
    });
  });
}

// Recadrer un PDF sur le bounding box avec Ghostscript
// Recadrer un PDF sur le bounding box avec Ghostscript
function cropPdfToBbox(inputPdfPath, outputPdfPath, bbox) {
  return new Promise((resolve, reject) => {
    const { llx, lly, widthPt, heightPt } = bbox;

    // On log pour diagnostiquer si besoin
    console.log("cropPdfToBbox bbox =", { llx, lly, widthPt, heightPt });

    // Commande Ghostscript :
    //  - fixe la taille de page (DEVICEWIDTH/HEIGHTPOINTS + FIXEDMEDIA)
    //  - translate le contenu de -llx, -lly via PageOffset
    const parts = [
      GS_CMD,
      "-dSAFER",
      "-dNOPAUSE",
      "-dBATCH",
      "-sDEVICE=pdfwrite",
      `-dDEVICEWIDTHPOINTS=${widthPt}`,
      `-dDEVICEHEIGHTPOINTS=${heightPt}`,
      "-dFIXEDMEDIA",
      `-sOutputFile="${outputPdfPath}"`,
      `-c "<</PageOffset [${-llx} ${-lly}]>> setpagedevice"`,
      `-f "${inputPdfPath}"`
    ];

    const command = parts.join(" ");
    console.log("cropPdfToBbox command:", command);

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Erreur Ghostscript cropPdfToBbox :", stderr || error.message);
        return reject(new Error("PDF crop to bbox failed"));
      }
      console.log("cropPdfToBbox OK pour", outputPdfPath);
      resolve(outputPdfPath);
    });
  });
}



// Conversion SVG → PDF (via rsvg-convert)
// /!\ Nécessite le binaire système `rsvg-convert` (paquet librsvg2-bin sous Debian/Ubuntu)
function convertSvgToPdf(svgPath, pdfPath) {
  return new Promise((resolve, reject) => {
    const command = `rsvg-convert -f pdf -o "${pdfPath}" "${svgPath}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Erreur rsvg-convert :', stderr || error.message);
        return reject(new Error('SVG to PDF conversion failed'));
      }
      resolve(pdfPath);
    });
  });
}

// Conversion AI (Illustrator PDF-compatible) → PDF via Ghostscript
function convertAiToPdf(aiPath, pdfPath) {
  return new Promise((resolve, reject) => {
    const command = `${GS_CMD} -dSAFER -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile="${pdfPath}" "${aiPath}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Erreur Ghostscript AI->PDF :', stderr || error.message);
        return reject(new Error('AI to PDF conversion failed'));
      }
      resolve(pdfPath);
    });
  });
}

// ---- Analyseurs par type de fichier ----

// PDF : bounding box du contenu rendu (page 1)
async function analyzePDF(filePath) {
  const bbox = await runGhostscriptBBox(filePath);
  return {
    format: 'pdf',
    pageCount: 1, // tu pourras améliorer plus tard si besoin
    ...bbox
  };
}

// AI (Illustrator PDF-compatible) : même logique que PDF
async function analyzeAI(filePath) {
  const bbox = await runGhostscriptBBox(filePath);
  return {
    format: 'ai',
    pageCount: 1,
    ...bbox
  };
}

// SVG : SVG -> PDF -> bbox Ghostscript
// Facteur de correction 96 dpi (SVG) -> 72 points (PDF)
const SVG_DPI_FACTOR = 96 / 72;

async function analyzeSVG(filePath) {
  const pdfTemp = filePath + '.tmp.pdf';

  try {
    await convertSvgToPdf(filePath, pdfTemp);
    const raw = await runGhostscriptBBox(pdfTemp);

    const widthPtCorrected = raw.widthPt * SVG_DPI_FACTOR;
    const heightPtCorrected = raw.heightPt * SVG_DPI_FACTOR;

    const widthMmCorrected = +(raw.width_mm * SVG_DPI_FACTOR).toFixed(2);
    const heightMmCorrected = +(raw.height_mm * SVG_DPI_FACTOR).toFixed(2);

    return {
      format: 'svg',
      pageCount: 1,
      llx: raw.llx,
      lly: raw.lly,
      urx: raw.urx,
      ury: raw.ury,
      widthPt: widthPtCorrected,
      heightPt: heightPtCorrected,
      width_mm: widthMmCorrected,
      height_mm: heightMmCorrected,
      source: 'svg_ghostscript_96dpi_fix'
    };
  } finally {
    if (fs.existsSync(pdfTemp)) {
      fs.unlinkSync(pdfTemp);
    }
  }
}

// ---- Route multi-format d'analyse ----

app.post('/analyze', upload.single('FILE'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname || '').toLowerCase();

  try {
    let result;

    if (ext === '.eps' || ext === '.ps') {
      // EPS via ton epsAnalyzer propre
      result = await analyzeEPS(filePath);
    } else if (ext === '.pdf') {
      result = await analyzePDF(filePath);
    } else if (ext === '.ai') {
      result = await analyzeAI(filePath);
    } else if (ext === '.svg') {
      result = await analyzeSVG(filePath);
    } else {
      return res.status(400).json({ error: `Unsupported file type: ${ext}` });
    }

    // Réponse standardisée
    return res.json({
      fileName: req.file.originalname,
      ...result
    });
  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: err.message || 'Analyze failed' });
  } finally {
    // Nettoyage du fichier uploadé (on n'en a plus besoin pour /analyze)
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn('Erreur suppression fichier upload:', e.message);
    }
  }
});

// ---- Nouvelle route : conversion en PDF pour formats non supportés (ex: SVG / AI) ----

app.post('/convert-to-pdf', upload.single('FILE'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No file uploaded' });
  }

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname || '').toLowerCase();

  try {
    if (ext !== '.svg' && ext !== '.ai') {
      return res
        .status(400)
        .json({ ok: false, error: `Conversion to PDF not implemented for ${ext}` });
    }

    const baseName = path.basename(req.file.originalname, ext);
    const safeBase = baseName.replace(/[^a-z0-9_\-]/gi, '_') || 'file';

    // PDF final (recadré)
    const outName = `${Date.now()}_${safeBase}.pdf`;
    const finalPdfPath = path.join(convertedDir, outName);

    // PDF intermédiaire (avant recadrage)
    const tmpPdfPath = finalPdfPath + '.tmp';

    // 1) Conversion vers un PDF "brut"
    if (ext === '.svg') {
      await convertSvgToPdf(filePath, tmpPdfPath);
    } else if (ext === '.ai') {
      await convertAiToPdf(filePath, tmpPdfPath);
    }

    // 2) Bounding box sur ce PDF brut
    const rawBbox = await runGhostscriptBBox(tmpPdfPath);

    let bbox;
    if (ext === '.svg') {
      // 🔹 Correction 96dpi (SVG) -> 72pt (PDF)
      const factor = 96 / 72;
      bbox = {
        llx: rawBbox.llx * factor,
        lly: rawBbox.lly * factor,
        urx: rawBbox.urx * factor,
        ury: rawBbox.ury * factor,
        widthPt: rawBbox.widthPt * factor,
        heightPt: rawBbox.heightPt * factor,
        width_mm: +(rawBbox.width_mm * factor).toFixed(2),
        height_mm: +(rawBbox.height_mm * factor).toFixed(2),
        source: (rawBbox.source || 'ghostscript') + '_svg_96dpi_fix'
      };
    } else {
      // AI : bbox standard
      bbox = rawBbox;
    }

    // 3) Recadrage du PDF sur ce bounding box
    await cropPdfToBbox(tmpPdfPath, finalPdfPath, bbox);

    // On peut supprimer le PDF temporaire
    try {
      if (fs.existsSync(tmpPdfPath)) fs.unlinkSync(tmpPdfPath);
    } catch (e) {
      console.warn('Erreur suppression tmpPdfPath:', e.message);
    }

    // 4) Réponse vers le front
    return res.json({
      ok: true,
      pdfPath: `/converted/${outName}`,   // URL à préfixer côté Pressero
      pdfFileName: outName,
      format: 'pdf',
      ...bbox
    });
  } catch (err) {
    console.error('convert-to-pdf error:', err);
    return res
      .status(500)
      .json({ ok: false, error: err.message || 'Convert to PDF failed' });
  } finally {
    // On supprime le fichier uploadé original (AI/SVG)
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn('Erreur suppression fichier upload:', e.message);
    }
  }
});


// Petit endpoint de healthcheck
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'analyse-fichiers-multi-format' });
});

// Middleware d’erreur global
app.use((err, req, res, next) => {
  console.error('Erreur globale:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`🛠️ Serveur prêt sur le port ${port}`);
  console.log(`📁 Upload dir: ${uploadDir}`);
  console.log(`📁 Converted dir: ${convertedDir}`);
});
