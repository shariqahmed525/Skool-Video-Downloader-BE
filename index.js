import express from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Skool Video Downloader Backend is running!' });
});

app.get('/', (req, res) => {
  res.send('Skool Video Downloader Backend is running!');
});

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
  // Headers needed to bypass access restrictions
  headers: {
    'Referer': 'https://www.skool.com/',
    'Origin': 'https://www.skool.com',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
  },
  
  // Directory where the final video will be saved
  outputDir: path.join(os.homedir(), 'Downloads')
};

// ==========================================
// UTILITIES
// ==========================================
async function fetchPlaylist(url) {
  const res = await fetch(url, { headers: CONFIG.headers });
  if (!res.ok) {
    throw new Error(`HTTP Error! Status: ${res.status} for URL: ${url}`);
  }
  return res.text();
}

function resolveUrl(baseUrl, relativeUrl) {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch (e) {
    return relativeUrl;
  }
}

function parseMasterPlaylist(masterText, baseUrl) {
  const lines = masterText.split('\n');
  let videoUrl = null;
  let audioUrl = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Find Audio Stream
    if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO') && !audioUrl) {
      const match = line.match(/URI="([^"]+)"/);
      if (match && match[1]) {
        audioUrl = resolveUrl(baseUrl, match[1]);
      }
    }
    
    // Find Best Video Stream (assumes the first one is highest quality)
    if (line.startsWith('#EXT-X-STREAM-INF') && !videoUrl) {
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith('#'))) {
        j++;
      }
      if (j < lines.length) {
        videoUrl = resolveUrl(baseUrl, lines[j].trim());
      }
    }
  }

  return { videoUrl, audioUrl };
}

function mergeWithFFmpeg(videoUrl, audioUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-headers', `Referer: ${CONFIG.headers.Referer}\r\n`,
      '-i', videoUrl
    ];

    if (audioUrl) {
      ffmpegArgs.push(
        '-headers', `Referer: ${CONFIG.headers.Referer}\r\n`,
        '-i', audioUrl
      );
    }

    // Direct copy without re-encoding to temp file
    ffmpegArgs.push('-c', 'copy', '-y', outputPath);

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpegProcess.on('error', (err) => {
      reject(err);
    });
  });
}

// ==========================================
// ROUTES
// ==========================================
app.post('/download', async (req, res) => {
  try {
    const { playbackId, token, title } = req.body;

    if (!playbackId || !token) {
      return res.status(400).json({ error: "Missing playbackId or token" });
    }

    const masterUrl = `https://stream.video.skool.com/${playbackId}.m3u8?token=${token}`;
    
    let safeName = title || playbackId;
    safeName = safeName.replace(/[^a-z0-9_-]/gi, '_');
    const fileName = safeName.endsWith('.mp4') ? safeName : `${safeName}.mp4`;
      
    // Save to OS temp directory to avoid cluttering local project
    const finalFile = path.join(os.tmpdir(), fileName);

    console.log(`\n📥 Fetching master playlist for: ${safeName}...`);
    const masterText = await fetchPlaylist(masterUrl);
    const { videoUrl, audioUrl } = parseMasterPlaylist(masterText, masterUrl);

    if (!videoUrl) {
      return res.status(500).json({ error: "Could not find a valid video stream in the master playlist." });
    }

    console.log(`🎬 Target output: ${finalFile}`);
    console.log("🚀 Instructing FFmpeg to download and merge...");

    // Wait for FFmpeg to finish processing completely
    await mergeWithFFmpeg(videoUrl, audioUrl, finalFile);
    console.log(`\n✅ Success! Video processed completely: ${fileName}`);

    // Return success to frontend so it can stop the loader and trigger the browser download
    res.status(200).json({ 
      success: true, 
      fileName: fileName
    });

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/serve-file', (req, res) => {
  const { fileName } = req.query;
  if (!fileName) {
    return res.status(400).json({ error: "Missing fileName" });
  }

  const filePath = path.join(os.tmpdir(), fileName);
  res.download(filePath, fileName, (err) => {
    if (err) {
      console.error(`Error serving file ${fileName}:`, err.message);
    } else {
      console.log(`Served file to browser: ${fileName}`);
      // Delete the file after serving to save space
      try {
        fs.unlinkSync(filePath);
        console.log(`Successfully deleted temp file: ${filePath}`);
      } catch (unlinkErr) {
        console.error(`Failed to delete temp file ${filePath}:`, unlinkErr.message);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend server listening on port ${PORT}`);
});
