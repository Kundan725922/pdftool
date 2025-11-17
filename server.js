const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const archiver = require('archiver');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const mammoth = require('mammoth');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static('downloads'));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = 'uploads';
    try {
      await fs.mkdir(uploadDir, { recursive: true });
    } catch (err) {}
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Helper function to clean up old files
async function cleanupOldFiles() {
  const dirs = ['uploads', 'downloads'];
  const maxAge = 3600000; // 1 hour
  
  for (const dir of dirs) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = await fs.stat(filePath);
        if (Date.now() - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
        }
      }
    } catch (err) {}
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupOldFiles, 1800000);

// ==================== CONVERT ENDPOINT ====================
app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    const { toFormat } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputPath = file.path;
    const outputFilename = `converted-${Date.now()}.${toFormat}`;
    const outputPath = path.join('downloads', outputFilename);

    await fs.mkdir('downloads', { recursive: true });

    const fromExt = path.extname(file.originalname).slice(1).toLowerCase();

    // Image conversions
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(fromExt) && 
        ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(toFormat)) {
      
      await sharp(inputPath)
        .toFormat(toFormat === 'jpg' ? 'jpeg' : toFormat)
        .toFile(outputPath);

    } 
    // PDF to images
    else if (fromExt === 'pdf' && ['jpg', 'png'].includes(toFormat)) {
      // This is a simplified version - you'd need pdf2pic or similar
      return res.status(400).json({ error: 'PDF to image conversion requires additional setup' });
    }
    // Text conversions
    else if (fromExt === 'txt' && toFormat === 'pdf') {
      const content = await fs.readFile(inputPath, 'utf-8');
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([600, 800]);
      
      // Simple text to PDF (basic implementation)
      page.drawText(content.slice(0, 500), {
        x: 50,
        y: 750,
        size: 12,
      });
      
      const pdfBytes = await pdfDoc.save();
      await fs.writeFile(outputPath, pdfBytes);
    }
    // DOCX to TXT
    else if (fromExt === 'docx' && toFormat === 'txt') {
      const result = await mammoth.extractRawText({ path: inputPath });
      await fs.writeFile(outputPath, result.value);
    }
    // TXT to DOCX
    else if (fromExt === 'txt' && toFormat === 'docx') {
      const content = await fs.readFile(inputPath, 'utf-8');
      const doc = new Document({
        sections: [{
          properties: {},
          children: [
            new Paragraph({
              children: [new TextRun(content)],
            }),
          ],
        }],
      });
      
      const buffer = await Packer.toBuffer(doc);
      await fs.writeFile(outputPath, buffer);
    }
    else {
      return res.status(400).json({ 
        error: `Conversion from ${fromExt} to ${toFormat} not supported` 
      });
    }

    // Cleanup input file
    await fs.unlink(inputPath);

    res.json({
      success: true,
      fileName: outputFilename,
      downloadUrl: `/downloads/${outputFilename}`,
      message: `Converted to ${toFormat.toUpperCase()}`
    });

  } catch (error) {
    console.error('Convert error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== MERGE ENDPOINT ====================
app.post('/api/merge', upload.array('files'), async (req, res) => {
  try {
    const files = req.files;
    
    if (!files || files.length < 2) {
      return res.status(400).json({ error: 'At least 2 files required for merging' });
    }

    const mergedPdf = await PDFDocument.create();

    for (const file of files) {
      const pdfBytes = await fs.readFile(file.path);
      const pdf = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
      
      // Cleanup input file
      await fs.unlink(file.path);
    }

    const outputFilename = `merged-${Date.now()}.pdf`;
    const outputPath = path.join('downloads', outputFilename);
    await fs.mkdir('downloads', { recursive: true });

    const mergedPdfBytes = await mergedPdf.save();
    await fs.writeFile(outputPath, mergedPdfBytes);

    res.json({
      success: true,
      fileName: outputFilename,
      downloadUrl: `/downloads/${outputFilename}`,
      message: `Merged ${files.length} PDFs successfully`
    });

  } catch (error) {
    console.error('Merge error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SPLIT ENDPOINT ====================
app.post('/api/split', upload.single('file'), async (req, res) => {
  try {
    const { splitOption, pageRanges, numParts } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const pdfBytes = await fs.readFile(file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();

    const outputFiles = [];

    if (splitOption === 'pages' && pageRanges) {
      // Parse page ranges (e.g., "1-3, 5, 7-10")
      const ranges = pageRanges.split(',').map(r => r.trim());
      
      for (let i = 0; i < ranges.length; i++) {
        const newPdf = await PDFDocument.create();
        const range = ranges[i];
        
        if (range.includes('-')) {
          const [start, end] = range.split('-').map(n => parseInt(n.trim()) - 1);
          for (let p = start; p <= end && p < totalPages; p++) {
            const [copiedPage] = await newPdf.copyPages(pdfDoc, [p]);
            newPdf.addPage(copiedPage);
          }
        } else {
          const pageNum = parseInt(range) - 1;
          if (pageNum < totalPages) {
            const [copiedPage] = await newPdf.copyPages(pdfDoc, [pageNum]);
            newPdf.addPage(copiedPage);
          }
        }
        
        const filename = `split-part${i + 1}-${Date.now()}.pdf`;
        const outputPath = path.join('downloads', filename);
        const pdfBytesOut = await newPdf.save();
        await fs.writeFile(outputPath, pdfBytesOut);
        outputFiles.push(filename);
      }
    } 
    else if (splitOption === 'size' && numParts) {
      const parts = parseInt(numParts);
      const pagesPerPart = Math.ceil(totalPages / parts);
      
      for (let i = 0; i < parts; i++) {
        const newPdf = await PDFDocument.create();
        const startPage = i * pagesPerPart;
        const endPage = Math.min(startPage + pagesPerPart, totalPages);
        
        for (let p = startPage; p < endPage; p++) {
          const [copiedPage] = await newPdf.copyPages(pdfDoc, [p]);
          newPdf.addPage(copiedPage);
        }
        
        const filename = `split-part${i + 1}-${Date.now()}.pdf`;
        const outputPath = path.join('downloads', filename);
        const pdfBytesOut = await newPdf.save();
        await fs.writeFile(outputPath, pdfBytesOut);
        outputFiles.push(filename);
      }
    }

    // Cleanup input file
    await fs.unlink(file.path);

    // Create zip file with all parts
    const zipFilename = `split-files-${Date.now()}.zip`;
    const zipPath = path.join('downloads', zipFilename);
    const output = require('fs').createWriteStream(zipPath);
    const archive = archiver('zip');

    archive.pipe(output);
    for (const filename of outputFiles) {
      archive.file(path.join('downloads', filename), { name: filename });
    }
    await archive.finalize();

    res.json({
      success: true,
      fileName: zipFilename,
      downloadUrl: `/downloads/${zipFilename}`,
      message: `Split into ${outputFiles.length} files`
    });

  } catch (error) {
    console.error('Split error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== COMPRESS ENDPOINT ====================
app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const { compressionLevel } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    const outputFilename = `compressed-${Date.now()}.${ext}`;
    const outputPath = path.join('downloads', outputFilename);

    await fs.mkdir('downloads', { recursive: true });

    let quality;
    switch(compressionLevel) {
      case 'low': quality = 90; break;
      case 'medium': quality = 75; break;
      case 'high': quality = 60; break;
      case 'extreme': quality = 40; break;
      default: quality = 75;
    }

    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      await sharp(file.path)
        .jpeg({ quality: ext === 'jpeg' || ext === 'jpg' ? quality : undefined })
        .png({ quality: ext === 'png' ? quality : undefined })
        .webp({ quality: ext === 'webp' ? quality : undefined })
        .toFile(outputPath);

      const originalSize = (await fs.stat(file.path)).size;
      const compressedSize = (await fs.stat(outputPath)).size;
      const reduction = Math.round((1 - compressedSize / originalSize) * 100);

      await fs.unlink(file.path);

      res.json({
        success: true,
        fileName: outputFilename,
        downloadUrl: `/downloads/${outputFilename}`,
        message: `Compressed with ${compressionLevel} quality`,
        size: `${(originalSize / 1024).toFixed(0)} KB → ${(compressedSize / 1024).toFixed(0)} KB (${reduction}% reduction)`
      });
    } else if (ext === 'pdf') {
      // For PDFs, we can reduce quality by re-rendering
      const pdfBytes = await fs.readFile(file.path);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const compressedBytes = await pdfDoc.save({ useObjectStreams: true });
      
      await fs.writeFile(outputPath, compressedBytes);
      
      const originalSize = (await fs.stat(file.path)).size;
      const compressedSize = compressedBytes.length;
      const reduction = Math.round((1 - compressedSize / originalSize) * 100);

      await fs.unlink(file.path);

      res.json({
        success: true,
        fileName: outputFilename,
        downloadUrl: `/downloads/${outputFilename}`,
        message: `Compressed PDF`,
        size: `${(originalSize / 1024).toFixed(0)} KB → ${(compressedSize / 1024).toFixed(0)} KB (${reduction}% reduction)`
      });
    } else {
      return res.status(400).json({ error: 'Unsupported file format for compression' });
    }

  } catch (error) {
    console.error('Compress error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SECURITY ENDPOINT ====================
app.post('/api/security', upload.single('file'), async (req, res) => {
  try {
    const { securityAction, password, watermarkText } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const pdfBytes = await fs.readFile(file.path);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const outputFilename = `${securityAction}-${Date.now()}.pdf`;
    const outputPath = path.join('downloads', outputFilename);

    if (securityAction === 'encrypt') {
      // Note: pdf-lib doesn't support encryption directly
      // You'd need to use pdf-lib with additional libraries like node-qpdf
      return res.status(400).json({ 
        error: 'PDF encryption requires additional setup with qpdf or similar tools' 
      });
    } else if (securityAction === 'watermark' && watermarkText) {
      const pages = pdfDoc.getPages();
      const { width, height } = pages[0].getSize();
      
      pages.forEach(page => {
        page.drawText(watermarkText, {
          x: width / 2 - 100,
          y: height / 2,
          size: 48,
          opacity: 0.2,
        });
      });

      const watermarkedBytes = await pdfDoc.save();
      await fs.writeFile(outputPath, watermarkedBytes);
    }

    await fs.unlink(file.path);

    res.json({
      success: true,
      fileName: outputFilename,
      downloadUrl: `/downloads/${outputFilename}`,
      message: `${securityAction} applied successfully`
    });

  } catch (error) {
    console.error('Security error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== IMAGE OPERATIONS ENDPOINT ====================
app.post('/api/image', upload.single('file'), async (req, res) => {
  try {
    const { imageOperation, rotationAngle, resizeWidth, resizeHeight } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    const outputFilename = `edited-${Date.now()}.${ext}`;
    const outputPath = path.join('downloads', outputFilename);

    await fs.mkdir('downloads', { recursive: true });

    let sharpInstance = sharp(file.path);

    if (imageOperation === 'rotate') {
      sharpInstance = sharpInstance.rotate(parseInt(rotationAngle));
    } else if (imageOperation === 'resize') {
      sharpInstance = sharpInstance.resize(
        parseInt(resizeWidth), 
        parseInt(resizeHeight)
      );
    } else if (imageOperation === 'crop') {
      sharpInstance = sharpInstance.extract({ 
        left: 100, 
        top: 100, 
        width: parseInt(resizeWidth) || 400, 
        height: parseInt(resizeHeight) || 400 
      });
    } else if (imageOperation === 'filter') {
      sharpInstance = sharpInstance.grayscale();
    }

    await sharpInstance.toFile(outputPath);
    await fs.unlink(file.path);

    res.json({
      success: true,
      fileName: outputFilename,
      downloadUrl: `/downloads/${outputFilename}`,
      message: `Image ${imageOperation}d successfully`
    });

  } catch (error) {
    console.error('Image error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Download files will be available at http://localhost:${PORT}/downloads/`);
});