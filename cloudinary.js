const cloudinary = require('cloudinary').v2;
const multer = require('multer');
require('dotenv').config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

// NOTE: Pehle multer-storage-cloudinary (direct streaming upload) use hota tha.
// Render free plan par Cloudinary me streaming upload hang/crash karke 502 Bad
// Gateway deta tha (bina image ke ticket ban jata tha, image ke sath 502).
// Isliye ab memoryStorage + explicit upload_stream use karo taaki koi bhi
// Cloudinary failure clean JSON error de, process crash / proxy timeout na ho.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp|jpg)$/.test(file.mimetype) || file.mimetype === "application/pdf") return cb(null, true);
    cb(new Error("Only JPG, PNG, GIF, WEBP or PDF allowed (max 5MB). NOTE: iPhone HEIC photos are NOT supported - please send as JPG/screenshot."));
  },
});

// Buffer ko Cloudinary par upload karo (25s timeout taaki Render proxy 502 na de)
function uploadBufferToCloudinary(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!cloudinaryConfigured()) {
      return reject(new Error("Image service not configured on server (Cloudinary keys missing). Ticket without image create karo ya admin se contact karo."));
    }
    if (!buffer || !buffer.length) {
      return reject(new Error("Empty image file received."));
    }
    const timer = setTimeout(() => {
      reject(new Error("Image upload timed out (25s). Please retry with a smaller image below 2MB."));
    }, 25000);
    // upload_stream ka callback kabhi-kabhi double-fire hota hai, guard lagao
    let settled = false;
    const done = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };
    try {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "employee_documents", resource_type: "auto", timeout: 60000, ...opts },
        done
      );
      stream.on("error", done);
      stream.end(buffer);
    } catch (e) {
      done(e);
    }
  });
}

// Multer errors ko JSON 400 me badlo (warna Express default HTML/502 deta hai)
const handleUpload = (singleParser) => (req, res, next) => {
  singleParser(req, res, (err) => {
    if (err) {
      console.error(`[Upload] ${req.method} ${req.path}:`, err.message);
      const msg = err.code === "LIMIT_FILE_SIZE"
        ? "Image too large (max 5MB). Please compress below 2MB and retry."
        : err.code === "LIMIT_FILE_COUNT"
        ? "Too many files attached."
        : err.code === "LIMIT_UNEXPECTED_FILE"
        ? `Unexpected file field (${err.field || "unknown"}). Please attach as "IssuePhoto" only.`
        : err.message || "Image upload failed";
      return res.status(400).json({ error: msg });
    }
    next();
  });
};

const parser = upload;

module.exports = { cloudinary, parser, upload, handleUpload, uploadBufferToCloudinary, cloudinaryConfigured };