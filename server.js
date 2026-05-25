const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT || 8787);
const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
const apiKey = process.env.TYPEVAULT_API_KEY;
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const oauthClientPath = process.env.GOOGLE_OAUTH_CLIENT_PATH;
const oauthTokenPath = process.env.GOOGLE_OAUTH_TOKEN_PATH || path.join(__dirname, "oauth-token.json");
const oauthClientJson = process.env.GOOGLE_OAUTH_CLIENT_JSON;
const oauthTokenJson = process.env.GOOGLE_OAUTH_TOKEN_JSON;
const licenseKeys = (process.env.TYPEVAULT_LICENSE_KEYS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const sessionSecret = process.env.TYPEVAULT_SESSION_SECRET || apiKey || "typevault-dev-session-secret";

if (!rootFolderId) {
  throw new Error("GOOGLE_DRIVE_FOLDER_ID is required.");
}

if (!credentialsPath && !(oauthClientJson && oauthTokenJson)) {
  throw new Error("Either GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_OAUTH_CLIENT_JSON + GOOGLE_OAUTH_TOKEN_JSON is required.");
}

const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: "5mb" }));

function parseJsonText(text) {
  return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
}

function readJsonFile(filePath) {
  return parseJsonText(fs.readFileSync(filePath, "utf8"));
}

function requireApiKey(req, res, next) {
  if (!apiKey) return next();
  const provided = req.header("x-typevault-key") || req.query.key;
  if (provided === apiKey) {
    req.auth = { type: "admin" };
    return next();
  }

  const session = verifySessionToken(req.header("authorization"));
  if (session) {
    req.auth = { type: "session", userId: session.userId, email: session.email };
    return next();
  }

  if (provided !== apiKey) {
    return res.status(401).json({ ok: false, error: "Invalid TypeVault API key." });
  }
  next();
}

function safeName(value) {
  return String(value || "default")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function createSessionToken(email) {
  const payload = {
    email,
    userId: safeName(email),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

function verifySessionToken(header) {
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  if (sign(parts[0]) !== parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function licenseAllowed(email, licenseKey) {
  if (!licenseKeys.length) return false;
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedKey = String(licenseKey || "").trim();
  return licenseKeys.some((entry) => {
    const parts = entry.split(":");
    if (parts.length === 2) {
      return parts[0].trim().toLowerCase() === normalizedEmail && parts[1].trim() === normalizedKey;
    }
    return entry === normalizedKey;
  });
}

function requireMatchingUser(req, res, next) {
  if (req.auth && req.auth.type === "session" && safeName(req.params.userId) !== req.auth.userId) {
    return res.status(403).json({ ok: false, error: "This session cannot access another user's files." });
  }
  next();
}

async function driveClient() {
  if ((oauthClientJson && oauthTokenJson) || (oauthClientPath && fs.existsSync(oauthClientPath) && fs.existsSync(oauthTokenPath))) {
    const clientConfig = oauthClientJson ? parseJsonText(oauthClientJson) : readJsonFile(oauthClientPath);
    const token = oauthTokenJson ? parseJsonText(oauthTokenJson) : readJsonFile(oauthTokenPath);
    const config = clientConfig.installed || clientConfig.web;
    const redirectUri = (config.redirect_uris && config.redirect_uris[0]) || `http://localhost:${port}/oauth2callback`;
    const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, redirectUri);
    oauth2Client.setCredentials(token);
    return google.drive({ version: "v3", auth: oauth2Client });
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });
  return google.drive({ version: "v3", auth });
}

function oauthClientForSetup() {
  if (!oauthClientJson && (!oauthClientPath || !fs.existsSync(oauthClientPath))) {
    throw new Error("GOOGLE_OAUTH_CLIENT_PATH does not exist. Download OAuth client JSON as oauth-client.json first.");
  }
  const clientConfig = oauthClientJson ? parseJsonText(oauthClientJson) : readJsonFile(oauthClientPath);
  const config = clientConfig.installed || clientConfig.web;
  const redirectUri = (config.redirect_uris && config.redirect_uris[0]) || `http://localhost:${port}/oauth2callback`;
  return new google.auth.OAuth2(config.client_id, config.client_secret, redirectUri);
}

async function findChildFolder(drive, parentId, name) {
  const response = await drive.files.list({
    q: [
      `'${parentId}' in parents`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
      `name = '${name.replace(/'/g, "\\'")}'`
    ].join(" and "),
    fields: "files(id, name)",
    spaces: "drive"
  });
  return response.data.files && response.data.files[0];
}

async function ensureFolder(drive, parentId, name) {
  const existing = await findChildFolder(drive, parentId, name);
  if (existing) return existing.id;

  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    },
    fields: "id"
  });
  return response.data.id;
}

