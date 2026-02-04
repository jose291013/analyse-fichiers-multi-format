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
const { PDFDocument } = require('pdf-lib');


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
async function normalizePdfBoxes(pdfPath, widthPt, heightPt) {
  try {
    const bytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(bytes);
    const pages = pdfDoc.getPages();

    for (const page of pages) {
      // On force toutes les boxes à 0,0,width,height
      page.setMediaBox(0, 0, widthPt, heightPt);
      page.setCropBox(0, 0, widthPt, heightPt);
      page.setBleedBox(0, 0, widthPt, heightPt);
      page.setTrimBox(0, 0, widthPt, heightPt);
      page.setArtBox(0, 0, widthPt, heightPt);
    }

    const newBytes = await pdfDoc.save();
    fs.writeFileSync(pdfPath, newBytes);

    console.log('normalizePdfBoxes OK pour', pdfPath);
  } catch (e) {
    // Non bloquant : si ça plante, on garde quand même le PDF recadré
    console.warn('normalizePdfBoxes erreur (non bloquant):', e.message);
  }
}


// Recadrer un PDF sur un bounding box donné (et aligner toutes les boxes)
function cropPdfToBbox(inputPdf, outputPdf, bbox) {
  return new Promise((resolve, reject) => {
    const { llx, lly, widthPt, heightPt } = bbox;

    // Décalage pour ramener le contenu en (0,0)
    const offsetX = -llx;
    const offsetY = -lly;

    const cmd = `${GS_CMD} -dSAFER -dNOPAUSE -dBATCH ` +
      `-sDEVICE=pdfwrite ` +
      `-dDEVICEWIDTHPOINTS=${widthPt} ` +
      `-dDEVICEHEIGHTPOINTS=${heightPt} ` +
      `-dFIXEDMEDIA ` +
      `-sOutputFile="${outputPdf}" ` +
      `-c "<</PageSize [${widthPt} ${heightPt}] ` +
      `/MediaBox [0 0 ${widthPt} ${heightPt}] ` +
      `/CropBox  [0 0 ${widthPt} ${heightPt}] ` +
      `/BleedBox [0 0 ${widthPt} ${heightPt}] ` +
      `/TrimBox  [0 0 ${widthPt} ${heightPt}] ` +
      `/ArtBox   [0 0 ${widthPt} ${heightPt}] ` +
      `/PageOffset [${offsetX} ${offsetY}]>> setpagedevice" ` +
      `-f "${inputPdf}"`;

    console.log('cropPdfToBbox bbox =', bbox);
    console.log('cropPdfToBbox command:', cmd);

    exec(cmd, async (err, stdout, stderr) => {
      if (err) {
        console.error('Erreur cropPdfToBbox:', err);
        console.error('stderr:', stderr);
        return reject(err);
      }

      console.log('cropPdfToBbox Ghostscript OK pour', outputPdf);

      // 🔹 Étape 2 : on force les Media/Crop/Bleed/Trim/ArtBox dans le PDF
      await normalizePdfBoxes(outputPdf, widthPt, heightPt);

      resolve();
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
// Conversion AI (Illustrator PDF-compatible) → PDF via Ghostscript
// Ici on utilise -dEPSCrop pour recadrer directement sur le bounding box
// Conversion AI (Illustrator PDF-compatible) → PDF brut via Ghostscript
// Conversion AI (Illustrator PDF-compatible) → PDF brut via Ghostscript
function convertAiToPdf(aiPath, pdfPath) {
  return new Promise((resolve, reject) => {
    const command =
      `${GS_CMD} -dSAFER -dNOPAUSE -dBATCH ` +
      `-sDEVICE=pdfwrite ` +             // ❌ plus de -dEPSCrop ici
      `-sOutputFile="${pdfPath}" ` +
      `"${aiPath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Erreur Ghostscript AI->PDF :', stderr || error.message);
        return reject(new Error('AI to PDF conversion failed'));
      }
      console.log('convertAiToPdf OK pour', pdfPath);
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

/// ---- Nouvelle route : conversion en PDF pour formats non supportés (ex: SVG / AI) ----
/// ---- Nouvelle route : conversion en PDF pour formats non supportés (ex: SVG / AI) ----
// ---- Conversion des formats non supportés (SVG / AI) en PDF pour pdf2press ----
// ---- Conversion des formats non supportés (SVG / AI) en PDF pour pdf2press ----
app.post('/convert-to-pdf', upload.single('FILE'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No file uploaded' });
  }

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname || '').toLowerCase();

  try {
    // On accepte maintenant : SVG, AI, PDF
    if (ext !== '.svg' && ext !== '.ai' && ext !== '.pdf') {
      return res
        .status(400)
        .json({ ok: false, error: `Conversion to PDF not implemented for ${ext}` });
    }

    const baseName = path.basename(req.file.originalname, ext);
    const safeBase = baseName.replace(/[^a-z0-9_\-]/gi, '_') || 'file';

    const outName = `${Date.now()}_${safeBase}.pdf`;
    const finalPdfPath = path.join(convertedDir, outName);

    // -------------------------------
    // CAS 1 : SVG → PDF + recadrage
    // -------------------------------
    if (ext === '.svg') {
      const tmpPdfPath = finalPdfPath + '.tmp';

      // 1) SVG -> PDF brut
      await convertSvgToPdf(filePath, tmpPdfPath);

      // 2) bbox sur le PDF brut
      const rawBbox = await runGhostscriptBBox(tmpPdfPath);
      console.log("rawBbox SVG convert-to-pdf =", rawBbox);

      const bboxForCrop = {
        llx: rawBbox.llx,
        lly: rawBbox.lly,
        widthPt: rawBbox.widthPt,
        heightPt: rawBbox.heightPt
      };

      // 3) Recadrage du PDF sur ce bbox (sans scale)
      await cropPdfToBbox(tmpPdfPath, finalPdfPath, bboxForCrop);

      // supprimer le PDF intermédiaire
      try {
        if (fs.existsSync(tmpPdfPath)) fs.unlinkSync(tmpPdfPath);
      } catch (e) {
        console.warn("Erreur suppression tmpPdfPath:", e.message);
      }

      const widthMm = rawBbox.widthPt * 25.4 / 72;
      const heightMm = rawBbox.heightPt * 25.4 / 72;

      return res.json({
        ok: true,
        pdfPath: `/converted/${outName}`,
        pdfFileName: outName,
        format: 'pdf',
        llx: rawBbox.llx,
        lly: rawBbox.lly,
        urx: rawBbox.urx,
        ury: rawBbox.ury,
        widthPt: rawBbox.widthPt,
        heightPt: rawBbox.heightPt,
        width_mm: +widthMm.toFixed(2),
        height_mm: +heightMm.toFixed(2),
        source: (rawBbox.source || 'ghostscript') + '_svg_cropped'
      });
    }

    // -------------------------------
    // CAS 2 : AI → PDF + recadrage
    // -------------------------------
    if (ext === '.ai') {
      const tmpPdfPath = finalPdfPath + '.tmp';

      // 1) AI -> PDF brut (page originale, sans crop)
      await convertAiToPdf(filePath, tmpPdfPath);

      // 2) bbox sur le PDF brut
      const rawBbox = await runGhostscriptBBox(tmpPdfPath);
      console.log("rawBbox AI convert-to-pdf =", rawBbox);

      const bboxForCrop = {
        llx: rawBbox.llx,
        lly: rawBbox.lly,
        widthPt: rawBbox.widthPt,
        heightPt: rawBbox.heightPt
      };

      // 3) Recadrage du PDF sur ce bbox
      await cropPdfToBbox(tmpPdfPath, finalPdfPath, bboxForCrop);

      // supprimer le PDF intermédiaire
      try {
        if (fs.existsSync(tmpPdfPath)) fs.unlinkSync(tmpPdfPath);
      } catch (e) {
        console.warn("Erreur suppression tmpPdfPath (AI):", e.message);
      }

      const widthMm = rawBbox.widthPt * 25.4 / 72;
      const heightMm = rawBbox.heightPt * 25.4 / 72;

      return res.json({
        ok: true,
        pdfPath: `/converted/${outName}`,
        pdfFileName: outName,
        format: 'pdf',
        llx: rawBbox.llx,
        lly: rawBbox.lly,
        urx: rawBbox.urx,
        ury: rawBbox.ury,
        widthPt: rawBbox.widthPt,
        heightPt: rawBbox.heightPt,
        width_mm: +widthMm.toFixed(2),
        height_mm: +heightMm.toFixed(2),
        source: (rawBbox.source || 'ghostscript') + '_ai_cropped'
      });
    }

    // -------------------------------
    // CAS 3 : PDF → PDF recadré
    // -------------------------------
    if (ext === '.pdf') {
      // 1) bbox sur le PDF uploadé
      const rawBbox = await runGhostscriptBBox(filePath);
      console.log("rawBbox PDF convert-to-pdf =", rawBbox);

      const bboxForCrop = {
        llx: rawBbox.llx,
        lly: rawBbox.lly,
        widthPt: rawBbox.widthPt,
        heightPt: rawBbox.heightPt
      };

      // 2) Recadrage direct du PDF
      await cropPdfToBbox(filePath, finalPdfPath, bboxForCrop);

      const widthMm = rawBbox.widthPt * 25.4 / 72;
      const heightMm = rawBbox.heightPt * 25.4 / 72;

      return res.json({
        ok: true,
        pdfPath: `/converted/${outName}`,
        pdfFileName: outName,
        format: 'pdf',
        llx: rawBbox.llx,
        lly: rawBbox.lly,
        urx: rawBbox.urx,
        ury: rawBbox.ury,
        widthPt: rawBbox.widthPt,
        heightPt: rawBbox.heightPt,
        width_mm: +widthMm.toFixed(2),
        height_mm: +heightMm.toFixed(2),
        source: (rawBbox.source || 'ghostscript') + '_pdf_cropped'
      });
    }

  } catch (err) {
    console.error('convert-to-pdf error:', err);
    return res
      .status(500)
      .json({ ok: false, error: err.message || 'Convert to PDF failed' });
  } finally {
    // on supprime le fichier uploadé (AI/SVG/PDF original)
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




