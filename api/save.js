// api/save.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { code, files } = req.body;

    if (!code || !files) {
      return res.status(400).json({ error: 'Code and files required' });
    }

    // Qui salveresti su database (es: MongoDB)
    // Per ora simuliamo il salvataggio
    console.log('Saving files with code:', code);
    console.log('Files:', files);

    // Genera URL di download
    const downloadUrl = `https://${req.headers.host}/download/${code}`;

    res.status(200).json({
      success: true,
      message: 'Files saved successfully',
      code: code,
      downloadUrl: downloadUrl,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 ore
      fileCount: files.length
    });

  } catch (error) {
    console.error('Save error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
