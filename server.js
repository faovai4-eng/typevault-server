const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
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

app.post("/users/:userId/upload", requireApiKey, upload.single("file"), async (req, res) => {
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

app.get("/users/:userId/files", requireApiKey, async (req, res) => {
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