async function ensureUserFolder(drive, userId) {
  return ensureFolder(drive, rootFolderId, safeName(userId));
}

async function uploadFileToDrive(drive, parentId, filePath, name, mimeType) {
  const existing = await drive.files.list({
    q: [
      `'${parentId}' in parents`,
      "trashed = false",
      `name = '${name.replace(/'/g, "\\'")}'`
    ].join(" and "),
    fields: "files(id, name)",
    spaces: "drive"
  });

  const media = {
    mimeType: mimeType || "application/octet-stream",
    body: fs.createReadStream(filePath)
  };

  if (existing.data.files && existing.data.files[0]) {
    const fileId = existing.data.files[0].id;
    await drive.files.update({
      fileId,
      media,
      fields: "id, name, modifiedTime"
    });
    return fileId;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId]
    },
    media,
    fields: "id, name, modifiedTime"
  });
  return created.data.id;
}

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    service: "typevault-server",
    driveFolderId: rootFolderId,
    authMode: (oauthClientJson && oauthTokenJson) || (oauthClientPath && fs.existsSync(oauthTokenPath)) ? "oauth" : "service-account"
  });
});

app.post("/auth/license", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const licenseKey = String(req.body.licenseKey || "").trim();
  if (!email || !licenseKey) {
    return res.status(400).json({ ok: false, error: "Email and license key are required." });
  }
  if (!licenseAllowed(email, licenseKey)) {
    return res.status(401).json({ ok: false, error: "Invalid license key." });
  }
  res.json({
    ok: true,
    token: createSessionToken(email),
    userId: safeName(email),
    email
  });
});

app.get("/auth/google", requireApiKey, (req, res) => {
  try {
    const oauth2Client = oauthClientForSetup();
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/drive"]
    });
    res.redirect(url);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing OAuth code.");
    const oauth2Client = oauthClientForSetup();
    const response = await oauth2Client.getToken(code);
    fs.writeFileSync(oauthTokenPath, JSON.stringify(response.tokens, null, 2));
    res.send("TypeVault Google Drive OAuth connected. You can close this tab.");
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get("/drive/check", requireApiKey, async (req, res) => {
  try {
    const drive = await driveClient();
    const folder = await drive.files.get({
      fileId: rootFolderId,
      fields: "id, name, mimeType"
    });
    res.json({ ok: true, folder: folder.data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/users/:userId/upload", requireApiKey, requireMatchingUser, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "Upload field 'file' is required." });
  }

  const userId = safeName(req.params.userId);
  const targetName = safeName(req.body.name || req.file.originalname || "library.bin");
  const folderName = safeName(req.body.folder || "library");

  try {
    const drive = await driveClient();
    const userFolderId = await ensureUserFolder(drive, userId);
    const targetFolderId = await ensureFolder(drive, userFolderId, folderName);
    const fileId = await uploadFileToDrive(
      drive,
      targetFolderId,
      req.file.path,
      targetName,
      req.file.mimetype
    );

    res.json({
      ok: true,
      userId,
      folder: folderName,
      fileId,
      name: targetName
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

app.get("/users/:userId/files", requireApiKey, requireMatchingUser, async (req, res) => {
  try {
    const drive = await driveClient();
    const userFolderId = await ensureUserFolder(drive, safeName(req.params.userId));
    const response = await drive.files.list({
      q: `'${userFolderId}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, modifiedTime, size)",
      spaces: "drive"
    });
    res.json({ ok: true, files: response.data.files || [] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/files/:fileId/download", requireApiKey, async (req, res) => {
  try {
    const drive = await driveClient();
    const metadata = await drive.files.get({
      fileId: req.params.fileId,
      fields: "name, mimeType"
    });
    const response = await drive.files.get(
      { fileId: req.params.fileId, alt: "media" },
      { responseType: "stream" }
    );

    res.setHeader("Content-Type", metadata.data.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${metadata.data.name}"`);
    response.data.pipe(res);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`TypeVault server running at http://localhost:${port}`);
});
