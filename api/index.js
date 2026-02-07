
// api/index.js - SERVER PRINCIPALE
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();

// Configurazione
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(express.static('.')); // Servi file statici

// Connessione MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/filedrop';
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ MongoDB connesso');
}).catch(err => {
  console.log('⚠️  MongoDB non disponibile, usando memoria:', err.message);
});

// Modello per i file (usa memoria se MongoDB non disponibile)
let FileModel;
try {
  const FileSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    files: [{
      originalName: String,
      filename: String,
      path: String,
      size: Number,
      mimetype: String,
      uploadDate: { type: Date, default: Date.now }
    }],
    downloadUrl: String,
    expiresAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    createdAt: { type: Date, default: Date.now }
  });
  FileModel = mongoose.model('File', FileSchema);
} catch (e) {
  console.log('Usando storage in memoria');
  FileModel = null;
}

// Storage in memoria come fallback
const memoryStorage = {};

// Configurazione Multer per upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueCode = req.query.code || generateCode();
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueCode}_${timestamp}_${random}_${safeName}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB
});

// Genera codice unico (6 caratteri)
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Rimuove caratteri ambigui
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// API ROUTES

// 1. Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// 2. Crea nuova sessione con QR code
app.get('/api/create', async (req, res) => {
  try {
    const code = generateCode();
    const baseUrl = req.protocol + '://' + req.get('host');
    const downloadUrl = `${baseUrl}/#${code}`; // Usa hash per frontend
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(baseUrl + '/upload.html?code=' + code)}`;
    
    // Salva sessione
    const sessionData = {
      code,
      files: [],
      downloadUrl,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 ore
      createdAt: new Date()
    };
    
    if (FileModel) {
      await FileModel.create(sessionData);
    } else {
      memoryStorage[code] = sessionData;
    }
    
    res.json({
      success: true,
      code: code,
      downloadUrl: downloadUrl,
      qrCodeUrl: qrCodeUrl,
      uploadUrl: `${baseUrl}/api/upload?code=${code}`,
      statusUrl: `${baseUrl}/api/status/${code}`,
      message: 'Scan QR code with phone to upload files'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Upload file (da mobile o PC)
app.post('/api/upload', upload.array('files'), async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).json({ error: 'Codice richiesto. Genera un QR code prima.' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nessun file selezionato' });
    }

    const files = req.files.map(file => ({
      originalName: file.originalname,
      filename: file.filename,
      path: file.path,
      size: file.size,
      mimetype: file.mimetype,
      url: `/uploads/${file.filename}`,
      uploadDate: new Date()
    }));

    // Salva nel database
    if (FileModel) {
      let fileRecord = await FileModel.findOne({ code });
      if (!fileRecord) {
        fileRecord = new FileModel({ 
          code, 
          files: [],
          downloadUrl: `${req.protocol}://${req.get('host')}/#${code}`
        });
      }
      fileRecord.files.push(...files);
      await fileRecord.save();
    } else {
      // Usa memoria
      if (!memoryStorage[code]) {
        memoryStorage[code] = {
          code,
          files: [],
          downloadUrl: `${req.protocol}://${req.get('host')}/#${code}`
        };
      }
      memoryStorage[code].files.push(...files);
    }

    res.json({
      success: true,
      message: `Caricati ${files.length} file`,
      files: files.map(f => ({
        name: f.originalName,
        size: f.size,
        url: f.url
      })),
      code: code,
      totalFiles: files.length
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Errore durante il caricamento' });
  }
});

// 4. Controlla file disponibili (polling)
app.get('/api/status/:code', async (req, res) => {
  try {
    let files = [];
    
    if (FileModel) {
      const fileRecord = await FileModel.findOne({ code: req.params.code });
      if (fileRecord) files = fileRecord.files;
    } else if (memoryStorage[req.params.code]) {
      files = memoryStorage[req.params.code].files;
    }
    
    res.json({
      exists: files.length > 0,
      files: files.map(f => ({
        name: f.originalName,
        size: formatBytes(f.size),
        url: f.url || `/uploads/${f.filename}`,
        uploaded: f.uploadDate || new Date()
      })),
      totalFiles: files.length,
      code: req.params.code
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Download diretto
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(__dirname, '../uploads', req.params.filename);
  
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'File non trovato' });
  }
});

// 6. Pagina upload per mobile
app.get('/upload.html', (req, res) => {
  const code = req.query.code;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Upload File - FileDrop</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; text-align: center; }
        input { margin: 20px 0; padding: 10px; }
        button { background: #667eea; color: white; border: none; padding: 12px 30px; border-radius: 5px; font-size: 16px; }
        .progress { margin: 20px 0; }
      </style>
    </head>
    <body>
      <h2>📱 Upload File</h2>
      <p>Code: <strong>${code || 'N/A'}</strong></p>
      <input type="file" id="fileInput" multiple>
      <button onclick="uploadFiles()">Upload File</button>
      <div id="progress" class="progress"></div>
      <script>
        async function uploadFiles() {
          const files = document.getElementById('fileInput').files;
          if (files.length === 0) return alert('Seleziona file');
          
          const formData = new FormData();
          for (let file of files) formData.append('files', file);
          
          const response = await fetch('/api/upload?code=${code}', {
            method: 'POST',
            body: formData
          });
          
          const result = await response.json();
          if (result.success) {
            document.getElementById('progress').innerHTML = 
              '<p style="color: green;">✅ ' + result.message + '</p>' +
              '<p>Torna al PC per scaricare i file</p>';
          } else {
            document.getElementById('progress').innerHTML = 
              '<p style="color: red;">❌ ' + (result.error || 'Errore') + '</p>';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Helper function
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Upload directory: ${path.join(__dirname, '../uploads')}`);
});
